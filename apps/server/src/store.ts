import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { accountDeviceDescriptorSchema, type AccountDeviceDescriptor } from '@dsh-remote/protocol'
import { z } from 'zod'

export class ApiError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const secret = (): string => randomBytes(32).toString('base64url')
export const equal = (left: string, right: string): boolean => timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)))
const tokenSchema = z.object({
  kind: z.enum(['access', 'refresh']), deviceId: z.string(), expires: z.number(), used: z.boolean(),
  recovery: z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), accessExpires: z.number().int().positive() }).optional(),
})
const savedDeviceSchema = z.object({
  descriptor: accountDeviceDescriptorSchema,
  revoked: z.boolean(),
  lastSeenAt: z.number(),
  /** v0 node binding. Optional so a v1 state file can still be parsed. */
  nodeId: z.string().optional(),
  /**
   * Owning account (a digest, never the address). Backfilled on load for v2
   * files, where a single tenant owned everything.
   */
  owner: z.string().optional(),
})
export const nodeSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  platform: z.string().max(32),
  createdAt: z.number(),
  revoked: z.boolean(),
  hostDeviceId: z.string(),
  clientDeviceId: z.string().optional(),
  owner: z.string().optional(),
})
export const pairingCodeSchema = z.object({
  id: z.string(),
  codeHash: z.string(),
  label: z.string().max(120),
  platform: z.string().max(32).optional(),
  createdAt: z.number(),
  expiresAt: z.number(),
  usedAt: z.number().optional(),
  revokedAt: z.number().optional(),
  nodeId: z.string().optional(),
  owner: z.string().optional(),
})
const legacyStateSchema = z.object({
  version: z.literal(1),
  account: z.string(),
  salt: z.string(),
  verifier: z.string(),
  devices: z.record(z.string(), savedDeviceSchema),
  tokens: z.record(z.string(), tokenSchema),
})
const stateSchema = z.object({
  version: z.literal(2),
  account: z.string(),
  salt: z.string(),
  verifier: z.string(),
  devices: z.record(z.string(), savedDeviceSchema),
  tokens: z.record(z.string(), tokenSchema),
  nodes: z.record(z.string(), nodeSchema),
  pairingCodes: z.record(z.string(), pairingCodeSchema),
})
export type SavedDevice = z.infer<typeof savedDeviceSchema>
export type MeshNode = z.infer<typeof nodeSchema>
export type PairingCode = z.infer<typeof pairingCodeSchema>
type SavedToken = z.infer<typeof tokenSchema>
type State = z.infer<typeof stateSchema>

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PAIRING_TTL_MS = 30 * 60_000
const MAX_PAIRING_CODES = 512

// Domain-separated HMACs keyed by the presented bearer, NOT its stored digest.
// The nonce alone cannot recover credentials from a copy of state.json.
function successor(token: string, nonce: string, deviceId: string) {
  const derive = (kind: string) => createHmac('sha256', token)
    .update(JSON.stringify(['ds-harness-remote/refresh/v1', deviceId, nonce, kind])).digest('base64url')
  return { accessToken: derive('access'), refreshToken: derive('refresh') }
}

function pairingCode(): string {
  const bytes = randomBytes(8)
  let code = ''
  for (const byte of bytes) code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]
  return code
}

function platformPrefix(platform: string): string {
  switch (platform) {
    case 'darwin': return 'Mac'
    case 'win32': return 'Windows'
    case 'android': return 'Phone'
    case 'linux': return 'Linux'
    default: return 'Device'
  }
}

