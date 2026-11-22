import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import {
  createControlFrame,
  decodeControlFrame,
  MAX_CONTROL_FRAME_BYTES,
  MAX_RELAY_FRAME_BYTES,
  SERVER_SHUTDOWN_CLOSE_CODE,
  SERVER_SHUTDOWN_CLOSE_REASON,
  type ControlFrame,
  type HelloPayload,
  type ConnectRequestPayload,
  type SecureHandshakePayload,
  type RelayPayload,
  type TransportSelectedPayload,
} from '@dsh-remote/protocol'
import { ApiError, Store } from './store.js'
import { Logger, type LogLevel } from './logger.js'
import { normalizeGatewayOptions, normalizeMaxFramesPerSec, type GatewayTimingOptions } from './config.js'

export interface GatewayOptions extends GatewayTimingOptions {
  maxFramesPerSec?: number
  logLevel?: LogLevel
  logger?: Logger
  /** Advertise `transport.turn` (and accept TURN credential requests). */
  turnEnabled?: boolean
  /**
   * Resolve the client address used for the half-open budget.
   *
   * Behind a reverse proxy every socket peer is the proxy, so counting per
   * `remoteAddress` would put all users in one bucket. `server.ts` supplies the
   * same trusted-proxy-aware resolver the HTTP rate limiter uses. Returning
   * `undefined` falls back to the socket peer.
   */
  clientAddress?: (req: import('node:http').IncomingMessage) => string | undefined
}

/**
 * Connection lifecycle. Frames are only ever interpreted in `awaiting_hello`
 * or `authenticated`; `closing`/`closed` exists so a hello that loses the race
 * against the handshake deadline can never authenticate, register a peer,
 * touch the store or replace a healthy socket.
 */
type ConnectionState = 'awaiting_hello' | 'authenticated' | 'closing' | 'closed'

type Peer = {
  /** Connection-level key: Host uses its deviceId, Client uses a fresh uuid per control connection. */
  key: string
  ws: WebSocket
  /** Device identity. A Client device may own several control connections. */
  id: string
  role: 'host' | 'client'
  capabilities: string[]
  version: string
  lastPong: number
  nonce?: string
  evictedTombstoneUntil?: number
}
type Link = {
  id: string
  /** Connection-level keys, not device IDs: one Client device may own several control connections. */
  host: string
  hostDeviceId: string
  client: string
  clientDeviceId: string
  stage: 'pending' | 'accepted' | 'handshake' | 'ready'
  created: number
  counters: Map<string, number>
  preferredTransports: TransportName[]
  iceCandidates: number
}
type DroppedLink = { host: string; client: string; expiresAt: number; droppedFrames: number }

/** Keep tombstones long enough for late in-flight frames to drain without CONNECTION_NOT_FOUND storms. */
const DROPPED_LINK_TTL_MS = 300_000
const MAX_DROPPED_LINKS_PER_HOST = 64
const MAX_DROPPED_LINKS = 16_384

/** Protocol v1 default: at most 256 ICE candidates per logical connection. */
export const MAX_ICE_CANDIDATES_PER_CONNECTION = 256
/**
 * Caps on *authenticated* control connections. Unauthenticated sockets have
 * their own, much smaller budget (`PENDING_*`) so an attacker who never sends
 * `hello` cannot occupy the slots real devices need.
 */
export const MAX_AUTHENTICATED_CONNECTIONS = 256
/**
 * One address may hold this many half-open handshakes at once. Sized for a
 * shared NAT (an office or a household with several devices) while still
 * forcing an attacker to control many distinct addresses before the global
 * pending ceiling becomes reachable.
 */
export const MAX_PENDING_PER_ADDRESS = 16
/** Global ceiling for half-open handshakes, independent of the auth cap. */
export const MAX_PENDING_CONNECTIONS = 256
/** Half-open sockets older than their hello deadline are swept even if the timer was lost. */
const PENDING_SWEEP_MS = 5_000
/** Mirrors docs/protocol.md: Clients use max(server, local) and default to 12 s. */
/** Global cap on concurrent logical links; each one holds two authenticated devices. */
const MAX_LINKS = 4096
const WEBRTC_FALLBACK_TIMEOUT_MS = 12_000
const SUPPORTED_TRANSPORTS = ['transport.lan', 'transport.p2p', 'transport.turn', 'transport.relay'] as const
const TRANSPORT_NAMES = ['lan', 'p2p', 'turn', 'relay'] as const
type TransportName = (typeof TRANSPORT_NAMES)[number]

function modernHost(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(version)
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return major! > 0 || (minor! > 2 || (minor === 2 && patch! >= 15))
}

const SAFE_TEXT = /^[A-Za-z0-9_.:-]+$/
const SAFE_PATH = /^[A-Za-z0-9/._~-]*$/
const SAFE_ADDRESS = /^[0-9a-fA-F:.]{2,45}$/
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,32}$/

