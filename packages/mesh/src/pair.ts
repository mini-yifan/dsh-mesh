import { join } from 'node:path'
import {
  ClientServerApi,
  HostServerApi,
  IdentityStore,
  ServerApiError,
  ServerCredentialStore,
  createPinnedFetch,
  type ServerHostDevice,
} from 'ds-harness-remote/internal'
import type { MeshNode } from './types.js'
import type { ResolvedMeshConfig } from './config.js'
import {
  clearServerScoped,
  clearState,
  loadState,
  saveState,
  serverScopedDirectory,
  type MeshState,
} from './state.js'

export interface PairingInput {
  serverUrl: string
  code: string
  fingerprint: string
  name?: string
}

export class MeshPairError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const CODE_PATTERN = /^[A-Z0-9]{4,32}$/
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * An empty `fp` means the deployment serves a publicly trusted certificate and
 * the client verifies with the platform CA store. Self-hosted setups still pin a
 * self-signed SPKI, in which case `fp` must be a full 43-character digest.
 */
function validFingerprint(value: string): boolean {
  return value === '' || FINGERPRINT_PATTERN.test(value)
}

/**
 * The pairing scheme is scheme-less (`dshmesh://host/pair`), so the transport is
 * derived from the host. Loopback hosts are assumed to be a local development
 * server on plain HTTP; everything else is HTTPS.
 */
function originFor(host: string): string {
  const hostname = host.replace(/:\d+$/, '').toLowerCase()
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  return `${isLoopback ? 'http' : 'https'}://${host}`
}

export function parsePairing(raw: string): PairingInput {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new MeshPairError('bad_pairing', 'The pairing string is not a URL.')
  }
  if (url.protocol !== 'dshmesh:' || url.pathname !== '/pair') {
    throw new MeshPairError('bad_pairing', 'The pairing string must start with dshmesh://<host>/pair?.')
  }
  if ((url.searchParams.get('v') ?? '1') !== '1') throw new MeshPairError('bad_pairing', 'Unsupported pairing string version.')
  const code = (url.searchParams.get('code') ?? '').trim().toUpperCase()
  const fingerprint = (url.searchParams.get('fp') ?? '').trim()
  if (!CODE_PATTERN.test(code)) throw new MeshPairError('bad_pairing', 'The pairing code is missing or malformed.')
  if (!validFingerprint(fingerprint)) throw new MeshPairError('bad_pairing', 'The certificate fingerprint is malformed.')
  return { serverUrl: originFor(url.host), code, fingerprint }
}

function pairError(error: unknown): MeshPairError {
  if (error instanceof MeshPairError) return error
  if (error instanceof ServerApiError) {
    switch (error.code) {
      case 'CODE_INVALID': return new MeshPairError('code_invalid', 'The pairing code is invalid.')
      case 'CODE_USED': return new MeshPairError('code_used', 'The pairing code has already been used.')
      case 'CODE_EXPIRED': return new MeshPairError('code_expired', 'The pairing code has expired.')
      case 'RATE_LIMITED': return new MeshPairError('rate_limited', 'Too many attempts. Try again in a minute.')
      case 'PEER_IDENTITY_MISMATCH': return new MeshPairError('identity_mismatch', 'This device identity is already bound to another key.')
      case 'DEVICE_REVOKED': return new MeshPairError('revoked', 'This device was revoked. Generate a new pairing code.')
      case 'NODE_CLIENT_CONFLICT': return new MeshPairError('already_paired', 'This node already has a different Client identity.')
      default: return new MeshPairError('register_failed', error.message)
    }
  }
  if (error instanceof Error && /fetch|network|ECONN|ENOTFOUND|timeout/i.test(error.message)) {
    return new MeshPairError('unreachable', error.message)
  }
  return new MeshPairError('connect_failed', error instanceof Error ? error.message : 'Pairing failed.')
}

async function verifyServer(serverUrl: string, fingerprint: string): Promise<void> {
  const fetchImpl = createPinnedFetch(fingerprint)
  let response: Response
  try {
    response = await fetchImpl(`${serverUrl}/health`, { headers: { accept: 'application/json' } })
  } catch (error) {
    if (error instanceof Error && /fingerprint/i.test(error.message)) {
      throw new MeshPairError('fingerprint_mismatch', 'The server certificate does not match the pairing string.')
    }
    throw new MeshPairError('unreachable', error instanceof Error ? error.message : 'The server is unreachable.')
  }
  if (!response.ok) throw new MeshPairError('unreachable', `The server returned HTTP ${response.status}.`)
  const body = await response.json().catch(() => undefined) as { meshApi?: unknown } | undefined
  if (body?.meshApi !== 1) throw new MeshPairError('server_incompatible', 'The server does not expose meshApi 1.')
}