/** Single-process store. Only token digests and public identities reach disk. */
export class Store {
  private state: State
  onInvalidate: (id: string) => void = () => {}
  /** Every record written from now on carries this owner scope. */
  private defaultOwner: string
  constructor(private readonly file: string, readonly account: string, password: string) {
    const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as unknown : undefined
    const parsed = previous === undefined ? undefined : stateSchema.safeParse(previous)
    const legacy = parsed?.success === false && previous !== undefined ? legacyStateSchema.safeParse(previous) : undefined
    const salt = (parsed?.success ? parsed.data.salt : legacy?.success ? legacy.data.salt : undefined) ?? secret()
    const verifier = scryptSync(password, salt, 32).toString('hex')
    this.state = parsed?.success
      ? parsed.data
      : legacy?.success
        ? this.migrate(legacy.data)
        : { version: 2, account, salt, verifier, devices: {}, tokens: {}, nodes: {}, pairingCodes: {} }
    if (this.state.account !== account) {
      this.state.devices = {}
      this.state.tokens = {}
      this.state.nodes = {}
      this.state.pairingCodes = {}
    } else if (!equal(this.state.verifier, verifier)) {
      this.state.tokens = {}
    }
    Object.assign(this.state, { account, verifier })
    this.defaultOwner = hash(account)
    // v2 records predate ownership; a single tenant owned everything, so claim
    // the whole file for that account instead of orphaning it.
    this.backfillOwners(this.defaultOwner)
    this.save()
  }

  /** Give every pre-multi-account record the single tenant's scope. */
  private backfillOwners(owner: string): void {
    for (const device of Object.values(this.state.devices)) device.owner ??= owner
    for (const node of Object.values(this.state.nodes)) node.owner ??= owner
    for (const code of Object.values(this.state.pairingCodes)) code.owner ??= owner
  }

  /** v1 had no node layer. Give every existing identity a node so the upgrade is lossless enough to re-pair. */
  private migrate(legacy: z.infer<typeof legacyStateSchema>): State {
    const state: State = {
      version: 2,
      account: legacy.account,
      salt: legacy.salt,
      verifier: legacy.verifier,
      devices: {},
      tokens: legacy.tokens,
      nodes: {},
      pairingCodes: {},
    }
    const names = new Set<string>()
    const legacyOwner = hash(legacy.account)
    for (const [deviceId, saved] of Object.entries(legacy.devices)) {
      const name = this.uniqueName(saved.descriptor.name, saved.descriptor.platform, legacyOwner, names)
      const nodeId = randomUUID()
      state.nodes[nodeId] = {
        id: nodeId,
        name,
        platform: saved.descriptor.platform,
        createdAt: Date.now(),
        revoked: false,
        hostDeviceId: saved.descriptor.role === 'host' ? deviceId : '',
        ...(saved.descriptor.role === 'client' ? { clientDeviceId: deviceId } : {}),
      }
      saved.descriptor.name = name
      state.devices[deviceId] = { ...saved, nodeId }
    }
    return state
  }

