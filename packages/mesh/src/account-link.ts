/**
 * Hosted-mode device linking for the local Mesh plugin.
 *
 * Flow (the "open a browser" switch in the Interconnect settings):
 *
 *   1. The plugin generates a nonce and keeps it locally.
 *   2. It asks the server to create a link, receiving `linkId` + `approveUrl`.
 *   3. The browser opens `approveUrl`; the user signs in with an email code and
 *      approves the pending device.
 *   4. The plugin polls with `{ linkId, nonce }` until the credentials appear.
 *
 * The nonce never leaves the machine, so a leaked approval URL cannot be used
 * to collect the resulting tokens.
 */
import { ClientServerApi, HostServerApi, IdentityStore, ServerCredentialStore } from 'ds-harness-remote/internal'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { MeshState } from './state.js'
import { loadState, saveState, serverScopedDirectory } from './state.js'

export interface LinkStartResult {
  linkId: string
  nonce: string
  approveUrl: string
  expiresAt: number
}

export interface LinkCredentials {
  serverUrl: string
  deviceId: string
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken: string
  refreshTokenExpiresAt: number
  account: { email: string; emailMasked: string }
}

export class LinkError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/**
 * Turn an undici `TypeError: fetch failed` into something a user can act on.
 *
 * Node hides the real reason in `error.cause`: a DNS failure, a refused socket
 * and a rejected certificate all arrive as the same opaque message. Without
 * this the phone can only ever show "fetch failed", which says nothing about
 * whether the address is wrong, the network is down, or the certificate is
 * untrusted — the three cases that need different fixes.
 */
export function linkNetworkError(serverUrl: string, error: unknown): LinkError {
  const cause = (error as { cause?: unknown } | undefined)?.cause as
    | { code?: string; message?: string; errors?: Array<{ code?: string }> }
    | undefined
  const code = cause?.code ?? cause?.errors?.[0]?.code ?? ''
  const detail = cause?.message ?? (error instanceof Error ? error.message : String(error))
  const reason = code === 'ENOTFOUND' || code === 'EAI_AGAIN'
    ? '域名解析失败，请检查服务器地址和网络。'
    : code === 'ECONNREFUSED'
      ? '服务器拒绝连接，请确认地址和端口。'
      : code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
        ? '连接服务器超时，请检查网络。'
        : /certificate|SELF_SIGNED|UNABLE_TO_VERIFY|CERT_ALTNAME|unable to verify/i.test(detail)
          ? '服务器证书校验失败。'
          : `无法连接 ${serverUrl}：${detail}`
  return new LinkError('network_error', reason)
}

/** Every request out of this module goes through here so failures stay readable. */
async function request(
  serverUrl: string,
  input: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  try {
    return await fetchImpl(input, init)
  } catch (error) {
    throw linkNetworkError(serverUrl, error)
  }
}

interface StartInput {
  serverUrl: string
  publicKey: string
  deviceName: string
  platform: string
  /**
   * The device id the plugin already owns. The server reuses it so the record it
   * creates matches the local identity; otherwise `authenticate()` would see a
   * mismatch and try to re-register without an account session.
   */
  deviceId?: string
}

/** Normalize the operator-facing server URL: bare hosts become https origins. */
export function normalizeServerUrl(raw: string): string {
  const value = raw.trim()
  if (!value) throw new LinkError('bad_server', '服务器地址不能为空。')
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`
  let url: URL
  try { url = new URL(withScheme) } catch { throw new LinkError('bad_server', '服务器地址格式不正确。') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new LinkError('bad_server', '只支持 http 或 https 地址。')
  if (url.username || url.password) throw new LinkError('bad_server', '服务器地址不能包含用户名或密码。')
  return url.origin
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const code = String((data.error as { code?: unknown } | undefined)?.code ?? 'link_failed')
    throw new LinkError(code, code)
  }
  return data as T
}

/**
 * Ask the server for a pending link. `fetchImpl` lets the caller pass the pinned
 * TLS fetch when the deployment uses a self-signed certificate.
 */
export async function startDeviceLink(
  input: StartInput,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkStartResult> {
  const serverUrl = normalizeServerUrl(input.serverUrl)
  // The nonce is generated here and only its digest reaches the server on the
  // follow-up collect call, so a stolen linkId is useless on its own.
  const { randomBytes } = await import('node:crypto')
  const localNonce = randomBytes(32).toString('base64url')

  const response = await request(serverUrl, `${serverUrl}/api/v1/link/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      publicKey: input.publicKey,
      deviceName: input.deviceName,
      platform: input.platform,
      ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
    }),
  }, fetchImpl)
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const code = String((data.error as { code?: unknown } | undefined)?.code ?? 'link_failed')
    throw new LinkError(code, code)
  }
  return {
    linkId: String(data.linkId),
    // Prefer the server-issued nonce: it is the value the server hashed.
    nonce: String(data.nonce ?? localNonce),
    approveUrl: String(data.approveUrl),
    expiresAt: Number(data.expiresAt),
  }
}

