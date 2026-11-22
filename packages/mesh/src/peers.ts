import {
  ClientConnection,
  ClientServerApi,
  IdentityStore,
  RemoteTypertGateway,
  SafeLogger,
  type HostIdentity,
  type ResolvedConfig,
  type ServerHostDevice,
} from 'ds-harness-remote/internal'
import type { MeshNode } from './types.js'
import type { ResolvedMeshConfig } from './config.js'

export interface PeerEntry {
  node: MeshNode
  status: 'connecting' | 'online' | 'offline'
  gateway?: RemoteTypertGateway
  connection?: ClientConnection
  remote?: Awaited<ReturnType<ClientConnection['connect']>>
  error?: string
  /** Protocol code behind `error`, when the throw carried one. */
  errorCode?: string
  /**
   * Latest presence answer from the Server. `node.online` is the *local* view
   * (whether our tunnel is up), so the retry cadence needs the Server's answer
   * kept separately.
   */
  serverOnline?: boolean
  retryTimer?: ReturnType<typeof setTimeout>
}

const RECONNECT_DELAY_MS = 15_000
/**
 * Retry cadence while the Server says the target is online but our socket is
 * not up. The 15s default exists to avoid hammering a Host that is genuinely
 * down; it is the wrong delay when the peer is reachable and we simply lost the
 * race to (re)establish the tunnel.
 */
const OFFLINE_RETRY_MS = 4_000
const PRESENCE_POLL_MS = 10_000

/**
 * One Client control connection per remote Host. The upstream client runtime
 * keeps a single active Host; this manager owns the N-per-node topology v0
 * needs and never touches the official Typert gateway or the UI singleton.
 */
export class MeshPeers {
  private readonly entries = new Map<string, PeerEntry>()
  private timer?: ReturnType<typeof setInterval>
  private refreshPromise?: Promise<void>
  private closed = false

  constructor(
    private readonly config: ResolvedMeshConfig,
    private readonly runtimeConfig: ResolvedConfig,
    private readonly server: ClientServerApi,
    private readonly identity: HostIdentity,
    private readonly identities: IdentityStore,
    private readonly logger: SafeLogger,
    private readonly createWebSocket: (url: string) => WebSocket,
    private readonly selfNodeId?: string,
    private readonly selfHostDeviceId?: string,
  ) {}