  private transaction<T>(fn: () => T): T {
    const before = structuredClone(this.state)
    try {
      return fn()
    } catch (error) {
      this.state = before
      throw error
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
  get(id: string, scope?: string): SavedDevice {
    const d = Object.hasOwn(this.state.devices, id) ? this.state.devices[id] : undefined
    if (!d) throw new ApiError('DEVICE_NOT_FOUND', 404)
    if (scope !== undefined && d.owner !== scope) throw new ApiError('DEVICE_NOT_FOUND', 404)
    if (d.revoked) throw new ApiError('DEVICE_REVOKED', 403)
    return d
  }
  list(scope?: string): SavedDevice[] {
    return Object.values(this.state.devices)
      .filter(d => !d.revoked && (scope === undefined || d.owner === scope))
  }

  listNodes(scope?: string): MeshNode[] {
    return Object.values(this.state.nodes)
      .filter(node => !node.revoked && (scope === undefined || node.owner === scope))
  }
  getNode(id: string, scope?: string): MeshNode {
    const node = Object.hasOwn(this.state.nodes, id) ? this.state.nodes[id] : undefined
    if (!node) throw new ApiError('NODE_NOT_FOUND', 404)
    if (scope !== undefined && node.owner !== scope) throw new ApiError('NODE_NOT_FOUND', 404)
    if (node.revoked) throw new ApiError('NODE_REVOKED', 403)
    return node
  }
  nodeForDevice(deviceId: string, scope?: string): MeshNode {
    const device = this.get(deviceId, scope)
    if (!device.nodeId) throw new ApiError('NODE_NOT_FOUND', 404)
    return this.getNode(device.nodeId, scope)
  }

  private uniqueName(desired: string | undefined, platform: string, owner: string, taken = new Set(Object.values(this.state.nodes).filter(n => !n.revoked && n.owner === owner).map(n => n.name.toLowerCase()))): string {
    const candidate = desired?.trim()
    if (candidate && candidate.length > 0 && candidate.length <= 80 && !taken.has(candidate.toLowerCase())) return candidate
    const prefix = platformPrefix(platform)
    for (let index = 1; index < 10_000; index += 1) {
      const name = `${prefix}${index}`
      if (!taken.has(name.toLowerCase())) return name
    }
    throw new ApiError('RATE_LIMITED', 429)
  }

  private createNode(descriptor: AccountDeviceDescriptor, owner: string, desiredName?: string): MeshNode {
    const node: MeshNode = {
      id: randomUUID(),
      name: this.uniqueName(desiredName ?? descriptor.name, descriptor.platform, owner),
      platform: descriptor.platform,
      createdAt: Date.now(),
      revoked: false,
      hostDeviceId: descriptor.role === 'host' ? descriptor.deviceId : '',
      ...(descriptor.role === 'client' ? { clientDeviceId: descriptor.deviceId } : {}),
      owner,
    }
    this.state.nodes[node.id] = node
    return node
  }

  private registerDevice(descriptor: AccountDeviceDescriptor, nodeId: string, owner: string): ReturnType<Store['issue']> {
    const old = this.state.devices[descriptor.deviceId]
    // A device id is globally unique; another account may not adopt it.
    if (old && old.owner !== owner) throw new ApiError('PEER_IDENTITY_MISMATCH', 409)
    if (old?.revoked) throw new ApiError('DEVICE_REVOKED', 403)
    if (old && (old.descriptor.identityKey !== descriptor.identityKey || old.descriptor.role !== descriptor.role)) throw new ApiError('PEER_IDENTITY_MISMATCH', 409)
    if (!old && Object.keys(this.state.devices).length >= 256) throw new ApiError('RATE_LIMITED', 429)
    this.state.devices[descriptor.deviceId] = {
      descriptor,
      revoked: false,
      lastSeenAt: old?.lastSeenAt ?? 0,
      nodeId,
      owner,
    }
    this.invalidate(descriptor.deviceId)
    return this.issue(descriptor.deviceId)
  }

  register(descriptor: AccountDeviceDescriptor, owner = this.defaultOwner): ReturnType<Store['issue']> {
    return this.transaction(() => {
      const existing = this.state.devices[descriptor.deviceId]
      if (existing && existing.owner !== owner) throw new ApiError('PEER_IDENTITY_MISMATCH', 409)
      if (existing?.nodeId && this.state.nodes[existing.nodeId]) return this.registerDevice(descriptor, existing.nodeId, owner)
      const node = this.createNode(descriptor, owner)
      return this.registerDevice(descriptor, node.id, owner)
    })
  }

  /**
   * Host-only registration with a one-time administrative pairing code.
   * Creates the node and binds the Host identity to it.
   */
  registerWithCode(code: string, descriptor: AccountDeviceDescriptor, owner?: string): ReturnType<Store['issue']> {
    return this.transaction(() => {
      if (descriptor.role !== 'host') throw new ApiError('CODE_INVALID', 400)
      const normalized = code.trim().toUpperCase()
      const codeHash = hash(normalized)
      const record = Object.values(this.state.pairingCodes).find(entry =>
        timingSafeEqual(Buffer.from(entry.codeHash, 'hex'), Buffer.from(codeHash, 'hex')))
      if (!record) throw new ApiError('CODE_INVALID', 400)
      const scope = record.owner ?? owner ?? this.defaultOwner
      if (record.revokedAt) throw new ApiError('CODE_INVALID', 400)
      if (record.usedAt) throw new ApiError('CODE_USED', 409)
      if (record.expiresAt <= Date.now()) throw new ApiError('CODE_EXPIRED', 410)
      if (Object.keys(this.state.nodes).filter(id => !this.state.nodes[id]!.revoked).length >= 256) throw new ApiError('RATE_LIMITED', 429)
      const node = this.createNode(descriptor, scope)
      record.usedAt = Date.now()
      record.nodeId = node.id
      return this.registerDevice(descriptor, node.id, scope)
    })
  }

  /**
   * Register the opposite role with an existing device access token. The
   * upstream endpoint is symmetric (host token -> client identity, or client
   * token -> host identity); both identities are bound to the same node.
   */
  registerOwnedRole(descriptor: AccountDeviceDescriptor, sourceDeviceId: string, scope?: string): ReturnType<Store['issue']> {
    return this.transaction(() => {
      const source = this.get(sourceDeviceId, scope)
      if (source.descriptor.role === descriptor.role) throw new ApiError('INVALID_MESSAGE', 409)
      if (!source.nodeId) throw new ApiError('NODE_NOT_FOUND', 404)
      const node = this.getNode(source.nodeId, scope)
      const owner = node.owner ?? this.defaultOwner
      if (descriptor.role === 'host') {
        if (node.hostDeviceId !== '' && node.hostDeviceId !== descriptor.deviceId) throw new ApiError('NODE_HOST_CONFLICT', 409)
        node.hostDeviceId = descriptor.deviceId
      } else {
        if (node.clientDeviceId !== undefined && node.clientDeviceId !== descriptor.deviceId) throw new ApiError('NODE_CLIENT_CONFLICT', 409)
        node.clientDeviceId = descriptor.deviceId
      }
      return this.registerDevice(descriptor, node.id, owner)
    })
  }

  createPairingCode(label: string, platform?: string, ttlMs = PAIRING_TTL_MS, scope = this.defaultOwner) {
    return this.transaction(() => {
      const code = pairingCode()
      const id = randomUUID()
      const now = Date.now()
      for (const [key, value] of Object.entries(this.state.pairingCodes)) {
        if (value.expiresAt <= now || value.revokedAt || value.usedAt) {
          if (now - (value.usedAt ?? value.expiresAt) > 7 * 86400_000) delete this.state.pairingCodes[key]
        }
      }
      if (Object.keys(this.state.pairingCodes).length >= MAX_PAIRING_CODES) throw new ApiError('RATE_LIMITED', 429)
      const expiresAt = now + Math.max(60_000, Math.min(ttlMs, 24 * 3600_000))
      this.state.pairingCodes[id] = { id, codeHash: hash(code), label: label.slice(0, 120), platform, createdAt: now, expiresAt, owner: scope }
      this.save()
      return { id, code, label: label.slice(0, 120), platform, createdAt: now, expiresAt }
    })
  }

  listPairingCodes(scope?: string): Array<Omit<PairingCode, 'codeHash'>> {
    return Object.values(this.state.pairingCodes)
      .filter(record => scope === undefined || record.owner === scope)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 100)
      .map(({ codeHash: _hash, ...rest }) => rest)
  }

  revokePairingCode(id: string, scope?: string): void {
    const record = this.state.pairingCodes[id]
    if (!record) throw new ApiError('CODE_INVALID', 404)
    if (scope !== undefined && record.owner !== scope) throw new ApiError('CODE_INVALID', 404)
    record.revokedAt = Date.now()
    this.save()
  }

  /** Only the owning device may rename its node; the node name is canonical for both identities. */
  renameNodeForDevice(deviceId: string, name: string, scope?: string): MeshNode {
    return this.transaction(() => {
      const node = this.nodeForDevice(deviceId, scope)
      node.name = name.trim().slice(0, 80)
      for (const id of [node.hostDeviceId, node.clientDeviceId]) {
        if (!id) continue
        const device = this.state.devices[id]
        if (device) device.descriptor.name = node.name
      }
      this.save()
      return node
    })
  }

  revokeNode(nodeId: string, scope?: string): void {
    this.transaction(() => {
      const node = this.getNode(nodeId, scope)
      node.revoked = true
      for (const deviceId of [node.hostDeviceId, node.clientDeviceId]) {
        if (!deviceId) continue
        const device = this.state.devices[deviceId]
        if (!device) continue
        device.revoked = true
        for (const [key, value] of Object.entries(this.state.tokens)) if (value.deviceId === deviceId) delete this.state.tokens[key]
        this.onInvalidate(deviceId)
      }
      this.save()
    })
  }

  private issue(deviceId: string, refreshTokenExpiresAt = Date.now() + 30 * 86400_000, previous?: { token: string; record: SavedToken }) {
    const tokens = { ...this.state.tokens }
    for (const [key, value] of Object.entries(tokens)) if (value.expires <= Date.now()) delete tokens[key]
    if (Object.keys(tokens).length + 2 > 16384) throw new ApiError('RATE_LIMITED', 429)
    const accessTokenExpiresAt = Date.now() + 60 * 60_000
    const nonce = secret()
    const { accessToken, refreshToken } = previous
      ? successor(previous.token, nonce, deviceId)
      : { accessToken: secret(), refreshToken: secret() }
    if (previous) tokens[hash(previous.token)] = {
      ...previous.record, used: true, recovery: { nonce, accessExpires: accessTokenExpiresAt },
    }
    tokens[hash(accessToken)] = { kind: 'access', deviceId, expires: accessTokenExpiresAt, used: false }
    tokens[hash(refreshToken)] = { kind: 'refresh', deviceId, expires: refreshTokenExpiresAt, used: false }
    const before = this.state.tokens
    this.state.tokens = tokens
    // Commit consumption, recovery metadata and the successor together. A failed
    // write must leave the previous token usable both in memory and after restart.
    try { this.save() } catch (error) { this.state.tokens = before; throw error }
    return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }
  }
  authenticate(token: string): SavedDevice {
    const record = this.state.tokens[hash(token)]
    if (!record || record.kind !== 'access') throw new ApiError('AUTH_INVALID', 401)
    if (record.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
    return this.get(record.deviceId)
  }
  refresh(deviceId: string, token: string) {
    this.get(deviceId)
    const record = this.state.tokens[hash(token)]
    if (!record || record.kind !== 'refresh' || record.deviceId !== deviceId) throw new ApiError('AUTH_INVALID', 401)
    if (record.expires <= Date.now()) throw new ApiError('TOKEN_EXPIRED', 401)
    if (!record.used) return this.issue(deviceId, record.expires, { token, record })
    // Legacy consumed tokens have no recovery record. Reject them without
    // invalidating credentials that may already be in use by this device.
    if (!record.recovery) throw new ApiError('AUTH_INVALID', 401)
    const pair = successor(token, record.recovery.nonce, deviceId)
    const next = this.state.tokens[hash(pair.refreshToken)]
    if (!next || next.kind !== 'refresh' || next.deviceId !== deviceId || next.expires !== record.expires) {
      throw new ApiError('INTERNAL_ERROR', 503)
    }
    if (next.used) throw new ApiError('AUTH_INVALID', 401)
    const access = this.state.tokens[hash(pair.accessToken)]
    if (access ? access.kind !== 'access' || access.deviceId !== deviceId || access.expires !== record.recovery.accessExpires
      : record.recovery.accessExpires > Date.now()) throw new ApiError('INTERNAL_ERROR', 503)
    // Return the original expiry, including an expired access bearer. The
    // recovered, still-valid refresh token can then rotate normally.
    return { ...pair, accessTokenExpiresAt: record.recovery.accessExpires, refreshTokenExpiresAt: next.expires }
  }
  invalidate(deviceId: string): void {
    for (const [key, value] of Object.entries(this.state.tokens)) if (value.deviceId === deviceId) delete this.state.tokens[key]
    this.onInvalidate(deviceId)
    this.save()
  }
  revoke(id: string): void { this.get(id).revoked = true; this.invalidate(id) }
  rename(id: string, name: string): void {
    this.get(id).descriptor.name = name
    this.save()
  }
  touch(id: string, clientVersion?: string, harnessVersion?: string): void {
    const d = this.get(id)
    d.lastSeenAt = Date.now()
    if (clientVersion) d.descriptor.clientVersion = clientVersion.slice(0, 64)
    if (d.descriptor.role === 'host' && harnessVersion) d.descriptor.harnessVersion = harnessVersion.slice(0, 64)
    this.save()
  }
}