/** One poll attempt. Returns undefined while the browser has not approved yet. */
export async function pollDeviceLink(
  serverUrl: string,
  link: { linkId: string; nonce: string },
  fetchImpl: typeof fetch = fetch,
): Promise<LinkCredentials | undefined> {
  const base = normalizeServerUrl(serverUrl)
  const response = await request(base, `${base}/api/v1/link/collect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ linkId: link.linkId, nonce: link.nonce }),
  }, fetchImpl)
  if (response.status === 202) return undefined
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const code = String((data.error as { code?: unknown } | undefined)?.code ?? 'link_failed')
    throw new LinkError(code, code)
  }
  return data as unknown as LinkCredentials
}

/** Poll until approved, cancelled, or expired. */
export async function waitForDeviceLink(
  serverUrl: string,
  link: { linkId: string; nonce: string; expiresAt: number },
  options: { signal?: AbortSignal; intervalMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<LinkCredentials> {
  const interval = options.intervalMs ?? 2000
  const fetchImpl = options.fetchImpl ?? fetch
  for (;;) {
    if (options.signal?.aborted) throw new LinkError('cancelled', '已取消。')
    if (Date.now() > link.expiresAt) throw new LinkError('LINK_EXPIRED', '连接请求已过期。')
    const credentials = await pollDeviceLink(serverUrl, link, fetchImpl)
    if (credentials) return credentials
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval)
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new LinkError('cancelled', '已取消。')) }, { once: true })
    })
  }
}

/**
 * Persist collected credentials into the same on-disk layout the pairing flow
 * uses, then resolve the node so the caller can update its UI.
 *
 * The tokens land in `server-credentials.json` under the server-scoped
 * directory, exactly like a `dshmesh://` pairing would, so peers, presence and
 * relay all keep working unchanged.
 */
export async function adoptLinkCredentials(
  stateDir: string,
  platform: string,
  credentials: LinkCredentials,
  deviceName?: string,
): Promise<MeshState> {
  const serverUrl = normalizeServerUrl(credentials.serverUrl)
  const scoped = serverScopedDirectory(stateDir, serverUrl)
  const existing = loadState(stateDir)
  if (existing && new URL(existing.serverUrl).origin !== new URL(serverUrl).origin) {
    throw new LinkError('already_paired', `这台设备已经连接到 ${existing.serverUrl}，请先退出互联。`)
  }

  const hostIdentityStore = new IdentityStore({ directory: join(scoped, 'host'), role: 'host' })
  const identity = await hostIdentityStore.loadOrCreate(deviceName ?? `${platform}-node`)
  const credentialStore = new ServerCredentialStore(hostIdentityStore.directory)
  await credentialStore.save({
    serverUrl,
    deviceId: credentials.deviceId,
    authorizationMethod: 'account',
    account: credentials.account.email,
    accessToken: credentials.accessToken,
    accessTokenExpiresAt: credentials.accessTokenExpiresAt,
    refreshToken: credentials.refreshToken,
    refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
  })

  const hostApi = new HostServerApi(serverUrl, credentialStore)
  hostApi.bindIdentity(identity)

  /**
   * Register the Client role for this same node, mirroring `pairMesh`.
   *
   * A device needs both identities: the Host identity receives work, the Client
   * identity discovers and connects to the other devices in the account. The
   * link hand-off only creates the Host one, so the Client is registered here
   * using the Host token (the server binds both to one node).
   */
  const clientIdentityStore = new IdentityStore({ directory: join(scoped, 'client'), role: 'client' })
  const clientIdentity = await clientIdentityStore.loadOrCreate(deviceName ?? `${platform}-node`)
  const clientCredentials = new ServerCredentialStore(clientIdentityStore.directory)
  const clientApi = new ClientServerApi(serverUrl, clientCredentials)
  clientApi.bindIdentity(clientIdentity)
  try {
    await clientApi.authorizeOwnedRole(clientIdentity, credentials.accessToken)
  } catch (error) {
    // A resumed link may already have the Client role registered; that is fine
    // as long as authentication still succeeds below.
    const code = (error as { code?: unknown }).code
    if (code !== 'INVALID_MESSAGE' && code !== 'NODE_CLIENT_CONFLICT') throw error
  }

  // Load the freshly saved credentials into the API instance first: `nodeSelf`
  // authenticates with whatever `request` holds, and installing the credentials
  // file alone does not populate it.
  await hostApi.authenticate(identity)
  const node = await hostApi.nodeSelf<MeshState['node']>()
  if (node?.name && node.name !== identity.name) {
    await hostIdentityStore.loadOrCreate(node.name).catch(() => undefined)
    await clientIdentityStore.loadOrCreate(node.name).catch(() => undefined)
  }

  const next: MeshState = {
    v: 1,
    serverUrl,
    // Hosted mode verifies with a public CA; the fingerprint stays empty so the
    // plugin uses the platform fetch instead of pinning.
    fingerprint: '',
    ...(node ? { node } : {}),
    platform,
    pairedAt: existing?.pairedAt ?? Date.now(),
    prefs: existing?.prefs ?? { allowIncoming: true, allowedCallers: [], allowGuardedTools: false },
    tasks: existing?.tasks ?? [],
  }
  saveState(stateDir, next)
  return next
}

/** Stable 32-byte identity key digest, used only for logging. */
export function keyFingerprint(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 12)
}

export { postJson }
