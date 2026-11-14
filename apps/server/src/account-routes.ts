/**
 * Hosted-mode HTTP routes.
 *
 * Registered alongside the v0 routes and only when `DSH_MESH_MODE=account`.
 * Responsibilities:
 *
 *   1. Email-code login for the web portal (register and login are one step).
 *   2. Device hand-off: the plugin creates a link, the browser approves it,
 *      the plugin collects the credentials by proving it holds the nonce.
 *   3. Account-scoped portal views: own devices, own pairing codes.
 *
 * Security invariants enforced here:
 *   - The link nonce never reaches the browser, so a leaked URL cannot collect
 *     tokens. It is only ever compared against its digest.
 *   - Portal endpoints derive the account from the session cookie, never from
 *     a client-supplied id.
 *   - Every store call passes the account scope, so a valid session cannot read
 *     another account's devices or pairing codes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { ApiError, type Store } from './store.js'
import { AccountError, AccountStore, type Limits } from './account-store.js'
import type { Mailer, MailSettings } from './mailer.js'
import { EmailRejected, maskEmail, normalizeEmail } from './account-config.js'

export interface AccountRouteDeps {
  store: Store
  accounts: AccountStore
  mailer: Mailer
  mail: MailSettings
  limits: Limits
  publicUrl: URL
  inviteCode?: string
  adminEmails: readonly string[]
  /** Resolve the client IP for rate limiting (proxy-aware; supplied by server.ts). */
  clientAddress(req: IncomingMessage): string
  /** Feed the fixed-window limiter owned by server.ts. */
  rate(key: string, max: number): void
  /** Real presence, so the portal never reports a disconnected device as online. */
  isOnline(deviceId: string): boolean
  body(req: IncomingMessage): Promise<unknown>
  json(res: ServerResponse, status: number, value: unknown): void
  /** Read the `dsh_session` cookie (the same name the v0 portal uses). */
  cookieToken(req: IncomingMessage): string
  setSessionCookie(res: ServerResponse, token: string, maxAgeSeconds: number): void
  clearSessionCookie(res: ServerResponse): void
  /** Hash helper shared with the v0 store so scopes match. */
  hash(value: string): string
}

const MAX_BODY = 16 * 1024
void MAX_BODY

const sendSchema = z.object({ email: z.string().min(3).max(320) }).strict()
const verifySchema = z.object({
  email: z.string().min(3).max(320),
  challengeId: z.string().min(16).max(128),
  code: z.string().regex(/^\d{6}$/),
}).strict()
const startLinkSchema = z.object({
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  deviceName: z.string().trim().min(1).max(80),
  platform: z.string().trim().min(1).max(32),
  /** The plugin's own device id (UUID or ULID); reused so its identity matches. */
  deviceId: z.string().regex(/^[0-9a-f-]{36}$|^[0-9A-HJKMNP-TV-Z]{26}$/i).optional(),
}).strict()
const approveLinkSchema = z.object({ linkId: z.string().uuid() }).strict()
const collectLinkSchema = z.object({
  linkId: z.string().uuid(),
  nonce: z.string().min(32).max(128),
}).strict()
const createPairingSchema = z.object({
  label: z.string().trim().min(1).max(120),
  platform: z.string().trim().max(32).optional(),
  ttlMinutes: z.number().int().min(1).max(1440).optional(),
}).strict()

type Ctx = { deps: AccountRouteDeps; accountId: string; email: string; ownerScope: string }

