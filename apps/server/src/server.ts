import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { accountDeviceDescriptorSchema, deviceRegistrationRequestSchema, deviceRefreshRequestSchema } from '@dsh-remote/protocol'
import { ApiError, Store, equal, hash, secret } from './store.js'
import { AccountStore, AccountError } from './account-store.js'
import { createAccountRoutes, type AccountRouteDeps } from './account-routes.js'
import { createMailer, type Mailer, type MailSettings } from './mailer.js'
import { readAccountEnv, type AccountEnv } from './account-config.js'
import { Gateway } from './gateway.js'
import { buildIceServers, parseIceConfig, type IceConfig } from './ice.js'
import { Logger, type LogLevel } from './logger.js'
import {
  FORCE_TERMINATE_GRACE_MS_RANGE,
  HEARTBEAT_DISCONNECT_MS_MAX,
  HELLO_TIMEOUT_MS_RANGE,
  HEARTBEAT_INTERVAL_MS_RANGE,
  MAX_FRAMES_PER_SEC_RANGE,
  normalizeForceTerminateGraceMs,
  normalizeGatewayOptions,
  normalizeHeartbeatDisconnectMs,
  normalizeHeartbeatIntervalMs,
  normalizeHelloTimeoutMs,
  normalizeMaxFramesPerSec,
} from './config.js'

export interface Config {
  account: string
  password: string
  dataFile: string
  publicUrl: string
  /** SPKI SHA-256 (base64url) embedded in pairing strings; empty disables pairing. */
  certFingerprint?: string
  trustedProxyIps?: readonly string[]
  helloTimeoutMs?: number
  heartbeatIntervalMs?: number
  heartbeatDisconnectMs?: number
  forceTerminateGraceMs?: number
  maxFramesPerSec?: number
  logLevel?: LogLevel
  ice?: IceConfig
  /**
   * Hosted multi-tenant mode. When set, email-code login, the web portal and
   * the device-link hand-off are enabled and each account sees only its own
   * devices. When omitted the server behaves exactly like v0.
   */
  accounts?: AccountConfig
}

export interface AccountConfig {
  env: AccountEnv
  mailer?: Mailer
  mail?: MailSettings
}

/**
 * Timing configuration is normalized in one place (`config.ts`) so the CLI and
 * programmatic callers share the same bounds and fallbacks. These wrappers keep
 * the env-var parsing API used by `main.ts` and the tests, and never echo the
 * offending input in their warnings.
 */
export function parseHelloTimeout(val: string | undefined): number {
  return normalizeHelloTimeoutMs(val)
}

export function parseHeartbeatInterval(val: string | undefined): number {
  return normalizeHeartbeatIntervalMs(val)
}

export function parseHeartbeatDisconnect(val: string | undefined, heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS_RANGE.fallback): number {
  return normalizeHeartbeatDisconnectMs(val, heartbeatIntervalMs)
}

export function parseForceTerminateGrace(val: string | undefined): number {
  return normalizeForceTerminateGraceMs(val)
}

export function parseMaxFramesPerSec(val: string | undefined): number {
  return normalizeMaxFramesPerSec(val)
}

export {
  normalizeGatewayOptions,
  normalizeHelloTimeoutMs,
  normalizeHeartbeatIntervalMs,
  normalizeHeartbeatDisconnectMs,
  normalizeForceTerminateGraceMs,
  normalizeMaxFramesPerSec,
  HELLO_TIMEOUT_MS_RANGE,
  HEARTBEAT_INTERVAL_MS_RANGE,
  HEARTBEAT_DISCONNECT_MS_MAX,
  FORCE_TERMINATE_GRACE_MS_RANGE,
  MAX_FRAMES_PER_SEC_RANGE,
}
export type { GatewayTimingOptions, NormalizedGatewayOptions } from './config.js'

