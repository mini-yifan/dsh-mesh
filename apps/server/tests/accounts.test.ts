/**
 * Hosted-mode end-to-end tests.
 *
 * These cover the parts v0 never had: email-code login, the device hand-off,
 * and — most importantly — that one account can never observe or touch another
 * account's devices, nodes or pairing codes.
 *
 * Mail is intercepted: a fake Mailer records the code, so no network call and no
 * real address is involved.
 */
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRemoteServer, type Config } from '../src/server.js'
import type { Mailer } from '../src/mailer.js'
import { DEFAULT_LIMITS } from '../src/account-store.js'

class RecordingMailer implements Mailer {
  readonly sent: Array<{ recipient: string; code: string }> = []

  async sendCode(input: { recipient: string; code: string; ttlSeconds: number }): Promise<void> {
    this.sent.push({ recipient: input.recipient, code: input.code })
  }

  get lastCode(): string {
    const last = this.sent.at(-1)
    if (!last) throw new Error('no code was sent')
    return last.code
  }
}

class FailingMailer implements Mailer {
  async sendCode(): Promise<void> { throw new Error('provider down') }
}

let app: ReturnType<typeof createRemoteServer>
let dir: string
let base: string
let mailer: RecordingMailer

async function start(options: {
  mailer?: Mailer
  limits?: Partial<typeof DEFAULT_LIMITS>
  inviteCode?: string
  adminEmails?: string[]
} = {}) {
  mailer = new RecordingMailer()
  app = createRemoteServer({
    account: 'hosted@local',
    password: 'hosted-mode-no-admin-password',
    dataFile: join(dir, 'state.json'),
    publicUrl: 'http://localhost:8080',
    accounts: {
      env: {
        dataFile: join(dir, 'accounts.sqlite3'),
        pepper: 'test-pepper-that-is-long-enough-to-pass-validation',
        limits: { ...DEFAULT_LIMITS, ...options.limits },
        mail: { transport: 'console', appName: 'Test Mesh', from: 'login@example.test' },
        ...(options.inviteCode === undefined ? {} : { inviteCode: options.inviteCode }),
        adminEmails: options.adminEmails ?? [],
      },
      mailer: options.mailer ?? mailer,
    },
  } satisfies Config)
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
}

interface Reply<T = any> { status: number; data: T; headers: Headers }