export function createAccountRoutes(deps: AccountRouteDeps) {
  const { accounts, store, mailer, limits, publicUrl, mail } = deps

  function scope(accountId: string): string { return deps.hash(accountId) }

  /** Resolve the signed-in account or throw. Never trusts a caller-supplied id. */
  function requireSession(req: IncomingMessage): Ctx {
    const token = deps.cookieToken(req)
    const account = accounts.accountForSession(token)
    if (!account) throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401)
    return { deps, accountId: account.accountId, email: account.email, ownerScope: scope(account.accountId) }
  }

  function nodeSummary(ctx: Ctx, node: ReturnType<Store['listNodes']>[number]) {
    const devices = [node.hostDeviceId, node.clientDeviceId]
      .filter((id): id is string => id !== undefined && id !== '')
      .map(id => store.list(ctx.ownerScope).find(device => device.descriptor.deviceId === id))
      .filter((device): device is NonNullable<typeof device> => device !== undefined)
    const host = devices.find(device => device.descriptor.deviceId === node.hostDeviceId)
    // Presence comes from the gateway, not from "a record exists".
    const online = devices.some(device => deps.isOnline(device.descriptor.deviceId))
    return {
      nodeId: node.id,
      name: node.name,
      platform: node.platform,
      createdAt: node.createdAt,
      hostDeviceId: node.hostDeviceId,
      clientDeviceId: node.clientDeviceId,
      harnessVersion: host !== undefined && 'harnessVersion' in host.descriptor ? host.descriptor.harnessVersion : undefined,
      appVersion: host?.descriptor.clientVersion,
      online,
      lastSeenAt: devices.reduce((latest, device) => Math.max(latest, device.lastSeenAt), 0) || undefined,
    }
  }

  /** Omit `fp` when the deployment serves a publicly trusted certificate. */
  function pairingString(code: string): string {
    const fingerprint = process.env.DSH_SERVER_CERT_FINGERPRINT?.trim() ?? ''
    const base = `dshmesh://${publicUrl.host}/pair?v=1&code=${encodeURIComponent(code)}`
    return fingerprint === '' ? base : `${base}&fp=${encodeURIComponent(fingerprint)}`
  }

  /**
   * Returns true when the request was handled. Keeps `server.ts` a flat switch
   * instead of nesting two routers.
   */
  async function handle(req: IncomingMessage, res: ServerResponse, path: string, method: string | undefined): Promise<boolean> {
    const client = deps.clientAddress(req)

    // ---------------------------------------------------------- public info

    if (method === 'GET' && path === '/api/v1/account/config') {
      deps.json(res, 200, {
        mode: 'account',
        serverUrl: publicUrl.origin,
        mail: { transport: mail.transport, appName: mail.appName },
        requiresInvite: deps.inviteCode !== undefined,
        codeTtlSeconds: limits.codeTtlSeconds,
        resendAfter: limits.sendCooldownSeconds,
      })
      return true
    }

    // ------------------------------------------------------- email codes

    if (method === 'POST' && path === '/api/v1/auth/email/send') {
      deps.rate(`email-send:${client}`, 20)
      const input = sendSchema.parse(await deps.body(req))
      let email: string
      try { email = normalizeEmail(input.email) } catch (error) {
        throw new ApiError(error instanceof EmailRejected ? 'INVALID_EMAIL' : 'INVALID_MESSAGE', 400)
      }
      const decision = accounts.reserveSend(email, client)
      if (!decision.allowed) {
        res.setHeader('Retry-After', String(decision.retryAfter))
        throw new ApiError(`RATE_LIMITED_${decision.reason.toUpperCase()}`, 429)
      }
      const challenge = accounts.createChallenge(email)
      try {
        await mailer.sendCode({ recipient: email, code: challenge.code, ttlSeconds: limits.codeTtlSeconds })
      } catch {
        // The reservation is already spent; surface a retryable error without
        // revealing provider internals.
        throw new ApiError('MAIL_UNAVAILABLE', 502)
      }
      deps.json(res, 200, {
        ok: true,
        challengeId: challenge.challengeId,
        emailMasked: maskEmail(email),
        expiresIn: limits.codeTtlSeconds,
        resendAfter: limits.sendCooldownSeconds,
      })
      return true
    }

    if (method === 'POST' && path === '/api/v1/auth/email/verify') {
      deps.rate(`email-verify:${client}`, 30)
      const input = verifySchema.parse(await deps.body(req))
      let email: string
      try { email = normalizeEmail(input.email) } catch { throw new ApiError('INVALID_EMAIL', 400) }
      const result = accounts.consumeChallenge(input.challengeId, email, input.code)
      if (!result.ok) {
        if (result.reason === 'locked') throw new ApiError('CODE_LOCKED', 429)
        if (result.reason === 'expired') throw new ApiError('CODE_EXPIRED', 410)
        throw new ApiError('CODE_INVALID', 400)
      }
      const { account, created } = accounts.upsertAccount(email)
      const session = accounts.createWebSession(account.accountId)
      deps.setSessionCookie(res, session.token, limits.sessionTtlSeconds)
      deps.json(res, 200, {
        ok: true,
        newAccount: created,
        account: { email: account.email, emailMasked: maskEmail(account.email), createdAt: account.createdAt },
        expiresAt: session.expiresAt,
      })
      return true
    }

    // ------------------------------------------------------- portal views

    if (method === 'GET' && path === '/api/v1/portal/me') {
      const ctx = requireSession(req)
      const account = accounts.findAccountByEmail(ctx.email)!
      deps.json(res, 200, {
        account: { email: account.email, emailMasked: maskEmail(account.email), createdAt: account.createdAt },
        isAdmin: deps.adminEmails.length === 0 || deps.adminEmails.includes(account.email),
        serverUrl: publicUrl.origin,
      })
      return true
    }

    if (method === 'GET' && path === '/api/v1/portal/devices') {
      const ctx = requireSession(req)
      const nodes = store.listNodes(ctx.ownerScope)
      deps.json(res, 200, { items: nodes.map(node => nodeSummary(ctx, node)), serverUrl: publicUrl.origin })
      return true
    }

    if (method === 'POST' && path === '/api/v1/portal/pairing-codes') {
      const ctx = requireSession(req)
      deps.rate(`pairing-create:${ctx.accountId}`, 30)
      const input = createPairingSchema.parse(await deps.body(req))
      const created = store.createPairingCode(input.label, input.platform, (input.ttlMinutes ?? 30) * 60_000, ctx.ownerScope)
      deps.json(res, 201, { ...created, pairing: pairingString(created.code) })
      return true
    }

    if (method === 'GET' && path === '/api/v1/portal/pairing-codes') {
      const ctx = requireSession(req)
      deps.json(res, 200, { items: store.listPairingCodes(ctx.ownerScope) })
      return true
    }

    const revokeCode = /^\/api\/v1\/portal\/pairing-codes\/([^/]+)$/.exec(path)
    if (method === 'DELETE' && revokeCode) {
      const ctx = requireSession(req)
      store.revokePairingCode(revokeCode[1]!, ctx.ownerScope)
      deps.json(res, 200, { status: 'revoked' })
      return true
    }

    if (method === 'POST' && path === '/api/v1/portal/devices/revoke') {
      const ctx = requireSession(req)
      const input = z.object({ nodeId: z.string().min(1).max(64) }).strict().parse(await deps.body(req))
      store.revokeNode(input.nodeId, ctx.ownerScope)
      deps.json(res, 200, { status: 'revoked' })
      return true
    }

    // -------------------------------------------------- device link hand-off

    if (method === 'POST' && path === '/api/v1/link/start') {
      deps.rate(`link-start:${client}`, 20)
      const input = startLinkSchema.parse(await deps.body(req))
      const started = accounts.startDeviceLink({
        publicKey: input.publicKey,
        deviceName: input.deviceName,
        platform: input.platform,
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
      })
      // The nonce is returned to the plugin only; the URL contains just linkId.
      deps.json(res, 200, {
        linkId: started.linkId,
        nonce: started.nonce,
        expiresAt: started.expiresAt,
        approveUrl: `${publicUrl.origin}/link?t=${started.linkId}`,
      })
      return true
    }

    if (method === 'GET' && path === '/api/v1/link/describe') {
      const linkId = new URL(req.url ?? '/', publicUrl).searchParams.get('linkId') ?? ''
      if (!/^[0-9a-f-]{36}$/i.test(linkId)) throw new ApiError('LINK_NOT_FOUND', 404)
      const described = accounts.describeLink(linkId)
      if (!described) throw new ApiError('LINK_NOT_FOUND', 404)
      deps.json(res, 200, described)
      return true
    }

    if (method === 'POST' && path === '/api/v1/link/approve') {
      const ctx = requireSession(req)
      const input = approveLinkSchema.parse(await deps.body(req))
      accounts.approveDeviceLink(input.linkId, ctx.accountId, ({ deviceId, publicKey, deviceName, platform }) => {
        // Register the device against the approving account and mint tokens.
        // `clientVersion` feeds the protocol descriptor, which requires a
        // non-empty string; a linked device has not reported a version yet.
        const issued = store.register(
          {
            deviceId,
            role: 'host',
            identityKey: publicKey,
            name: deviceName,
            platform,
            clientVersion: 'link-1',
            harnessVersion: 'link-1',
          } as never,
          ctx.ownerScope,
        )
        return { deviceId, ...issued }
      })
      deps.json(res, 200, { status: 'approved' })
      return true
    }

    if (method === 'POST' && path === '/api/v1/link/collect') {
      deps.rate(`link-collect:${client}`, 60)
      const input = collectLinkSchema.parse(await deps.body(req))
      const collected = accounts.collectDeviceLink(input.linkId, input.nonce)
      deps.json(res, 200, {
        serverUrl: publicUrl.origin,
        deviceId: collected.deviceId,
        accessToken: collected.accessToken,
        accessTokenExpiresAt: collected.accessTokenExpiresAt,
        refreshToken: collected.refreshToken,
        refreshTokenExpiresAt: collected.refreshTokenExpiresAt,
        account: { email: collected.account.email, emailMasked: maskEmail(collected.account.email) },
      })
      return true
    }

    // ------------------------------------------------------------ sign out

    if (method === 'POST' && path === '/api/v1/auth/signout') {
      accounts.deleteWebSession(deps.cookieToken(req))
      deps.clearSessionCookie(res)
      deps.json(res, 200, { status: 'ok' })
      return true
    }

    return false
  }

  return { handle, requireSession, scope, nodeSummary }
}

export { AccountError }