/** Diagnostics must never echo client-supplied text verbatim. */
function safeText(value: unknown, max = 64): string | undefined {
  return typeof value === 'string' && SAFE_TEXT.test(value) ? value.slice(0, max) : undefined
}

/** Parse the upgrade request path, dropping the query string (it may carry a token). */
function requestPath(rawUrl: string | undefined): string {
  if (typeof rawUrl !== 'string' || rawUrl === '') return ''
  const end = rawUrl.search(/[?#]/)
  const path = end === -1 ? rawUrl : rawUrl.slice(0, end)
  return SAFE_PATH.test(path) ? path.slice(0, 64) : '<invalid>'
}

function socketAddress(socket: unknown): string | undefined {
  try {
    const address = (socket as { remoteAddress?: unknown } | null)?.remoteAddress
    return typeof address === 'string' && SAFE_ADDRESS.test(address) ? address : undefined
  } catch {
    return undefined
  }
}

function errorName(error: unknown): string {
  try {
    const name = error instanceof Error ? error.name : undefined
    return typeof name === 'string' && SAFE_ERROR_NAME.test(name) ? name : 'Error'
  } catch {
    return 'Error'
  }
}

function errorCode(error: unknown): string | undefined {
  try {
    const code = (error as { code?: unknown } | null | undefined)?.code
    return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

export class Gateway {
  /** Connection-level peers. A Client device may appear under several keys. */
  readonly peers = new Map<string, Peer>()
  private byDevice = new Map<string, Set<string>>()
  private hostOf = new Map<string, string>()
  private links = new Map<string, Link>()
  private droppedLinks = new Map<string, DroppedLink>()
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_RELAY_FRAME_BYTES, perMessageDeflate: false })
  /**
   * Sockets that have not finished `hello` yet, keyed per source address.
   *
   * These are counted separately from `wss.clients`: the authenticate cap must
   * not be consumable by an unauthenticated peer. A single attacker opening 256
   * idle sockets used to make every real device's upgrade fail with 403, so
   * unauthenticated connections get their own small budget per address and a
   * much smaller global ceiling.
   */
  /**
   * Half-open sockets in arrival order, so an over-budget upgrade can evict the
   * oldest idle handshake instead of rejecting the newcomer. That direction
   * matters: a reconnect after a network blip must always get in, even while an
   * attacker holds idle sockets open from the same NAT address.
   */
  private pendingOrder = new Map<WebSocket, { address: string; since: number }>()
  /** Sockets counted against the authenticated cap. */
  private authenticatedSockets = 0
  private heartbeat: ReturnType<typeof setInterval>
  private sweep: ReturnType<typeof setInterval>
  private closed = false
  readonly turnEnabled: boolean
  private readonly clientAddress?: (req: import('node:http').IncomingMessage) => string | undefined
  readonly helloTimeoutMs: number
  readonly heartbeatIntervalMs: number
  readonly heartbeatDisconnectMs: number
  readonly forceTerminateGraceMs: number
  readonly maxFramesPerSec: number
  readonly logger: Logger

  constructor(server: Server, private store: Store, origin: string, options: GatewayOptions = {}) {
    // One normalization path for CLI and programmatic callers: NaN, Infinity,
    // negatives and out-of-range values degrade to documented defaults instead
    // of becoming 1ms timers.
    const timing = normalizeGatewayOptions(options)
    this.helloTimeoutMs = timing.helloTimeoutMs
    this.heartbeatIntervalMs = timing.heartbeatIntervalMs
    this.heartbeatDisconnectMs = timing.heartbeatDisconnectMs
    this.forceTerminateGraceMs = timing.forceTerminateGraceMs
    this.maxFramesPerSec = normalizeMaxFramesPerSec(options.maxFramesPerSec)
    this.logger = options.logger ?? new Logger('gateway', options.logLevel ?? 'info')
    this.turnEnabled = options.turnEnabled === true
    this.clientAddress = options.clientAddress

    store.onInvalidate = id => this.disconnectDevice(id, 'AUTH_INVALID')
    server.on('upgrade', (req, socket, head) => {
      const path = requestPath(req.url)
      // The route still requires an exact match: a query string is rejected
      // (exactly as before) but only its parsed pathname is ever logged.
      const pathRejected = req.url !== '/ws/v1/connect'
      const originRejected = Boolean(req.headers.origin) && req.headers.origin !== origin
      // Behind Caddy every peer is the proxy; use the trusted-proxy-aware
      // resolver so the budget is per real client, not one shared bucket.
      let address = 'unknown'
      try { address = this.clientAddress?.(req) ?? socketAddress(socket) ?? 'unknown' } catch { address = 'unknown' }
      // Over-budget half-open sockets are evicted, not refused: the newest
      // attempt always wins so a real reconnect is never locked out.
      if (this.pendingCountFor(address) >= MAX_PENDING_PER_ADDRESS) {
        this.evictOldestPending(address)
      }
      if (this.pendingOrder.size >= MAX_PENDING_CONNECTIONS) {
        this.evictOldestPending(address)
      }
      // The authenticated cap is only consumed by sockets that actually
      // authenticated; idle half-open sockets have their own budget above.
      const authenticatedRejected = this.authenticatedSockets >= MAX_AUTHENTICATED_CONNECTIONS
      if (pathRejected || originRejected || authenticatedRejected) {
        this.logger.warn('ws_upgrade_rejected', {
          // Parsed pathname only: the raw URL may carry credentials in its query.
          path: path === '' ? 'unknown' : path,
          reason: pathRejected
            ? 'invalid_url'
            : originRejected
              ? 'origin_mismatch'
              : 'connection_limit_reached',
          clientCount: this.authenticatedSockets,
          pendingCount: this.pendingOrder.size,
          hasOrigin: Boolean(req.headers.origin),
          remoteAddress: address === 'unknown' ? undefined : address,
        })
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
      this.wss.handleUpgrade(req, socket, head, ws => {
        this.pendingOrder.set(ws, { address, since: Date.now() })
        this.accept(ws, address, () => this.releasePending(ws))
      })
    })
    this.heartbeat = setInterval(() => {
      if (this.closed) return
      for (const peer of this.peers.values()) {
        peer.nonce = randomUUID()
        this.send(peer, createControlFrame('ping', { nonce: peer.nonce }))
      }
    }, this.heartbeatIntervalMs)
    this.heartbeat.unref()
    // Timeout checks must not inherit the heartbeat cadence: with a 10s ping
    // interval and a 20s threshold, scanning once per interval can miss a dead
    // peer for almost 30s. Sweep independently so clients see offline within
    // the 30s product bound.
    this.sweep = setInterval(() => {
      if (this.closed) return
      const now = Date.now()
      for (const peer of this.peers.values()) {
        if (now - peer.lastPong <= this.heartbeatDisconnectMs) continue
        this.logger.warn('ws_heartbeat_timeout', {
          peerId: peer.id,
          role: peer.role,
          lastPong: peer.lastPong,
          elapsedMs: now - peer.lastPong,
          thresholdMs: this.heartbeatDisconnectMs,
        })
        this.disconnectPeer(peer.key, 'CONNECTION_FAILED')
      }
      for (const link of this.links.values()) {
        if (link.stage !== 'ready' && now - link.created > 30_000) this.drop(link, 'CONNECTION_FAILED')
      }
      this.pruneDroppedLinks(now)
    }, 2_000)
    this.sweep.unref()
  }

  private addPeer(peer: Peer): void {
    this.peers.set(peer.key, peer)
    const keys = this.byDevice.get(peer.id) ?? new Set<string>()
    keys.add(peer.key)
    this.byDevice.set(peer.id, keys)
    if (peer.role === 'host') this.hostOf.set(peer.id, peer.key)
  }

  /**
   * Drop one half-open socket from the unauthenticated budget.
   */
  private releasePending(ws: WebSocket): void {
    this.pendingOrder.delete(ws)
  }

  /** How many half-open handshakes one address currently holds. */
  private pendingCountFor(address: string): number {
    let count = 0
    for (const entry of this.pendingOrder.values()) if (entry.address === address) count += 1
    return count
  }

  /**
   * Evict the oldest half-open socket holding a slot. Called before admitting a
   * newcomer that would exceed the budget, so a legitimate reconnect is never
   * locked out by idle sockets — including ones from its own NAT address.
   */
  private evictOldestPending(address: string): boolean {
    const sameAddress = this.pendingCountFor(address) > 0
    let victim: WebSocket | undefined
    let oldest = Number.POSITIVE_INFINITY
    for (const [ws, entry] of this.pendingOrder) {
      // Prefer evicting from the offending address, then globally oldest.
      const candidateSince = sameAddress && entry.address !== address
        ? entry.since + 1e12
        : entry.since
      if (candidateSince < oldest) { oldest = candidateSince; victim = ws }
    }
    if (victim === undefined) return false
    this.pendingOrder.delete(victim)
    try { victim.close(4009, 'PENDING_EVICTED') } catch { try { victim.terminate() } catch { /* already gone */ } }
    const timer = setTimeout(() => { try { victim!.terminate() } catch { /* gone */ } }, this.forceTerminateGraceMs)
    timer.unref()
    return true
  }

  private removePeer(peer: Peer): void {
    this.peers.delete(peer.key)
    const keys = this.byDevice.get(peer.id)
    if (keys !== undefined) {
      keys.delete(peer.key)
      if (keys.size === 0) this.byDevice.delete(peer.id)
    }
    if (peer.role === 'host' && this.hostOf.get(peer.id) === peer.key) this.hostOf.delete(peer.id)
  }

  /** A device is online while at least one of its control connections is alive. */
  isOnline(deviceId: string): boolean {
    return (this.byDevice.get(deviceId)?.size ?? 0) > 0
  }

  connectedDeviceCount(): number {
    return this.byDevice.size
  }

  private pruneDroppedLinks(now: number): void {
    for (const [id, entry] of this.droppedLinks) {
      if (entry.expiresAt <= now) this.droppedLinks.delete(id)
    }
  }

  private evictDroppedLink(id: string, entry: DroppedLink, now: number): void {
    this.droppedLinks.delete(id)
    if (entry.expiresAt <= now) return
    for (const peerId of [entry.host, entry.client]) {
      const p = this.peers.get(peerId)
      if (p) p.evictedTombstoneUntil = Math.max(p.evictedTombstoneUntil ?? 0, entry.expiresAt)
    }
  }

  private recordDroppedLink(link: Link): void {
    const now = Date.now()
    this.pruneDroppedLinks(now)
    this.droppedLinks.delete(link.id)
    let hostCount = 0
    let oldestForHost: [string, DroppedLink] | undefined
    for (const [id, entry] of this.droppedLinks) {
      if (entry.host === link.host) {
        if (oldestForHost === undefined) oldestForHost = [id, entry]
        hostCount += 1
      }
    }
    if (hostCount >= MAX_DROPPED_LINKS_PER_HOST && oldestForHost !== undefined) {
      this.evictDroppedLink(oldestForHost[0], oldestForHost[1], now)
    }
    while (this.droppedLinks.size >= MAX_DROPPED_LINKS) {
      const oldest = this.droppedLinks.entries().next().value as [string, DroppedLink] | undefined
      if (oldest === undefined) break
      this.evictDroppedLink(oldest[0], oldest[1], now)
    }
    this.droppedLinks.set(link.id, {
      host: link.host,
      client: link.client,
      expiresAt: now + DROPPED_LINK_TTL_MS,
      droppedFrames: 0,
    })
  }

  private isDroppedLinkFrame(peer: Peer, frame: ControlFrame): boolean {
    if (frame.type === 'ping' || frame.type === 'pong' || frame.type === 'connect.request') return false
    const p = frame.payload as Record<string, unknown>
    const id = p.connectionId
    if (typeof id !== 'string' || this.links.has(id)) return false
    const now = Date.now()
    const dropped = this.droppedLinks.get(id)
    if (!dropped) {
      return peer.evictedTombstoneUntil !== undefined && now < peer.evictedTombstoneUntil
    }
    if (dropped.expiresAt <= now) {
      this.droppedLinks.delete(id)
      return false
    }
    if (peer.key !== dropped.host && peer.key !== dropped.client) return false
    dropped.droppedFrames += 1
    if (dropped.droppedFrames === 1) {
      this.logger.debug('ws_stale_link_frames_dropped', {
        peerId: peer.id,
        role: peer.role,
        connectionId: safeText(id),
      })
    }
    return true
  }

  droppedLinkFrameCount(connectionId: string): number {
    return this.droppedLinks.get(connectionId)?.droppedFrames ?? 0
  }

  private send(peer: Peer, frame: ControlFrame): void {
    if (peer.ws.readyState !== WebSocket.OPEN) return
    if (peer.ws.bufferedAmount > 4 * MAX_RELAY_FRAME_BYTES) { this.disconnectPeer(peer.key, 'SLOW_CONSUMER'); return }
    peer.ws.send(JSON.stringify(frame))
  }
  private drop(link: Link, code: string): void {
    this.links.delete(link.id)
    this.recordDroppedLink(link)
    for (const id of [link.host, link.client]) {
      const p = this.peers.get(id)
      if (p && (p.role === 'client' || modernHost(p.version))) this.send(p, createControlFrame('error', { code, message: code, connectionId: link.id, retryable: true }))
    }
  }
  /** Drop every control connection owned by one device (revoke, invalidate). */
  disconnectDevice(deviceId: string, code: string): void {
    for (const key of [...(this.byDevice.get(deviceId) ?? [])]) this.disconnectPeer(key, code)
  }

  private disconnectPeer(key: string, code: string): void {
    const peer = this.peers.get(key)
    if (peer !== undefined) this.removePeer(peer)
    for (const link of this.links.values()) if (link.host === key || link.client === key) this.drop(link, code)
    if (!peer) return
    this.logger.info('ws_peer_disconnected', { peerId: peer.id, role: peer.role, connectionKey: key, code })
    try {
      peer.ws.close(code === 'CONNECTION_REPLACED' ? 4003 : 4001, code)
    } catch {
      // Socket already closing: the grace below still forces termination.
    }
    const timer = setTimeout(() => {
      if (peer.ws.readyState !== WebSocket.CLOSED) peer.ws.terminate()
    }, this.forceTerminateGraceMs)
    timer.unref()
  }

  /**
   * Authorize a REST `/api/v1/turn/credentials` request. Only the two devices
   * of an active logical connection may obtain credentials, and only while
   * that connection is still being established.
   */
  authorizeIce(deviceId: string, connectionId: string): boolean {
    const link = this.links.get(connectionId)
    if (link === undefined) return false
    if (link.hostDeviceId !== deviceId && link.clientDeviceId !== deviceId) return false
    if (link.stage !== 'accepted' && link.stage !== 'handshake') return false
    return this.peers.has(link.host) && this.peers.has(link.client)
  }
  private supportedCapabilities(): string[] {
    return SUPPORTED_TRANSPORTS.filter(capability => capability !== 'transport.turn' || this.turnEnabled)
  }
  private negotiatedCapabilities(offered: readonly string[]): string[] {
    return this.supportedCapabilities().filter(capability => offered.includes(capability))
  }

  /**
   * @param onSettled Called exactly once when this socket either authenticates
   *   or goes away. Releases the half-open budget so one address can never
   *   starve another.
   */
  private accept(ws: WebSocket, address: string, onSettled: () => void): void {
    let state: ConnectionState = 'awaiting_hello'
    let peer: Peer | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    /** Guard so the pending budget is released exactly once per socket. */
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      onSettled()
    }
    /** Move this socket from the half-open budget into the authenticated one. */
    const authenticate = (): void => {
      settle()
      this.authenticatedSockets += 1
    }
    /** Give back an authenticated slot (only after `authenticate` ran). */
    let counted = false
    const releaseAuthenticated = (): void => {
      if (!counted) return
      counted = false
      if (this.authenticatedSockets > 0) this.authenticatedSockets -= 1
    }
    const markAuthenticated = (): void => {
      authenticate()
      counted = true
    }

    // Timer cleanup is idempotent: every path (auth, timeout, close) can call
    // it any number of times without leaving a scheduled callback behind.
    const clearDeadline = (): void => {
      if (deadline === undefined) return
      clearTimeout(deadline)
      deadline = undefined
    }
    const clearGrace = (): void => {
      if (graceTimer === undefined) return
      clearTimeout(graceTimer)
      graceTimer = undefined
    }
    const terminateSoon = (target: WebSocket): void => {
      clearGrace()
      graceTimer = setTimeout(() => {
        graceTimer = undefined
        if (target.readyState !== WebSocket.CLOSED) target.terminate()
      }, this.forceTerminateGraceMs)
      graceTimer.unref()
    }

    this.logger.debug('ws_connection_accepted', { clientCount: this.authenticatedSockets })

    deadline = setTimeout(() => {
      deadline = undefined
      if (state !== 'awaiting_hello') return
      // Close the door before closing the socket: any hello still in flight is
      // then discarded by the frame guard instead of authenticating late.
      state = 'closing'
      // The handshake deadline ends the half-open phase even if `close` is slow.
      settle()
      this.logger.warn('ws_hello_timeout', { timeoutMs: this.helloTimeoutMs, readyState: ws.readyState })
      if (ws.readyState === WebSocket.OPEN) {
        try {
          const frame = createControlFrame('error', {
            code: 'HELLO_TIMEOUT',
            message: `Hello handshake timed out after ${this.helloTimeoutMs}ms`,
            retryable: true,
          })
          ws.send(JSON.stringify(frame))
        } catch (error) {
          this.logger.warn('ws_hello_timeout_send_failed', { errorName: errorName(error) })
        }
      }
      try {
        ws.close(4001, 'CONNECTION_FAILED')
      } catch {
        // ws might not be closable in some edge states; the grace below terminates it.
      }
      terminateSoon(ws)
    }, this.helloTimeoutMs)
    deadline.unref()

    let windowStart = Date.now(), frames = 0, bytes = 0, droppedFrames = 0, droppedBytes = 0
    ws.on('error', (error) => {
      // Error messages can embed payload fragments: log the class and errno only.
      this.logger.warn('ws_socket_error', {
        peerId: peer?.id,
        errorName: errorName(error),
        errorCode: errorCode(error),
      })
    })
    ws.on('close', (code, reason) => {
      state = 'closed'
      clearDeadline()
      clearGrace()
      // A socket that never authenticated must give its half-open slot back.
      settle()
      releaseAuthenticated()
      this.logger.info('ws_connection_closed', {
        ...(peer ? { peerId: peer.id, role: peer.role } : {}),
        code,
        // The close reason is arbitrary client text: report only its presence.
        hasReason: Buffer.isBuffer(reason) ? reason.length > 0 : false,
      })
      if (peer && this.peers.get(peer.key) === peer) this.disconnectPeer(peer.key, 'CONNECTION_FAILED')
    })
    ws.on('message', (raw, binary) => {
      // Frames arriving after the handshake deadline are dropped before any
      // parsing, authentication or store access can happen.
      if (state !== 'awaiting_hello' && state !== 'authenticated') return
      if (ws.readyState !== WebSocket.OPEN) return
      let frame: ControlFrame | undefined
      try {
        if (binary) throw new ApiError('INVALID_MESSAGE')
        const text = raw.toString()
        const frameBytes = Buffer.byteLength(text)
        if (Date.now() - windowStart >= 1000) {
          windowStart = Date.now()
          frames = 0
          bytes = 0
          droppedFrames = 0
          droppedBytes = 0
        }
        const maxDroppedFrames = Math.max(this.maxFramesPerSec * 2, 1024)
        const maxDroppedBytes = 8 * MAX_RELAY_FRAME_BYTES
        if (frames + droppedFrames + 1 > this.maxFramesPerSec + maxDroppedFrames
          || bytes + droppedBytes + frameBytes > 16 * MAX_RELAY_FRAME_BYTES + maxDroppedBytes) {
          throw new ApiError('RATE_LIMITED')
        }
        if (state === 'awaiting_hello' && (++frames > this.maxFramesPerSec || (bytes += frameBytes) > 16 * MAX_RELAY_FRAME_BYTES)) {
          throw new ApiError('RATE_LIMITED')
        }
        const envelope = JSON.parse(text) as { v?: unknown }
        if (envelope && envelope.v !== 1) throw new ApiError('UNSUPPORTED_VERSION')
        frame = decodeControlFrame(text)
        if (state === 'awaiting_hello') {
          if (frame.type !== 'hello') throw new ApiError('AUTH_REQUIRED')
          const p = frame.payload as HelloPayload
          const device = this.store.authenticate(p.accessToken).descriptor
          if (device.deviceId !== p.deviceId || device.role !== p.role) throw new ApiError('AUTH_INVALID')
          if (!p.protocols.includes(1)) throw new ApiError('UNSUPPORTED_VERSION')
          // Re-assert the state: if the deadline fired while credentials were
          // checked, the timeout wins and none of the side effects below run.
          if (state !== 'awaiting_hello') return
          state = 'authenticated'
          // From here the socket occupies an authenticated slot, not a half-open one.
          markAuthenticated()
          clearDeadline()
          // Host identity keeps the upstream single-control-connection rule.
          // Client identity may own one connection per remote Host, so only a
          // reconnecting Host replaces its previous socket.
          if (device.role === 'host') this.disconnectDevice(device.deviceId, 'CONNECTION_REPLACED')
          // Keep the negotiated set (what hello.ack advertises), so a link can
          // never coordinate a transport this Server did not offer — e.g. TURN
          // while no TURN deployment is configured.
          peer = {
            key: device.role === 'host' ? device.deviceId : randomUUID(),
            ws,
            id: device.deviceId,
            role: device.role,
            capabilities: this.negotiatedCapabilities(p.capabilities),
            version: p.clientVersion ?? device.clientVersion,
            lastPong: Date.now(),
          }
          this.addPeer(peer)
          this.store.touch(peer.id, p.clientVersion, p.harnessVersion)
          this.logger.info('ws_hello_authenticated', {
            deviceId: safeText(peer.id),
            role: peer.role,
            connectionKey: peer.key,
            clientVersion: safeText(peer.version),
            capabilities: peer.capabilities.filter(capability => typeof capability === 'string' && SAFE_TEXT.test(capability)).slice(0, 8),
          })
          this.send(peer, createControlFrame('hello.ack', {
            protocol: 1,
            serverVersion: 'self-hosted/0.1.0',
            connectionSessionId: randomUUID(),
            heartbeatIntervalMs: this.heartbeatIntervalMs,
            maxControlFrameBytes: MAX_CONTROL_FRAME_BYTES,
            maxRelayFrameBytes: MAX_RELAY_FRAME_BYTES,
            capabilities: this.negotiatedCapabilities(p.capabilities),
            webrtcEnabled: true,
            webrtcFallbackTimeoutMs: WEBRTC_FALLBACK_TIMEOUT_MS,
          }))
          return
        }
        if (frame.type === 'hello') throw new ApiError('INVALID_MESSAGE')
        if (!peer || this.peers.get(peer.key) !== peer) throw new ApiError('AUTH_INVALID')
        this.store.get(peer.id)
        if (this.isDroppedLinkFrame(peer, frame)) {
          if (++droppedFrames > maxDroppedFrames || (droppedBytes += frameBytes) > maxDroppedBytes) {
            throw new ApiError('RATE_LIMITED')
          }
          return
        }
        if (++frames > this.maxFramesPerSec || (bytes += frameBytes) > 16 * MAX_RELAY_FRAME_BYTES) {
          throw new ApiError('RATE_LIMITED')
        }
        this.handle(peer, frame)
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'INVALID_MESSAGE'
        this.logger.warn('ws_message_error', {
          code,
          peerId: peer?.id,
          // Never log error.message: JSON parse failures echo the payload.
          errorName: errorName(error),
        })
        // Valid connection-scoped failures must not close the Host's other clients.
        const connectionId = (frame?.payload as { connectionId?: unknown } | undefined)?.connectionId
        if (peer && typeof connectionId === 'string' && code !== 'RATE_LIMITED') {
          const link = this.links.get(connectionId)
          if (link && (link.host === peer.key || link.client === peer.key)) { this.drop(link, code); return }
          this.send(peer, createControlFrame('error', { code, message: code, connectionId, retryable: false }))
          return
        }
        state = 'closing'
        clearDeadline()
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify(createControlFrame('error', { code, message: code, retryable: false }))) } catch { /* closing anyway */ }
        }
        if (peer) this.disconnectPeer(peer.key, code)
        else {
          try { ws.close(4001, code) } catch { /* terminate below */ }
          terminateSoon(ws)
        }
      }
    })
  }
  private handle(peer: Peer, frame: ControlFrame): void {
    const p = frame.payload as Record<string, unknown>
    if (frame.type === 'ping') { this.send(peer, createControlFrame('pong', { nonce: p.nonce })); return }
    if (frame.type === 'pong') {
      if (peer.nonce && p.nonce === peer.nonce) { peer.lastPong = Date.now(); peer.nonce = undefined }
      return
    }
    if (frame.type === 'connect.request') {
      const request = frame.payload as ConnectRequestPayload
      if (peer.role !== 'client') throw new ApiError('MEMBERSHIP_REQUIRED')
      const hostKey = this.hostOf.get(request.hostDeviceId)
      const candidateHost = hostKey === undefined ? undefined : this.peers.get(hostKey)
      if (candidateHost && Date.now() - candidateHost.lastPong > this.heartbeatDisconnectMs) {
        this.logger.warn('ws_heartbeat_timeout', {
          peerId: candidateHost.id,
          role: candidateHost.role,
          lastPong: candidateHost.lastPong,
          elapsedMs: Date.now() - candidateHost.lastPong,
          thresholdMs: this.heartbeatDisconnectMs,
        })
        this.disconnectPeer(candidateHost.key, 'CONNECTION_FAILED')
      }
      const host = hostKey === undefined ? undefined : this.peers.get(hostKey)
      if (!host || host.role !== 'host') { this.send(peer, createControlFrame('error', { code: 'HOST_OFFLINE', message: 'Host is offline.', retryable: true })); return }
      const hostDevice = this.store.get(host.id)
      const clientDevice = this.store.get(peer.id)
      /**
       * Tenant boundary, enforced at the relay itself.
       *
       * The Host independently re-checks `deviceFor(clientDeviceId)` against its
       * own credentials, so this is defence in depth: an old or tampered Host
       * build that skips that look-up must still not be reachable from another
       * account. The error deliberately matches "no such device" so a caller
       * cannot probe whether a device id exists elsewhere on the server.
       */
      if (hostDevice.owner !== clientDevice.owner) {
        this.logger.warn('ws_connect_cross_tenant_rejected', {
          peerId: peer.id,
          role: peer.role,
          hostDeviceId: safeText(host.id),
          connectionKey: peer.key,
        })
        throw new ApiError('CONNECTION_NOT_FOUND')
      }
      if (!request.preferredTransports.includes('relay') || !peer.capabilities.includes('transport.relay') || !host.capabilities.includes('transport.relay')) throw new ApiError('CAPABILITY_NOT_SUPPORTED')
      // The link coordinates only transports both peers actually advertised;
      // the Host receives the same intersection so it never sees a transport
      // it could not have negotiated.
      const preferredTransports = [...new Set(request.preferredTransports)].filter(transport =>
        peer.capabilities.includes(`transport.${transport}`) && host.capabilities.includes(`transport.${transport}`)) as TransportName[]
      if (preferredTransports.length === 0) throw new ApiError('CAPABILITY_NOT_SUPPORTED')
      // Only this Client connection's previous Link is replaced. Different
      // remote Hosts connected through the same Client identity keep theirs.
      for (const old of this.links.values()) if (old.client === peer.key || (old.host === host.key && !modernHost(host.version))) this.drop(old, 'CONNECTION_REPLACED')
      if (this.links.size >= MAX_LINKS) throw new ApiError('RATE_LIMITED')
      const link: Link = {
        id: randomUUID(),
        host: host.key,
        hostDeviceId: host.id,
        client: peer.key,
        clientDeviceId: peer.id,
        stage: 'pending',
        created: Date.now(),
        counters: new Map(),
        preferredTransports,
        iceCandidates: 0,
      }
      this.links.set(link.id, link)
      this.send(host, createControlFrame('connect.incoming', {
        connectionId: link.id,
        clientDeviceId: peer.id,
        clientIdentityKey: this.store.get(peer.id).descriptor.identityKey,
        authorization: 'account',
        preferredTransports: link.preferredTransports,
      }))
      return
    }
    const id = p.connectionId
    const link = typeof id === 'string' ? this.links.get(id) : undefined
    if (!link || (peer.key !== link.host && peer.key !== link.client)) throw new ApiError('CONNECTION_NOT_FOUND')
    const otherKey = peer.key === link.host ? link.client : link.host
    const other = this.peers.get(otherKey)
    if (!other) throw new ApiError('CONNECTION_FAILED')
    this.store.get(other.id)
    if (frame.type === 'connect.accepted' || frame.type === 'connect.rejected') {
      if (peer.key !== link.host || link.stage !== 'pending') throw new ApiError('INVALID_MESSAGE')
      if (frame.type === 'connect.rejected') {
        this.links.delete(link.id)
        this.recordDroppedLink(link)
      }
      else link.stage = 'accepted'
      this.send(other, frame)
      return
    }
    if (p.targetDeviceId !== other.id || link.stage === 'pending') throw new ApiError('CONNECTION_NOT_FOUND')
    if (frame.type.startsWith('signal.')) {
      this.forwardSignal(link, peer, other, frame)
      return
    }
    if (frame.type === 'transport.selected') {
      this.forwardTransportSelected(link, peer, other, frame.payload as TransportSelectedPayload)
      return
    }
    if (frame.type === 'secure.handshake') {
      const step = (frame.payload as SecureHandshakePayload).step
      if (step === 1 && peer.key === link.client && link.stage === 'accepted') link.stage = 'handshake'
      else if (step === 2 && peer.key === link.host && link.stage === 'handshake') link.stage = 'ready'
      else throw new ApiError('INVALID_MESSAGE')
    } else if (frame.type === 'relay') {
      const counter = (frame.payload as RelayPayload).counter
      if (link.stage !== 'ready' || counter <= (link.counters.get(peer.key) ?? -1)) throw new ApiError('INVALID_MESSAGE')
      link.counters.set(peer.key, counter)
    } else throw new ApiError('INVALID_MESSAGE')
    this.send(other, frame)
  }
  /**
   * Forward WebRTC signaling only while the logical connection is being
   * established, and only for a transport this link actually negotiated. A
   * relay-only link has no data plane to coordinate — the Host treats
   * unsolicited signaling as a protocol violation that closes its whole
   * Control connection and every tunnel on it, so such frames are dropped for
   * the Client to time out and fall back to Relay.
   */
  private forwardSignal(link: Link, peer: Peer, other: Peer, frame: ControlFrame): void {
    if (link.stage === 'ready') return
    if (!link.preferredTransports.some(transport => transport !== 'relay')) return
    if (frame.type === 'signal.offer') {
      if (peer.key !== link.client) throw new ApiError('INVALID_MESSAGE')
    } else if (frame.type === 'signal.answer') {
      if (peer.key !== link.host) throw new ApiError('INVALID_MESSAGE')
    } else if (frame.type === 'signal.ice') {
      if (++link.iceCandidates > MAX_ICE_CANDIDATES_PER_CONNECTION) throw new ApiError('INVALID_MESSAGE')
    } else {
      throw new ApiError('INVALID_MESSAGE')
    }
    this.send(other, frame)
  }
  /**
   * Forward the initiator's transport choice, gated on the transports the
   * link negotiated. `lan` is downgraded to `p2p` only when the link did not
   * negotiate `transport.lan` (old RC2 peers), as required by
   * docs/protocol.md. Relay keeps the legacy compatibility gate.
   */
  private forwardTransportSelected(link: Link, peer: Peer, other: Peer, payload: TransportSelectedPayload): void {
    // The protocol only lets the initiator (Client) select the transport. A
    // responder (Host) may also announce its own selection after its RTC data
    // channel opens; clients ignore it, so ignoring here is compatibility, not
    // a protocol violation. Throwing would drop the whole link and prevent the
    // Noise handshake from completing.
    if (peer.key !== link.client) return
    if (link.stage !== 'accepted' && link.stage !== 'handshake') throw new ApiError('INVALID_MESSAGE')
    const transport: TransportName = payload.transport
    if (!TRANSPORT_NAMES.includes(transport)) throw new ApiError('INVALID_MESSAGE')
    const selected = transport === 'lan'
      && !link.preferredTransports.includes('lan')
      && link.preferredTransports.includes('p2p')
      ? 'p2p'
      : transport
    if (!link.preferredTransports.includes(selected)) throw new ApiError('CAPABILITY_NOT_SUPPORTED')
    if (selected === 'relay' && !modernHost(other.version)) return
    this.send(other, selected === transport
      ? createControlFrame('transport.selected', { ...payload })
      : createControlFrame('transport.selected', { ...payload, transport: selected }))
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    clearInterval(this.sweep)
    this.logger.info('ws_gateway_closing', { clientCount: this.wss.clients.size })
    for (const ws of this.wss.clients) {
      // Give resumable clients an explicit, unambiguous shutdown signal. A
      // process restart is different from heartbeat failure (4001) and from
      // replacement/authentication failures, so clients can retain only the
      // bounded lease-backed session state.
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close(SERVER_SHUTDOWN_CLOSE_CODE, SERVER_SHUTDOWN_CLOSE_REASON)
        else ws.terminate()
      } catch {
        // Force termination below.
      }
      const timer = setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate() }, this.forceTerminateGraceMs)
      timer.unref()
    }
    this.wss.close()
  }
}