async function call<T = any>(path: string, options: {
  method?: string
  body?: unknown
  cookie?: string
  token?: string
} = {}): Promise<Reply<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.cookie) headers.Cookie = options.cookie
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  const response = await fetch(`${base}/api/v1${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  return { status: response.status, data: await response.json() as T, headers: response.headers }
}

/** Extract only the `dsh_session=...` pair from a Set-Cookie header. */
function sessionCookie(headers: Headers): string {
  const raw = headers.get('set-cookie') ?? ''
  const match = /dsh_session=([^;]*)/.exec(raw)
  if (!match) throw new Error(`no session cookie in ${JSON.stringify(raw)}`)
  return `dsh_session=${match[1]}`
}

/** Sign a mailbox in and return its cookie plus the account payload. */
async function signIn(email: string): Promise<{ cookie: string; email: string }> {
  const sent = await call('/auth/email/send', { body: { email } })
  expect(sent.status, JSON.stringify(sent.data)).toBe(200)
  const verified = await call('/auth/email/verify', {
    body: { email, challengeId: sent.data.challengeId, code: mailer.lastCode },
  })
  expect(verified.status, JSON.stringify(verified.data)).toBe(200)
  return { cookie: sessionCookie(verified.headers), email }
}

function publicKey(seed: number): string {
  // 32 bytes base64url, ending in a character whose low bits are zero so it is
  // canonical (the protocol rejects non-canonical encodings).
  const bytes = Buffer.alloc(32, seed)
  bytes[31] = 0x40
  return bytes.toString('base64url')
}

async function approveDevice(cookie: string, seed: number, name = 'Mac1', platform = 'darwin') {
  const started = await call('/link/start', {
    body: { publicKey: publicKey(seed), deviceName: name, platform },
  })
  expect(started.status, JSON.stringify(started.data)).toBe(200)
  const approved = await call('/link/approve', { body: { linkId: started.data.linkId }, cookie })
  expect(approved.status, JSON.stringify(approved.data)).toBe(200)
  const collected = await call('/link/collect', {
    body: { linkId: started.data.linkId, nonce: started.data.nonce },
  })
  expect(collected.status, JSON.stringify(collected.data)).toBe(200)
  return { started: started.data, credentials: collected.data }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-accounts-'))
})

afterEach(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('account mode: configuration surface', () => {
  it('advertises account mode and the mail transport without leaking secrets', async () => {
    await start()
    const config = await call('/account/config')
    expect(config.status).toBe(200)
    expect(config.data.mode).toBe('account')
    expect(config.data.mail.transport).toBe('console')
    expect(JSON.stringify(config.data)).not.toMatch(/pepper|password|token/i)
  })

  it('keeps the v0 account endpoints closed', async () => {
    await start()
    // The email/password endpoints must stay unusable in account mode.
    const login = await call('/auth/login', { body: { email: 'a@b.c', password: 'x' } })
    expect([401, 404]).toContain(login.status)
  })
})

describe('account mode: email-code login', () => {
  it('registers on first verification and logs in on the second', async () => {
    await start({ limits: { sendCooldownSeconds: 0 } })
    const first = await signIn('owner@example.com')
    expect(first.cookie).toContain('dsh_session=')

    const me = await call('/portal/me', { cookie: first.cookie })
    expect(me.status).toBe(200)
    expect(me.data.account.email).toBe('owner@example.com')
    expect(me.data.account.emailMasked).toBe('o***r@example.com')

    // Same mailbox again: creation must report false.
    const sent = await call('/auth/email/send', { body: { email: 'owner@example.com' } })
    const verified = await call('/auth/email/verify', {
      body: { email: 'owner@example.com', challengeId: sent.data.challengeId, code: mailer.lastCode },
    })
    expect(verified.status).toBe(200)
    expect(verified.data.newAccount).toBe(false)
  })

  it('normalizes mixed-case addresses to one account', async () => {
    await start({ limits: { sendCooldownSeconds: 0 } })
    await signIn('Owner@Example.COM')
    const sent = await call('/auth/email/send', { body: { email: ' owner@example.com ' } })
    expect(sent.data.emailMasked).toBe('o***r@example.com')
    expect(mailer.sent.at(-1)!.recipient).toBe('owner@example.com')
  })

  it('rejects a wrong code and does not create a session', async () => {
    await start()
    const sent = await call('/auth/email/send', { body: { email: 'owner@example.com' } })
    const wrong = mailer.lastCode === '000000' ? '111111' : '000000'
    const verified = await call('/auth/email/verify', {
      body: { email: 'owner@example.com', challengeId: sent.data.challengeId, code: wrong },
    })
    expect(verified.status).toBe(400)
    expect(verified.data.error.code).toBe('CODE_INVALID')
  })

  it('consumes a code exactly once', async () => {
    await start()
    const sent = await call('/auth/email/send', { body: { email: 'owner@example.com' } })
    const body = { email: 'owner@example.com', challengeId: sent.data.challengeId, code: mailer.lastCode }
    expect((await call('/auth/email/verify', { body })).status).toBe(200)
    expect((await call('/auth/email/verify', { body })).status).toBe(400)
  })

  it('binds a challenge to its own mailbox', async () => {
    await start()
    const sent = await call('/auth/email/send', { body: { email: 'owner@example.com' } })
    const verified = await call('/auth/email/verify', {
      body: { email: 'other@example.com', challengeId: sent.data.challengeId, code: mailer.lastCode },
    })
    expect(verified.status).toBe(400)
  })

  it('invalidates the previous code when a new one is requested', async () => {
    await start({ limits: { sendCooldownSeconds: 0 } })
    const first = await call('/auth/email/send', { body: { email: 'owner@example.com' } })
    const firstCode = mailer.lastCode
    const second = await call('/auth/email/send', { body: { email: 'owner@example.com' } })

    const stale = await call('/auth/email/verify', {
      body: { email: 'owner@example.com', challengeId: first.data.challengeId, code: firstCode },
    })
    expect(stale.status).toBe(400)

    const fresh = await call('/auth/email/verify', {
      body: { email: 'owner@example.com', challengeId: second.data.challengeId, code: mailer.lastCode },
    })
    expect(fresh.status).toBe(200)
  })

  it('locks a challenge after the configured number of failures', async () => {
    await start({ limits: { maxVerifyFailures: 3 } })
    const sent = await call('/auth/email/send', { body: { email: 'owner@example.com' } })
    const body = { email: 'owner@example.com', challengeId: sent.data.challengeId, code: '999999' }
    const statuses: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) statuses.push((await call('/auth/email/verify', { body })).status)
    expect(statuses.slice(0, 2)).toEqual([400, 400])
    expect(statuses[2]).toBe(429)
  })

  it('enforces the per-mailbox cooldown', async () => {
    await start()
    expect((await call('/auth/email/send', { body: { email: 'owner@example.com' } })).status).toBe(200)
    const again = await call('/auth/email/send', { body: { email: 'owner@example.com' } })
    expect(again.status).toBe(429)
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('rejects disposable domains before spending quota', async () => {
    await start()
    const blocked = await call('/auth/email/send', { body: { email: 'someone@mailinator.com' } })
    expect(blocked.status).toBe(400)
    expect(mailer.sent).toHaveLength(0)
  })

  it('reports a retryable error when the mail provider fails', async () => {
    await start({ mailer: new FailingMailer() })
    const failed = await call('/auth/email/send', { body: { email: 'owner@example.com' } })
    expect(failed.status).toBe(502)
    expect(failed.data.error.code).toBe('MAIL_UNAVAILABLE')
  })

  it('does not disclose whether an address is registered', async () => {
    await start()
    const known = await call('/auth/email/send', { body: { email: 'owner@example.com' } })
    const unknown = await call('/auth/email/send', { body: { email: 'stranger@example.com' } })
    expect(known.status).toBe(unknown.status)
    expect(Object.keys(known.data).sort()).toEqual(Object.keys(unknown.data).sort())
  })
})

describe('account mode: device hand-off', () => {
  it('requires a session before approving a link', async () => {
    await start()
    const started = await call('/link/start', {
      body: { publicKey: publicKey(1), deviceName: 'Mac1', platform: 'darwin' },
    })
    const approved = await call('/link/approve', { body: { linkId: started.data.linkId } })
    expect(approved.status).toBe(401)
  })

  it('hands credentials to the plugin only after browser approval', async () => {
    await start()
    const owner = await signIn('owner@example.com')
    const started = await call('/link/start', {
      body: { publicKey: publicKey(7), deviceName: '书房 Mac', platform: 'darwin' },
    })
    expect(started.data.approveUrl).toContain(`/link?t=${started.data.linkId}`)
    // The browser URL must not carry the nonce.
    expect(started.data.approveUrl).not.toContain(started.data.nonce)

    const pending = await call('/link/collect', {
      body: { linkId: started.data.linkId, nonce: started.data.nonce },
    })
    expect(pending.status).toBe(202)
    expect(pending.data.error.code).toBe('LINK_PENDING')

    const described = await call(`/link/describe?linkId=${started.data.linkId}`)
    expect(described.data.deviceName).toBe('书房 Mac')
    expect(described.data.approved).toBe(false)

    expect((await call('/link/approve', { body: { linkId: started.data.linkId }, cookie: owner.cookie })).status).toBe(200)

    const collected = await call('/link/collect', {
      body: { linkId: started.data.linkId, nonce: started.data.nonce },
    })
    expect(collected.status).toBe(200)
    expect(collected.data.account.email).toBe('owner@example.com')
    expect(collected.data.accessToken.length).toBeGreaterThan(20)
    expect(collected.data.refreshToken.length).toBeGreaterThan(20)
    expect(collected.data.serverUrl).toBe('http://localhost:8080')

    // The credentials must actually authorize the device control plane.
    const me = await call('/me', { token: collected.data.accessToken })
    expect(me.status).toBe(200)
    expect(me.data.name).toBe('书房 Mac')
  })

  it('keeps describing a link after the plugin collected it', async () => {
    await start()
    const owner = await signIn('owner@example.com')
    const started = await call('/link/start', {
      body: { publicKey: publicKey(11), deviceName: '书房 Windows', platform: 'win32' },
    })
    await call('/link/approve', { body: { linkId: started.data.linkId }, cookie: owner.cookie })
    const collected = await call('/link/collect', {
      body: { linkId: started.data.linkId, nonce: started.data.nonce },
    })
    expect(collected.status).toBe(200)

    // The tab the user approved in may reload after the hand-off. Answering
    // "invalid request" there would report a failure that did not happen.
    const after = await call(`/link/describe?linkId=${started.data.linkId}`, { cookie: owner.cookie })
    expect(after.status).toBe(200)
    expect(after.data.approved).toBe(true)
    expect(after.data.consumed).toBe(true)
    expect(after.data.deviceId).toBe(collected.data.deviceId)
    // Same session that approved: the page can keep showing its device list.
    expect(after.data.approvedByViewer).toBe(true)
  })

  it('marks a link as approved by another account after switching', async () => {
    await start()
    const owner = await signIn('owner@example.com')
    const started = await call('/link/start', {
      body: { publicKey: publicKey(12), deviceName: '书房 Mac', platform: 'darwin' },
    })
    await call('/link/approve', { body: { linkId: started.data.linkId }, cookie: owner.cookie })

    // A different person signs in on the same browser and reopens the page.
    const other = await signIn('other@example.com')
    const described = await call(`/link/describe?linkId=${started.data.linkId}`, { cookie: other.cookie })
    expect(described.status).toBe(200)
    expect(described.data.approved).toBe(true)
    expect(described.data.approvedByViewer).toBe(false)
  })

  it('refuses to collect without the nonce, and only once with it', async () => {
    await start()
    const owner = await signIn('owner@example.com')
    const { started } = await approveDevice.bind(null, owner.cookie, 9)()
    void started
    const wrongNonce = await call('/link/collect', {
      body: { linkId: started.linkId, nonce: 'x'.repeat(43) },
    })
    expect(wrongNonce.status).toBe(404)

    // A fresh link: the first collect succeeds, the second is refused.
    const fresh = await call('/link/start', {
      body: { publicKey: publicKey(10), deviceName: 'Mac2', platform: 'darwin' },
    })
    await call('/link/approve', { body: { linkId: fresh.data.linkId }, cookie: owner.cookie })
    const first = await call('/link/collect', { body: { linkId: fresh.data.linkId, nonce: fresh.data.nonce } })
    expect(first.status).toBe(200)
    const second = await call('/link/collect', { body: { linkId: fresh.data.linkId, nonce: fresh.data.nonce } })
    expect(second.status).toBe(409)
  })

  it('registers the device id the plugin supplied, not a fresh one', async () => {
    await start()
    const owner = await signIn('owner@example.com')
    // The plugin already owns an identity; the server must reuse its id or the
    // two records diverge and later authentication fails with no credentials.
    const requested = '01a1d9d4-563f-7c66-a5bf-c5581af4e823'
    const started = await call('/link/start', {
      body: { publicKey: publicKey(70), deviceName: 'Aligned Mac', platform: 'darwin', deviceId: requested },
    })
    await call('/link/approve', { body: { linkId: started.data.linkId }, cookie: owner.cookie })
    const collected = await call('/link/collect', {
      body: { linkId: started.data.linkId, nonce: started.data.nonce },
    })
    expect(collected.status).toBe(200)
    expect(collected.data.deviceId).toBe(requested)
    // And the credentials work on the device control plane.
    const me = await call('/me', { token: collected.data.accessToken })
    expect(me.status).toBe(200)
    expect(me.data.deviceId).toBe(requested)
  })

  it('falls back to a generated id when the plugin omits one', async () => {
    await start()
    const owner = await signIn('owner@example.com')
    const { credentials } = await approveDevice(owner.cookie, 71, 'No Hint Mac')
    expect(typeof credentials.deviceId).toBe('string')
    expect(credentials.deviceId.length).toBeGreaterThan(20)
  })

  it('refuses a second approval for the same link', async () => {
    await start()
    const owner = await signIn('owner@example.com')
    const other = await signIn('other@example.com')
    const started = await call('/link/start', {
      body: { publicKey: publicKey(11), deviceName: 'Mac3', platform: 'darwin' },
    })
    expect((await call('/link/approve', { body: { linkId: started.data.linkId }, cookie: owner.cookie })).status).toBe(200)
    const steal = await call('/link/approve', { body: { linkId: started.data.linkId }, cookie: other.cookie })
    expect(steal.status).toBe(409)
  })

  it('hides a link that does not exist', async () => {
    await start()
    const missing = await call('/link/describe?linkId=00000000-0000-4000-8000-000000000000')
    expect(missing.status).toBe(404)
  })
})

describe('account mode: isolation', () => {
  it('reports a linked device as offline until its control connection is up', async () => {
    await start()
    const owner = await signIn('owner@example.com')
    await approveDevice(owner.cookie, 60, 'Idle Mac')
    const devices = await call('/portal/devices', { cookie: owner.cookie })
    expect(devices.data.items).toHaveLength(1)
    // No WebSocket control connection was opened, so presence must be false:
    // reporting "online" just because a row exists would mislead the user.
    expect(devices.data.items[0].online).toBe(false)
  })

  it('shows each account only its own devices', async () => {
    await start()
    const alice = await signIn('alice@example.com')
    const bob = await signIn('bob@example.com')
    await approveDevice(alice.cookie, 21, 'Alice Mac')
    await approveDevice(bob.cookie, 22, 'Bob Mac')

    const aliceDevices = await call('/portal/devices', { cookie: alice.cookie })
    const bobDevices = await call('/portal/devices', { cookie: bob.cookie })
    expect(aliceDevices.data.items.map((item: any) => item.name)).toEqual(['Alice Mac'])
    expect(bobDevices.data.items.map((item: any) => item.name)).toEqual(['Bob Mac'])
  })

  it('refuses to read another account device by id', async () => {
    await start()
    const alice = await signIn('alice@example.com')
    const bob = await signIn('bob@example.com')
    const { credentials } = await approveDevice(alice.cookie, 31, 'Alice Mac')
    // Bob's portal session must not resolve Alice's device.
    void credentials
    const aliceDevices = await call('/portal/devices', { cookie: alice.cookie })
    const aliceNodeId = aliceDevices.data.items[0].nodeId
    const revoke = await call('/portal/devices/revoke', { body: { nodeId: aliceNodeId }, cookie: bob.cookie })
    expect(revoke.status).toBe(404)
    // And Alice's device is still there.
    expect((await call('/portal/devices', { cookie: alice.cookie })).data.items).toHaveLength(1)
  })

  it('keeps pairing codes private per account', async () => {
    await start()
    const alice = await signIn('alice@example.com')
    const bob = await signIn('bob@example.com')
    const created = await call('/portal/pairing-codes', { body: { label: 'studio' }, cookie: alice.cookie })
    expect(created.status).toBe(201)
    expect(created.data.pairing).toContain('dshmesh://')

    expect((await call('/portal/pairing-codes', { cookie: bob.cookie })).data.items).toHaveLength(0)
    expect((await call('/portal/pairing-codes', { cookie: alice.cookie })).data.items).toHaveLength(1)

    // Bob cannot revoke Alice's code even with the id.
    const steal = await call(`/portal/pairing-codes/${created.data.id}`, { method: 'DELETE', cookie: bob.cookie })
    expect(steal.status).toBe(404)
  })

  it('does not let a client device enumerate another account hosts', async () => {
    await start()
    const alice = await signIn('alice@example.com')
    const bob = await signIn('bob@example.com')
    const aliceHost = await approveDevice(alice.cookie, 41, 'Alice Mac')
    await approveDevice(bob.cookie, 42, 'Bob Mac')

    // Turn Alice's host identity into a client so it may call /devices.
    const clientKey = publicKey(43)
    const registered = await call('/devices/register-owned-role', {
      body: {
        v: 1,
        device: {
          deviceId: randomUUID(),
          role: 'client',
          identityKey: clientKey,
          name: 'Alice Client',
          platform: 'darwin',
          clientVersion: '1.0.0',
        },
      },
      token: aliceHost.credentials.accessToken,
    })
    expect(registered.status, JSON.stringify(registered.data)).toBe(200)

    const hosts = await call('/devices', { token: registered.data.accessToken })
    expect(hosts.status).toBe(200)
    expect(hosts.data.items.map((item: any) => item.name)).toEqual(['Alice Mac'])
  })

  it('rejects a device token minted for a revoked account device', async () => {
    await start()
    const owner = await signIn('owner@example.com')
    const { credentials } = await approveDevice(owner.cookie, 51, 'Doomed Mac')
    const devices = await call('/portal/devices', { cookie: owner.cookie })
    const nodeId = devices.data.items[0].nodeId

    expect((await call('/portal/devices/revoke', { body: { nodeId }, cookie: owner.cookie })).status).toBe(200)
    const after = await call('/me', { token: credentials.accessToken })
    expect([401, 403]).toContain(after.status)
  })
})

describe('account mode: session lifecycle', () => {
  it('rejects portal calls without a cookie', async () => {
    await start()
    expect((await call('/portal/me')).status).toBe(401)
    expect((await call('/portal/devices')).status).toBe(401)
    expect((await call('/portal/pairing-codes')).status).toBe(401)
  })

  it('signs out and invalidates the cookie', async () => {
    await start()
    const owner = await signIn('owner@example.com')
    expect((await call('/portal/me', { cookie: owner.cookie })).status).toBe(200)
    expect((await call('/auth/signout', { body: {}, cookie: owner.cookie })).status).toBe(200)
    expect((await call('/portal/me', { cookie: owner.cookie })).status).toBe(401)
  })

  it('rejects a forged session cookie', async () => {
    await start()
    await signIn('owner@example.com')
    const forged = await call('/portal/me', { cookie: 'dsh_session=not-a-real-session-token' })
    expect(forged.status).toBe(401)
  })
})

describe('account mode: admin reports', () => {
  it('refuses the report to a signed-in non-administrator', async () => {
    await start({ adminEmails: ['boss@example.com'] })
    const owner = await signIn('owner@example.com')
    const me = await call('/portal/me', { cookie: owner.cookie })
    expect(me.data.isAdmin).toBe(false)
    const denied = await call('/admin/stats', { cookie: owner.cookie })
    expect(denied.status).toBe(403)
    expect(denied.data.error.code).toBe('ADMIN_REQUIRED')
  })

  it('treats an empty allow-list as "nobody is an administrator"', async () => {
    // The safe default: a deployment that forgot to configure admins must not
    // promote every account, which is what the old `length === 0 || includes`
    // check did.
    await start({ adminEmails: [] })
    const owner = await signIn('owner@example.com')
    expect((await call('/portal/me', { cookie: owner.cookie })).data.isAdmin).toBe(false)
    expect((await call('/admin/stats', { cookie: owner.cookie })).status).toBe(403)
  })

  it('counts accounts, devices and their platform split for an administrator', async () => {
    await start({ adminEmails: ['boss@example.com'] })
    const boss = await signIn('boss@example.com')
    expect((await call('/portal/me', { cookie: boss.cookie })).data.isAdmin).toBe(true)

    const owner = await signIn('owner@example.com')
    await approveDevice(owner.cookie, 21, '书房 Mac', 'darwin')
    await approveDevice(owner.cookie, 22, '书房 Windows', 'win32')

    const stats = await call('/admin/stats', { cookie: boss.cookie })
    expect(stats.status, JSON.stringify(stats.data)).toBe(200)
    expect(stats.data.users.total).toBe(2)
    // Neither device ever opened a gateway socket, so nothing is online.
    expect(stats.data.devices.total).toBe(2)
    expect(stats.data.devices.online).toBe(0)
    expect(stats.data.devices.byPlatform).toMatchObject({ darwin: 1, win32: 1 })
    // Approving a link registers the host role only; the client role appears
    // later, when the plugin calls register-owned-role with its credentials.
    // These devices never got that far, so there is one record per node.
    expect(stats.data.devices.deviceRecords).toBe(2)

    // The overview carries aggregates only; account rows come from their own
    // paged endpoint, so a server with many accounts never ships them here.
    expect(stats.data.list).toBeUndefined()

    const accounts = await call('/admin/accounts', { cookie: boss.cookie })
    expect(accounts.status, JSON.stringify(accounts.data)).toBe(200)
    expect(accounts.data.total).toBe(2)
    expect(accounts.data.limit).toBe(50)
    // Only masked addresses are returned; the page identifies rows by that.
    const ownerRow = accounts.data.items.find((user: { emailMasked: string }) => user.emailMasked === 'o***r@example.com')
    expect(ownerRow.devices).toBe(2)
    expect(ownerRow.devicesOnline).toBe(0)
    // Each account is listed once, with its own device count only.
    const bossRow = accounts.data.items.find((user: { emailMasked: string }) => user.emailMasked === 'b***s@example.com')
    expect(bossRow.devices).toBe(0)
    expect(bossRow.isAdmin).toBe(true)
    // No clear-text address may leave this endpoint.
    expect(JSON.stringify(accounts.data)).not.toContain('owner@example.com')
    expect(JSON.stringify(accounts.data)).not.toContain('boss@example.com')
  })

  it('reports a seven-day activity series with every day present', async () => {
    await start({ adminEmails: ['boss@example.com'] })
    const boss = await signIn('boss@example.com')

    const stats = await call('/admin/stats', { cookie: boss.cookie })
    expect(stats.status).toBe(200)
    expect(stats.data.activity).toHaveLength(7)
    for (const day of stats.data.activity) expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // A quiet day must be reported as zero rather than dropped, or the chart
    // would silently compress the timeline.
    expect(stats.data.activity.every((day: { codeRequests: number }) => typeof day.codeRequests === 'number')).toBe(true)
    // Today holds the one sign-in that created the administrator account.
    expect(stats.data.activity.at(-1).newAccounts).toBe(1)
  })
})

describe('account mode: admin account paging', () => {
  it('pages the account list and reports the real total', async () => {
    await start({ adminEmails: ['boss@example.com'], limits: { emailSendsPerDay: 50, sendCooldownSeconds: 0 } })
    const boss = await signIn('boss@example.com')
    await signIn('alpha@example.com')
    await signIn('bravo@example.com')

    const first = await call('/admin/accounts?limit=2&offset=0', { cookie: boss.cookie })
    expect(first.status, JSON.stringify(first.data)).toBe(200)
    // The total must cover every match, not just the page being returned.
    expect(first.data.total).toBe(3)
    expect(first.data.items).toHaveLength(2)

    const second = await call('/admin/accounts?limit=2&offset=2', { cookie: boss.cookie })
    expect(second.data.total).toBe(3)
    expect(second.data.items).toHaveLength(1)

    // Pages must not overlap.
    const seen = new Set([...first.data.items, ...second.data.items].map((user: { emailMasked: string }) => user.emailMasked))
    expect(seen.size).toBe(3)
  })

  it('filters by email and escapes LIKE wildcards', async () => {
    await start({ adminEmails: ['boss@example.com'], limits: { emailSendsPerDay: 50, sendCooldownSeconds: 0 } })
    const boss = await signIn('boss@example.com')
    await signIn('alice@example.com')
    await signIn('bob@example.com')

    const matched = await call('/admin/accounts?q=alice', { cookie: boss.cookie })
    expect(matched.data.total).toBe(1)
    expect(matched.data.items[0].emailMasked).toBe('a***e@example.com')

    // `%` is a wildcard in LIKE; a search for it must not match everything.
    const wildcard = await call('/admin/accounts?q=%25', { cookie: boss.cookie })
    expect(wildcard.data.total).toBe(0)

    const none = await call('/admin/accounts?q=zzz', { cookie: boss.cookie })
    expect(none.data.total).toBe(0)
    expect(none.data.items).toHaveLength(0)
  })

  it('clamps the page size and refuses non-administrators', async () => {
    await start({ adminEmails: ['boss@example.com'], limits: { emailSendsPerDay: 50, sendCooldownSeconds: 0 } })
    const boss = await signIn('boss@example.com')
    const owner = await signIn('owner@example.com')

    const huge = await call('/admin/accounts?limit=99999', { cookie: boss.cookie })
    expect(huge.status).toBe(200)
    // An unbounded limit would defeat the point of paging.
    expect(huge.data.limit).toBe(200)

    expect((await call('/admin/accounts', { cookie: owner.cookie })).status).toBe(403)
  })
})

describe('account mode: duplicate device name suffix', () => {
  it('appends an incrementing suffix when linking or renaming to a taken name in the same account', async () => {
    await start()
    const owner = await signIn('owner@example.com')

    const first = await approveDevice(owner.cookie, 31, '书房设备', 'darwin')
    const second = await approveDevice(owner.cookie, 32, '书房设备', 'android')
    const third = await approveDevice(owner.cookie, 33, '书房设备', 'win32')

    const firstMe = await call('/me', { token: first.credentials.accessToken })
    const secondMe = await call('/me', { token: second.credentials.accessToken })
    const thirdMe = await call('/me', { token: third.credentials.accessToken })
    expect(firstMe.data.name).toBe('书房设备')
    expect(secondMe.data.name).toBe('书房设备2')
    expect(thirdMe.data.name).toBe('书房设备3')

    // Renaming to its own current name stays unchanged; renaming to another node's name gets suffixed.
    const sameRename = await call(`/devices/${first.credentials.deviceId}/name`, {
      token: first.credentials.accessToken,
      body: { name: '书房设备' },
    })
    expect(sameRename.status).toBe(200)
    expect(sameRename.data.node.name).toBe('书房设备')

    const collisionRename = await call(`/devices/${third.credentials.deviceId}/name`, {
      token: third.credentials.accessToken,
      body: { name: '书房设备' },
    })
    expect(collisionRename.status).toBe(200)
    expect(collisionRename.data.node.name).toBe('书房设备3')

    const secondCollision = await call(`/devices/${second.credentials.deviceId}/name`, {
      token: second.credentials.accessToken,
      body: { name: '书房设备' },
    })
    expect(secondCollision.status).toBe(200)
    expect(secondCollision.data.node.name).toBe('书房设备2')

    // Revoking the first node frees the exact name so a rejoining device reclaims '书房设备'.
    const revoked = await call('/nodes/self', { method: 'DELETE', token: first.credentials.accessToken })
    expect(revoked.status).toBe(200)
    const rejoined = await approveDevice(owner.cookie, 34, '书房设备', 'darwin')
    const rejoinedMe = await call('/me', { token: rejoined.credentials.accessToken })
    expect(rejoinedMe.data.name).toBe('书房设备')
  })
})