const loginSchema = z.object({ email: z.string().min(1).max(254), password: z.string().min(1).max(1024) }).strict()
const adminLoginSchema = z.object({ password: z.string().min(1).max(1024) }).strict()
const pairingRegistrationSchema = z.object({ v: z.literal(1), code: z.string().trim().min(1).max(64), device: accountDeviceDescriptorSchema }).strict()
const createPairingSchema = z.object({
  label: z.string().trim().min(1).max(120),
  platform: z.string().trim().max(32).optional(),
  ttlMinutes: z.number().int().min(1).max(1440).optional(),
}).strict()
const renameSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict()
const MESH_API = 1
const publicDir = fileURLToPath(new URL('../dist/public/', import.meta.url))
function readAssets(): Map<string, Buffer> {
  if (!existsSync(publicDir)) return new Map()
  const assets = new Map<string, Buffer>()
  for (const entry of readdirSync(publicDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = join(entry.parentPath, entry.name)
    const path = file.slice(publicDir.length).replaceAll('\\', '/')
    assets.set(path, readFileSync(file))
  }
  return assets
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new ApiError('INVALID_MESSAGE', 415)
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > 16384) throw new ApiError('FRAME_TOO_LARGE', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ApiError('INVALID_MESSAGE') }
}
/**
 * Normalize one bare IPv4/IPv6 literal to a single canonical form. IPv4-mapped
 * IPv6 addresses (e.g. ::ffff:127.0.0.1) collapse to plain IPv4, so a peer
 * observed through a dual-stack socket and a config entry compare equal.
 * Returns null for anything that is not a single IP literal: hostnames, ports,
 * CIDR ranges, comma-separated lists, bracketed hosts and zone identifiers.
 */
export function normalizeIp(value: string): string | null {
  const family = isIP(value)
  if (family === 4) return value.toLowerCase()
  if (family !== 6) return null
  let canonical: string
  try {
    canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  } catch { return null }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  if (!mapped) return canonical
  const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16)
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
}
/** Validate and normalize the trusted proxy list at startup. Empty means disabled. */
/** A trusted-proxy entry: one literal address, or a CIDR range. */
export interface TrustedProxyRange {
  /** Present for a single address; null for a range. */
  address: string | null
  /** Present for a range: network bytes plus prefix length. */
  network?: Buffer
  prefix?: number
}

function parseCidr(value: string): { network: Buffer; prefix: number } | null {
  const slash = value.lastIndexOf('/')
  if (slash === -1) return null
  const base = normalizeIp(value.slice(0, slash))
  const bits = Number(value.slice(slash + 1))
  if (base === null || !Number.isInteger(bits)) return null
  const family = isIP(base)
  if (family === 4 && (bits < 0 || bits > 32)) return null
  if (family === 6 && (bits < 0 || bits > 128)) return null
  const bytes = family === 4
    ? Buffer.from(base.split('.').map(Number))
    : Buffer.from(base.includes(':') ? ipv6Bytes(base) : [])
  return bytes.length === 0 ? null : { network: bytes, prefix: bits }
}

/** Expand an IPv6 literal (already canonicalized by normalizeIp) to 16 bytes. */
function ipv6Bytes(value: string): number[] {
  const [head = '', tail] = value.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === undefined ? [] : tail === '' ? [] : tail.split(':')
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  const bytes: number[] = []
  for (const group of groups) {
    const parsed = Number.parseInt(group || '0', 16)
    bytes.push((parsed >> 8) & 0xff, parsed & 0xff)
  }
  return bytes.slice(0, 16)
}

function inRange(peer: string, range: TrustedProxyRange): boolean {
  if (range.address !== null) return peer === range.address
  const family = isIP(peer)
  const bytes = family === 4
    ? Buffer.from(peer.split('.').map(Number))
    : family === 6 ? Buffer.from(ipv6Bytes(peer)) : null
  if (bytes === null || range.network === undefined || range.network.length !== bytes.length) return false
  const prefix = range.prefix ?? 0
  const full = Math.floor(prefix / 8)
  for (let i = 0; i < full; i += 1) if (bytes[i] !== range.network[i]) return false
  const remainder = prefix % 8
  if (remainder === 0) return true
  const mask = (0xff << (8 - remainder)) & 0xff
  return (bytes[full]! & mask) === (range.network[full]! & mask)
}