  async start(): Promise<void> {
    // A transient API rate limit or network error must not permanently disable
    // the peer manager; the presence poll retries on its own.
    await this.refresh().catch(error => {
      this.logger.warn('mesh presence refresh failed', { code: error instanceof Error ? error.message.slice(0, 120) : 'unknown' })
    })
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined) }, PRESENCE_POLL_MS)
    this.timer.unref?.()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    for (const entry of this.entries.values()) {
      if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer)
      await entry.remote?.client.close().catch(() => undefined)
    }
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  onlineCount(): number {
    return [...this.entries.values()].filter(entry => entry.status === 'online').length
  }

  nodes(): MeshNode[] {
    return [...this.entries.values()].map(entry => ({
      ...entry.node,
      online: entry.status === 'online',
    }))
  }

  peer(nodeId: string): PeerEntry | undefined {
    return this.entries.get(nodeId)
  }

  async refresh(): Promise<void> {
    if (this.closed) return
    if (this.refreshPromise !== undefined) return this.refreshPromise
    this.refreshPromise = this.refreshOnce().finally(() => { this.refreshPromise = undefined })
    return this.refreshPromise
  }

  private async refreshOnce(): Promise<void> {
    const devices = await this.server.listDevices()
    const seen = new Set<string>()
    for (const device of devices) {
      if (device.deviceId === this.selfHostDeviceId) continue
      const nodeId = device.nodeId ?? device.deviceId
      if (nodeId === this.selfNodeId) continue
      seen.add(nodeId)
      const existing = this.entries.get(nodeId)
      const node = nodeFromDevice(device, nodeId)
      if (existing === undefined) {
        const entry: PeerEntry = { node, status: 'offline', serverOnline: device.online }
        this.entries.set(nodeId, entry)
        // Do not open a control socket for a Host the Server already reports
        // offline: the client would only fail one RTT later and add retry load.
        if (device.online !== false) void this.connect(entry)
      } else {
        existing.node = { ...existing.node, ...node, online: existing.status === 'online' }
        existing.serverOnline = device.online
        if (device.online === true && existing.status === 'offline') void this.connect(existing)
      }
    }
    for (const [nodeId, entry] of this.entries) {
      if (seen.has(nodeId)) continue
      if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer)
      void entry.remote?.client.close().catch(() => undefined)
      this.entries.delete(nodeId)
    }
  }

  private async connect(entry: PeerEntry): Promise<void> {
    if (this.closed || entry.status === 'connecting' || entry.status === 'online') return
    entry.status = 'connecting'
    entry.error = undefined
    const progress = {
      connectionProgressRun: 0,
      connectionProgress: undefined as { runId: number; targetDeviceId: string; phase: string } | undefined,
    }
    const connection = new ClientConnection({
      get connectionProgressRun() { return progress.connectionProgressRun },
      set connectionProgressRun(value: number) { progress.connectionProgressRun = value },
      get connectionProgress() { return progress.connectionProgress as never },
      set connectionProgress(value) { progress.connectionProgress = value as never },
      requireIdentity: () => this.identity,
      server: this.server,
      config: this.runtimeConfig,
      rtcFactoryProvider: async () => undefined,
      createWebSocket: this.createWebSocket,
      logger: this.logger,
      identities: this.identities,
    })
    entry.connection = connection
    try {
      const remote = await connection.connect(entry.node.hostDeviceId)
      if (this.closed) {
        await remote.client.close().catch(() => undefined)
        return
      }
      entry.remote = remote
      entry.gateway = new RemoteTypertGateway(remote.client)
      entry.status = 'online'
      entry.node = { ...entry.node, online: true }
      remote.client.onClose(() => {
        if (entry.remote !== remote || this.closed) return
        entry.status = 'offline'
        entry.remote = undefined
        entry.gateway = undefined
        this.scheduleReconnect(entry)
      })
      this.logger.info('mesh peer connected', { nodeId: entry.node.nodeId, deviceId: entry.node.hostDeviceId })
    } catch (error) {
      entry.status = 'offline'
      entry.error = error instanceof Error ? error.message : 'connection failed'
      // Classify instead of logging a bare message: "the Server says the Host is
      // online but my tunnel failed" is a very different problem from "the Host
      // is down", and only the first one is retried on the short cadence.
      entry.errorCode = errorCodeOf(error)
      this.logger.warn('mesh peer connection failed', {
        nodeId: entry.node.nodeId,
        code: entry.errorCode ?? entry.error.slice(0, 120),
        serverReportsOnline: entry.serverOnline,
      })
      this.scheduleReconnect(entry)
    }
  }

  private scheduleReconnect(entry: PeerEntry): void {
    if (this.closed || entry.retryTimer !== undefined) return
    // A peer the Server still reports as online gets the short cadence: the
    // failure is our tunnel, not the peer. A genuinely offline peer keeps the
    // slow cadence so a powered-down machine is not polled every few seconds.
    const delayMs = entry.serverOnline === true ? OFFLINE_RETRY_MS : RECONNECT_DELAY_MS
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined
      void this.connect(entry)
    }, delayMs)
    entry.retryTimer.unref?.()
  }
}

/** Pull a protocol error code off an unknown throw without trusting its shape. */
function errorCodeOf(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : undefined
}

function nodeFromDevice(device: ServerHostDevice, nodeId: string): MeshNode {
  return {
    nodeId,
    name: device.nodeName ?? device.name,
    platform: device.platform,
    online: device.online !== false,
    ...(device.lastSeenAt === undefined ? {} : { lastSeenAt: device.lastSeenAt }),
    hostDeviceId: device.deviceId,
    ...(device.harnessVersion === undefined ? {} : { harnessVersion: device.harnessVersion }),
    ...(device.clientVersion === undefined ? {} : { appVersion: device.clientVersion }),
  }
}