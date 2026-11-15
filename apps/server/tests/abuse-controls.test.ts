/**
 * Regression tests for the hosted-mode abuse fixes:
 *  - invite codes actually gate registration
 *  - device quotas are per account, so one tenant cannot lock out another
 */
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRemoteServer, type Config } from '../src/server.js'
import type { Mailer } from '../src/mailer.js'
import { DEFAULT_LIMITS } from '../src/account-store.js'
import { MAX_DEVICES_PER_OWNER } from '../src/store.js'

class RecordingMailer implements Mailer {
  readonly sent: Array<{ recipient: string; code: string }> = []
  async sendCode(input: { recipient: string; code: string; ttlSeconds: number }): Promise<void> {
    this.sent.push({ recipient: input.recipient, code: input.code })
  }
  get lastCode(): string { return this.sent.at(-1)!.code }
}

let app: ReturnType<typeof createRemoteServer>
let dir: string
let base: string
let mailer: RecordingMailer

async function start(options: { inviteCode?: string } = {}) {
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
        limits: { ...DEFAULT_LIMITS, sendCooldownSeconds: 0, emailSendsPerDay: 1000, ipSendsPerHour: 1000, ipSendsPerDay: 1000 },
        mail: { transport: 'console', appName: 'T', from: 'l@e.test' },
        ...(options.inviteCode === undefined ? {} : { inviteCode: options.inviteCode }),
        adminEmails: [],
      },
      mailer,
    },
  } satisfies Config)
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
}

async function call<T = any>(path: string, options: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.cookie) headers.Cookie = options.cookie
  const response = await fetch(`${base}/api/v1${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  return { status: response.status, data: await response.json() as T, headers: response.headers }
}

const cookieOf = (headers: Headers) =>
  `dsh_session=${/dsh_session=([^;]*)/.exec(headers.get('set-cookie') ?? '')?.[1]}`

/** Send + verify in one go; returns the verify reply so callers can assert on it. */
async function signIn(email: string, inviteCode?: string) {
  const sent = await call('/auth/email/send', {
    body: { email, ...(inviteCode === undefined ? {} : { inviteCode }) },
  })
  expect(sent.status, JSON.stringify(sent.data)).toBe(200)
  const verified = await call('/auth/email/verify', {
    body: { email, challengeId: sent.data.challengeId, code: mailer.lastCode },
  })
  return { verified, cookie: verified.status === 200 ? cookieOf(verified.headers) : undefined }
}

function identityKey(seed: number): string {
  const bytes = Buffer.alloc(32, seed % 250)
  bytes[31] = 0x40
  return bytes.toString('base64url')
}
const deviceId = (seed: number) => `00000000-0000-7000-8000-${seed.toString(16).padStart(12, '0')}`
const device = (seed: number) => ({
  deviceId: deviceId(seed), name: `d-${seed}`, role: 'host' as const, platform: 'linux',
  identityKey: identityKey(seed + 3), clientVersion: 't-1',
})

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-invite-')) })
afterEach(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })

describe('invite codes', () => {
  it('refuses to register a new mailbox without the configured code', async () => {
    await start({ inviteCode: 'ONLY-THIS-CODE' })
    const { verified } = await signIn('stranger@example.com')
    expect(verified.status).toBe(403)
    expect(verified.data.error.code).toBe('INVITE_REQUIRED')
  })

  it('refuses a wrong code without revealing the expected one', async () => {
    await start({ inviteCode: 'ONLY-THIS-CODE' })
    const { verified } = await signIn('stranger2@example.com', 'wrong-code')
    expect(verified.status).toBe(403)
    expect(verified.data.error.code).toBe('INVITE_REQUIRED')
    expect(JSON.stringify(verified.data)).not.toContain('ONLY-THIS-CODE')
  })

  it('registers with the right code, then lets that mailbox sign in without one', async () => {
    await start({ inviteCode: 'ONLY-THIS-CODE' })
    const first = await signIn('member@example.com', 'ONLY-THIS-CODE')
    expect(first.verified.status).toBe(200)

    // Second sign-in: no invite code presented, existing account must still work.
    const again = await signIn('member@example.com')
    expect(again.verified.status).toBe(200)
  })

  it('leaves registration open when no code is configured', async () => {
    await start()
    const { verified } = await signIn('anyone@example.com')
    expect(verified.status).toBe(200)
  })
})

describe('per-account device quota', () => {
  it('one tenant filling its quota does not block another tenant', async () => {
    await start()
    const attacker = (await signIn('attacker@example.com')).cookie!
    const victim = (await signIn('victim@example.com')).cookie!

    for (let index = 0; index < MAX_DEVICES_PER_OWNER; index += 1) {
      const registered = await call('/devices/register', { body: { v: 1, device: device(index + 1) }, cookie: attacker })
      expect(registered.status, `device ${index}: ${JSON.stringify(registered.data)}`).toBe(200)
    }
    const overQuota = await call('/devices/register', { body: { v: 1, device: device(900) }, cookie: attacker })
    expect(overQuota.status).toBe(429)
    expect(overQuota.data.error.code).toBe('DEVICE_QUOTA_EXCEEDED')

    // The other account is untouched by the first one hitting its ceiling.
    const victimRegister = await call('/devices/register', { body: { v: 1, device: device(901) }, cookie: victim })
    expect(victimRegister.status, JSON.stringify(victimRegister.data)).toBe(200)
  })
})