/**
 * Parse the trusted-proxy list.
 *
 * Accepts bare IPv4/IPv6 literals and CIDR ranges. A range is required in
 * practice for container deployments: the proxy's address is assigned by Docker
 * and is not known ahead of time, so `172.16.0.0/12` is the usual entry.
 */
export function normalizeTrustedProxyIps(values: readonly string[] = []): readonly TrustedProxyRange[] {
  const result: TrustedProxyRange[] = []
  // Two spellings of the same address (`::ffff:127.0.0.1` and `127.0.0.1`)
  // must collapse to one entry, as the previous Set-based version did.
  const seen = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    if (value === '') continue
    if (value.includes('/')) {
      const cidr = parseCidr(value)
      if (cidr === null) throw new Error(`Invalid DSH_SERVER_TRUSTED_PROXY_IPS entry "${raw}": malformed CIDR range.`)
      if (seen.has(value)) continue
      seen.add(value)
      result.push({ address: null, ...cidr })
      continue
    }
    const normalized = normalizeIp(value)
    if (normalized === null) throw new Error(`Invalid DSH_SERVER_TRUSTED_PROXY_IPS entry "${raw}": expected an IPv4/IPv6 address or CIDR range.`)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push({ address: normalized })
  }
  return result
}

/** True when the socket peer is one of the configured proxies. */
export function isTrustedProxy(peer: string, ranges: readonly TrustedProxyRange[]): boolean {
  return ranges.some(range => inRange(peer, range))
}
function readSingleForwardedFor(req: IncomingMessage): string {
  let value: string | undefined
  let count = 0
  const raw = req.rawHeaders
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() !== 'x-forwarded-for') continue
    count++
    value = raw[i + 1]
  }
  if (count !== 1) throw new ApiError('INVALID_MESSAGE')
  return value!
}
/**
 * Resolve the address used for rate limiting. X-Forwarded-For is honored only
 * when the socket peer is a configured trusted proxy; that peer must send one
 * header holding exactly one IP literal, otherwise the request is rejected.
 */