export interface PairResult {
  state: MeshState
  peers: ServerHostDevice[]
}

export async function pairMesh(config: ResolvedMeshConfig, input: PairingInput): Promise<PairResult> {
  const existing = loadState(config.stateDir)
  if (existing !== undefined && new URL(existing.serverUrl).origin !== new URL(input.serverUrl).origin) {
    throw new MeshPairError('already_paired', `This device is already paired to ${existing.serverUrl}. Exit mesh first.`)
  }
  await verifyServer(input.serverUrl, input.fingerprint)
  const scoped = serverScopedDirectory(config.stateDir, input.serverUrl)
  const resolvedName = input.name?.trim() || config.deviceName || `${config.platform}-node`
  const hostIdentityStore = new IdentityStore({ directory: join(scoped, 'host'), role: 'host' })
  const hostIdentity = await hostIdentityStore.loadOrCreate(resolvedName)
  const hostApi = new HostServerApi(
    input.serverUrl,
    new ServerCredentialStore(hostIdentityStore.directory),
    createPinnedFetch(input.fingerprint),
  )
  const resuming = existing?.pending === true && existing.serverUrl === input.serverUrl
  let hostCredentials
  try {
    if (resuming) {
      hostCredentials = await hostApi.authenticate(hostIdentity)
    } else {
      await hostApi.authorizeHostWithCode(hostIdentity, input.code)
      hostCredentials = await hostApi.authenticate(hostIdentity)
    }
  } catch (error) {
    throw pairError(error)
  }
  // Persist immediately after the one-time code is consumed. A crash before the
  // Client role is registered can then resume without spending another code.
  saveState(config.stateDir, {
    v: 1,
    serverUrl: input.serverUrl,
    fingerprint: input.fingerprint,
    platform: config.platform,
    pairedAt: existing?.pairedAt ?? Date.now(),
    pending: true,
    prefs: existing?.prefs ?? { allowIncoming: true, allowedCallers: [], allowGuardedTools: false },
    tasks: [],
  })
  const clientIdentityStore = new IdentityStore({ directory: join(scoped, 'client'), role: 'client' })
  const clientIdentity = await clientIdentityStore.loadOrCreate(resolvedName)
  const clientApi = new ClientServerApi(
    input.serverUrl,
    new ServerCredentialStore(clientIdentityStore.directory),
    createPinnedFetch(input.fingerprint),
  )
  try {
    await clientApi.authorizeOwnedRole(clientIdentity, hostCredentials.accessToken)
  } catch (error) {
    throw pairError(error)
  }
  let node: MeshNode
  try {
    node = await hostApi.nodeSelf<MeshNode>()
  } catch (error) {
    throw pairError(error)
  }
  const peers = await clientApi.listDevices().catch(() => [])
  const state: MeshState = {
    v: 1,
    serverUrl: input.serverUrl,
    fingerprint: input.fingerprint,
    node,
    platform: config.platform,
    pairedAt: existing?.pairedAt ?? Date.now(),
    prefs: existing?.prefs ?? { allowIncoming: true, allowedCallers: [], allowGuardedTools: false },
    tasks: existing?.tasks ?? [],
  }
  saveState(config.stateDir, state)
  return { state, peers }
}

export async function unpairMesh(config: ResolvedMeshConfig): Promise<void> {
  const state = loadState(config.stateDir)
  if (state === undefined) return
  const scoped = serverScopedDirectory(config.stateDir, state.serverUrl)
  try {
    const hostIdentityStore = new IdentityStore({ directory: join(scoped, 'host'), role: 'host' })
    const hostIdentity = await hostIdentityStore.loadOrCreate(config.deviceName ?? `${config.platform}-node`)
    const hostApi = new HostServerApi(
      state.serverUrl,
      new ServerCredentialStore(hostIdentityStore.directory),
      createPinnedFetch(state.fingerprint),
    )
    await hostApi.revokeNodeSelf().catch(() => undefined)
  } finally {
    clearState(config.stateDir)
    clearServerScoped(config.stateDir, state.serverUrl)
  }
}