export function clientAddress(req: IncomingMessage, trustedProxyIps: readonly TrustedProxyRange[]): string {
  const peer = normalizeIp(req.socket.remoteAddress ?? '')
  if (peer === null) throw new ApiError('INVALID_MESSAGE')
  if (!isTrustedProxy(peer, trustedProxyIps)) return peer
  const forwarded = normalizeIp(readSingleForwardedFor(req))
  if (forwarded === null) throw new ApiError('INVALID_MESSAGE')
  return forwarded
}
export function createRemoteServer(config: Config) {
  if (!config.account.trim() || config.password.length < 12) throw new Error('DSH_SERVER_ACCOUNT and DSH_SERVER_PASSWORD (at least 12 characters) are required.')
  const url = new URL(config.publicUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('DSH_SERVER_PUBLIC_URL must be an HTTP(S) origin.')
  const trustedProxyIps = normalizeTrustedProxyIps(config.trustedProxyIps)
  const ice = config.ice ?? parseIceConfig({})
  const store = new Store(config.dataFile, config.account.trim(), config.password)
  const assets = readAssets()
  const sessions = new Map<string, number>()
  const limits = new Map<string, { count: number; until: number }>()
  function rate(key: string, max: number) {
    for (const [k, v] of limits) if (v.until < Date.now()) limits.delete(k)
    let entry = limits.get(key)
    if (!entry) { if (limits.size >= 4096) throw new ApiError('RATE_LIMITED', 429); entry = { count: 0, until: Date.now() + 60_000 }; limits.set(key, entry) }
    if (++entry.count > max) throw new ApiError('RATE_LIMITED', 429)
  }
  function token(req: IncomingMessage): string {
    const authorization = req.headers.authorization
    if (authorization) return authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    return /(?:^|;\s*)dsh_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
  }
  /**
   * Personal mode keeps its in-memory admin session. Account mode delegates to
   * the SQLite-backed account store, which survives restarts and is scoped to
   * one account per session.
   */
  const accountRuntime = (() => {
    if (!config.accounts) return undefined
    const accounts = new AccountStore(config.accounts.env.dataFile, config.accounts.env.pepper, config.accounts.env.limits)
    const mail = config.accounts.mail ?? config.accounts.env.mail
    const mailer = config.accounts.mailer ?? createMailer(mail)
    return { env: config.accounts.env, accounts, mailer, mail }
  })()
  function accountAuth(req: IncomingMessage) {
    if (accountRuntime) {
      const account = accountRuntime.accounts.accountForSession(token(req))
      if (!account) throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401)
      return account
    }
    const key = hash(token(req))
    if ((sessions.get(key) ?? 0) <= Date.now()) { sessions.delete(key); throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401) }
    return undefined
  }
  /** The scope every device/node/pairing query must be filtered by. */
  function ownerScope(account: { accountId: string } | undefined): string | undefined {
    return accountRuntime && account ? hash(account.accountId) : undefined
  }
  function deviceAuth(req: IncomingMessage) {
    if (!req.headers.authorization?.startsWith('Bearer ')) throw new ApiError('AUTH_REQUIRED', 401)
    return store.authenticate(req.headers.authorization.slice(7))
  }
  function cookie(value: string, age: number): string { return `dsh_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}` }
  const profile = () => ({ account: store.account, profile: { displayName: store.account }, isAdmin: false })
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    void route(req, res).catch(error => {
      if (res.headersSent || res.destroyed) return
      // AccountError carries an HTTP status of its own (LINK_PENDING is 202 and
      // must not be flattened into a generic 400).
      const e = error instanceof ApiError
        ? error
        : error instanceof AccountError
          ? new ApiError(error.code, error.status)
          : error instanceof z.ZodError
            ? new ApiError('INVALID_MESSAGE')
            : new ApiError('INTERNAL_ERROR', 500)
      if (e.status === 429) res.setHeader('Retry-After', '60')
      json(res, e.status, { error: { code: e.code, message: e.code, requestId: randomUUID(), retryable: e.status === 429 || e.status >= 500 } })
    })
  })
  const logger = new Logger('server', config.logLevel ?? 'info')
  // Normalize at this boundary as well: a programmatic caller may pass NaN,
  // Infinity or a negative value straight through the Config object.
  const timing = normalizeGatewayOptions({
    helloTimeoutMs: config.helloTimeoutMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatDisconnectMs: config.heartbeatDisconnectMs,
    forceTerminateGraceMs: config.forceTerminateGraceMs,
  })
  const gateway = new Gateway(server, store, url.origin, {
    ...timing,
    maxFramesPerSec: normalizeMaxFramesPerSec(config.maxFramesPerSec),
    logLevel: config.logLevel,
    logger: logger.child('gateway'),
    turnEnabled: ice.turnUrls.length > 0,
  })
  function descriptor(d: ReturnType<Store['get']>) {
    return { ...d.descriptor, membershipId: `account:${hash(store.account).slice(0, 16)}`, online: gateway.isOnline(d.descriptor.deviceId), lastSeenAt: d.lastSeenAt }
  }
  function deviceWithNode(d: ReturnType<Store['get']>) {
    const node = nodeOf(d)
    return { ...descriptor(d), nodeId: d.nodeId, nodeName: node?.name }
  }
  function nodeOf(device: ReturnType<Store['get']>, scope?: string) {
    return device.nodeId === undefined ? undefined : store.listNodes(scope).find(node => node.id === device.nodeId)
  }
  function nodeSummary(node: ReturnType<Store['listNodes']>[number], scope?: string) {
    const devices = [node.hostDeviceId, node.clientDeviceId]
      .filter((id): id is string => id !== undefined && id !== '')
      .map(id => store.list(scope).find(device => device.descriptor.deviceId === id))
      .filter((device): device is NonNullable<typeof device> => device !== undefined)
    const online = devices.some(device => gateway.isOnline(device.descriptor.deviceId))
    const lastSeenAt = devices.reduce((latest, device) => Math.max(latest, device.lastSeenAt), 0)
    const host = devices.find(device => device.descriptor.deviceId === node.hostDeviceId)
    return {
      nodeId: node.id,
      name: node.name,
      platform: node.platform,
      online,
      lastSeenAt: lastSeenAt || undefined,
      hostDeviceId: node.hostDeviceId,
      clientDeviceId: node.clientDeviceId,
      harnessVersion: host !== undefined && 'harnessVersion' in host.descriptor ? host.descriptor.harnessVersion : undefined,
      appVersion: host?.descriptor.clientVersion,
    }
  }
  /**
   * `fp` is omitted entirely when the deployment uses a public certificate: the
   * client then verifies with the platform CA store. A self-signed deployment
   * sets DSH_SERVER_CERT_FINGERPRINT and the digest is embedded here.
   */
  function pairingString(code: string): string {
    const fingerprint = config.certFingerprint?.trim() ?? ''
    const base = `dshmesh://${url.host}/pair?v=1&code=${encodeURIComponent(code)}`
    return fingerprint === '' ? base : `${base}&fp=${encodeURIComponent(fingerprint)}`
  }
  /**
   * Hosted-mode routes. Only mounted when account mode is configured, so the
   * personal build exposes no account endpoints at all (v0 invariant).
   */
  const accountRoutes = accountRuntime === undefined ? undefined : createAccountRoutes({
    store,
    accounts: accountRuntime.accounts,
    mailer: accountRuntime.mailer,
    mail: accountRuntime.mail,
    limits: accountRuntime.env.limits,
    publicUrl: url,
    ...(accountRuntime.env.inviteCode === undefined ? {} : { inviteCode: accountRuntime.env.inviteCode }),
    adminEmails: accountRuntime.env.adminEmails,
    clientAddress: req => clientAddress(req, trustedProxyIps),
    rate,
    isOnline: deviceId => gateway.isOnline(deviceId),
    body,
    json,
    cookieToken: token,
    setSessionCookie: (res, value, maxAgeSeconds) => { res.setHeader('Set-Cookie', cookie(value, maxAgeSeconds)) },
    clearSessionCookie: res => { res.setHeader('Set-Cookie', cookie('', 0)) },
    hash,
  } satisfies AccountRouteDeps)
  async function route(req: IncomingMessage, res: ServerResponse) {
    const requestUrl = new URL(req.url ?? '/', url)
    const path = requestUrl.pathname
    const method = req.method
    if (req.headers.origin && req.headers.origin !== url.origin) throw new ApiError('AUTH_INVALID', 403)
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError('AUTH_INVALID', 403)
    const staticAsset = path.startsWith('/assets/') || ['/icon.png', '/brand-whale.webp', '/landing-atmosphere.webp'].includes(path)
    // SPA fallback: any GET that is not API / WebSocket / health-check returns index.html.
    // Without this, refreshing a client route such as /app/remote hits the unknown-method branch and yields METHOD_NOT_FOUND.
    const spaRoute = method === 'GET' && !staticAsset && !path.startsWith('/api/') && !path.startsWith('/ws/') && !['/health', '/healthz', '/ready'].includes(path)
    if (method === 'GET' && (spaRoute || staticAsset)) {
      const name = staticAsset ? path.slice(1) : 'index.html'
      const asset = assets.get(name)
      if (!asset) throw new ApiError('METHOD_NOT_FOUND', 404)
      const contentType = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'text/html; charset=utf-8'
      if (!staticAsset) res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Content-Type', contentType)
      res.end(asset); return
    }
    if (method === 'GET' && (path === '/health' || path === '/healthz' || path === '/ready')) {
      json(res, 200, { status: 'ok', meshApi: MESH_API, mode: accountRoutes ? 'account' : 'personal' }); return
    }
    const client = clientAddress(req, trustedProxyIps)
    rate(`api:${client}`, 1200)
    // Hosted mode claims its own paths first. Personal mode has no router, so
    // the v0 surface is byte-for-byte unchanged.
    if (accountRoutes && await accountRoutes.handle(req, res, path, method)) return
    if (method === 'POST' && path === '/api/v1/admin/login') {
      rate(`admin-login:${client}`, 10)
      const credentials = adminLoginSchema.parse(await body(req))
      if (!equal(credentials.password, config.password)) throw new ApiError('AUTH_INVALID', 401)
      for (const [key, expires] of sessions) if (expires <= Date.now()) sessions.delete(key)
      if (sessions.size >= 256) throw new ApiError('RATE_LIMITED', 429)
      const value = secret(), expiresAt = Date.now() + 8 * 3600_000
      sessions.set(hash(value), expiresAt)
      res.setHeader('Set-Cookie', cookie(value, 8 * 3600))
      json(res, 200, { status: 'ok', token: value, expiresAt }); return
    }
    if (method === 'GET' && path === '/api/v1/admin/nodes') {
      const account = accountAuth(req), scope = ownerScope(account)
      json(res, 200, { items: store.listNodes(scope).map(node => nodeSummary(node, scope)) }); return
    }
    if (method === 'POST' && path === '/api/v1/admin/pairing-codes') {
      const account = accountAuth(req), scope = ownerScope(account)
      const input = createPairingSchema.parse(await body(req))
      const created = store.createPairingCode(input.label, input.platform, (input.ttlMinutes ?? 30) * 60_000, scope)
      json(res, 201, { ...created, pairing: pairingString(created.code) }); return
    }
    if (method === 'GET' && path === '/api/v1/admin/pairing-codes') {
      const account = accountAuth(req), scope = ownerScope(account)
      json(res, 200, { items: store.listPairingCodes(scope) }); return
    }
    const pairingCodeMatch = /^\/api\/v1\/admin\/pairing-codes\/([^/]+)$/.exec(path)
    if (method === 'DELETE' && pairingCodeMatch) {
      const account = accountAuth(req), scope = ownerScope(account)
      store.revokePairingCode(pairingCodeMatch[1]!, scope)
      json(res, 200, { status: 'revoked' }); return
    }
    const nodeRevokeMatch = /^\/api\/v1\/admin\/nodes\/([^/]+)\/revoke$/.exec(path)
    if (method === 'POST' && nodeRevokeMatch) {
      const account = accountAuth(req), scope = ownerScope(account)
      store.revokeNode(nodeRevokeMatch[1]!, scope)
      json(res, 200, { status: 'revoked' }); return
    }
    if (method === 'POST' && path === '/api/v1/devices/register-with-code') {
      rate(`pair:${client}`, 20)
      const { code, device } = pairingRegistrationSchema.parse(await body(req))
      json(res, 200, store.registerWithCode(code, device)); return
    }
    if (method === 'POST' && path === '/api/v1/auth/login') {
      rate(`login:${client}`, 20)
      const credentials = loginSchema.parse(await body(req))
      if (!equal(credentials.email.trim(), store.account) || !equal(credentials.password, config.password)) throw new ApiError('AUTH_INVALID', 401)
      for (const [key, expires] of sessions) if (expires <= Date.now()) sessions.delete(key)
      if (sessions.size >= 256) throw new ApiError('RATE_LIMITED', 429)
      const value = secret(), expiresAt = Date.now() + 8 * 3600_000
      sessions.set(hash(value), expiresAt)
      res.setHeader('Set-Cookie', cookie(value, 8 * 3600))
      json(res, 200, { ...profile(), token: value, expiresAt }); return
    }
    if (method === 'GET' && path === '/api/v1/auth/me') { accountAuth(req); json(res, 200, profile()); return }
    if (method === 'POST' && path === '/api/v1/auth/logout') {
      sessions.delete(hash(token(req))); res.setHeader('Set-Cookie', cookie('', 0)); json(res, 200, { status: 'ok' }); return
    }
    if (method === 'GET' && path === '/api/v1/account/devices') {
      const account = accountAuth(req), scope = ownerScope(account)
      json(res, 200, { items: store.list(scope).map(descriptor), serverUrl: url.origin, transport: 'webrtc' }); return
    }
    if (method === 'POST' && (path === '/api/v1/devices/register' || path === '/api/v1/devices/register-owned-role')) {
      const owned = path.endsWith('register-owned-role')
      const source = owned ? deviceAuth(req) : undefined
      const account = source ? undefined : accountAuth(req)
      const scope = ownerScope(account)
      const { device } = deviceRegistrationRequestSchema.parse(await body(req))
      if (source && (source.descriptor.deviceId === device.deviceId || source.descriptor.role === device.role)) throw new ApiError('INVALID_MESSAGE', 409)
      json(res, 200, source
        ? store.registerOwnedRole(device, source.descriptor.deviceId, source.owner)
        : store.register(device, scope)); return
    }
    if (method === 'POST' && path === '/api/v1/auth/refresh') {
      const data = deviceRefreshRequestSchema.parse(await body(req))
      json(res, 200, store.refresh(data.deviceId, data.refreshToken)); return
    }
    if (method === 'DELETE' && path === '/api/v1/devices/self') {
      store.revoke(deviceAuth(req).descriptor.deviceId); json(res, 200, { status: 'revoked' }); return
    }
    if (method === 'GET' && path === '/api/v1/nodes/self') {
      const source = deviceAuth(req)
      json(res, 200, nodeSummary(store.nodeForDevice(source.descriptor.deviceId, source.owner), source.owner)); return
    }
    if (method === 'DELETE' && path === '/api/v1/nodes/self') {
      const source = deviceAuth(req)
      const node = store.nodeForDevice(source.descriptor.deviceId, source.owner)
      store.revokeNode(node.id, source.owner)
      json(res, 200, { status: 'revoked' }); return
    }
    if (method === 'GET' && path === '/api/v1/me') { json(res, 200, deviceWithNode(deviceAuth(req))); return }
    if (method === 'GET' && path === '/api/v1/turn/credentials') {
      const source = deviceAuth(req)
      const connectionId = requestUrl.searchParams.get('connection_id') ?? ''
      if (!connectionId || connectionId.length > 128) throw new ApiError('INVALID_MESSAGE')
      if (!gateway.authorizeIce(source.descriptor.deviceId, connectionId)) throw new ApiError('CONNECTION_NOT_FOUND', 404)
      json(res, 200, { iceServers: buildIceServers(ice, source.descriptor.deviceId) }); return
    }
    if (method === 'GET' && path === '/api/v1/devices') {
      const source = deviceAuth(req)
      if (source.descriptor.role !== 'client') throw new ApiError('MEMBERSHIP_REQUIRED', 403)
      // Scoped list: a client only ever discovers hosts of its own account.
      const items = store.list(source.owner).filter(d => d.descriptor.role === 'host').map(d => {
        const { identityKey: _key, ...item } = deviceWithNode(d)
        return item
      })
      json(res, 200, { items, nextCursor: null }); return
    }
    const renameMatch = /^\/api\/v1\/devices\/([^/]+)\/name$/.exec(path)
    if (method === 'POST' && renameMatch) {
      // Identity rule: a device may rename only the node it belongs to. There is
      // no account/admin rename path in v0.
      const source = deviceAuth(req)
      if (source.descriptor.deviceId !== renameMatch[1]) throw new ApiError('NAME_NOT_OWNED', 403)
      const { name } = renameSchema.parse(await body(req))
      const node = store.renameNodeForDevice(source.descriptor.deviceId, name, source.owner)
      json(res, 200, { node: nodeSummary(node, source.owner), device: deviceWithNode(store.get(source.descriptor.deviceId, source.owner)) }); return
    }
    const match = /^\/api\/v1\/devices\/([^/]+)(\/presence)?$/.exec(path)
    if (method === 'GET' && match) {
      const source = deviceAuth(req)
      // Another account's device is indistinguishable from a missing one.
      const target = store.get(match[1]!, source.owner)
      if (source.descriptor.role === target.descriptor.role) throw new ApiError('MEMBERSHIP_REQUIRED', 403)
      const d = deviceWithNode(target)
      json(res, 200, match[2] ? { deviceId: d.deviceId, online: d.online, lastSeenAt: d.lastSeenAt } : d); return
    }
    throw new ApiError('METHOD_NOT_FOUND', 404)
  }
  return { server, store, gateway, logger, close: async () => { gateway.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value))
}
