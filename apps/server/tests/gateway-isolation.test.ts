/**
 * Regression tests for the two gateway isolation fixes.
 * Kept in the suite: these guard the tenant boundary and the anti-DoS budget.
 */
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createRemoteServer, type Config } from '../src/server.js'
import { MAX_PENDING_PER_ADDRESS } from '../src/gateway.js'
import type { Mailer } from '../src/mailer.js'
import { DEFAULT_LIMITS } from '../src/account-store.js'

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

async function start(helloTimeoutMs = 5000) {
  mailer = new RecordingMailer()
  app = createRemoteServer({
    account: 'hosted@local',
    password: 'hosted-mode-no-admin-password',
    dataFile: join(dir, 'state.json'),
    publicUrl: 'http://localhost:8080',
    helloTimeoutMs,
    accounts: {
      env: {
        dataFile: join(dir, 'accounts.sqlite3'),
        pepper: 'test-pepper-that-is-long-enough-to-pass-validation',
        limits: { ...DEFAULT_LIMITS, sendCooldownSeconds: 0, emailSendsPerDay: 1000, ipSendsPerHour: 1000, ipSendsPerDay: 1000 },
        mail: { transport: 'console', appName: 'T', from: 'l@e.test' },
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

async function signIn(email: string): Promise<string> {
  const sent = await call('/auth/email/send', { body: { email } })
  const verified = await call('/auth/email/verify', {
    body: { email, challengeId: sent.data.challengeId, code: mailer.lastCode },
  })
  return cookieOf(verified.headers)
}

function key(seed: number): string {
  const bytes = Buffer.alloc(32, seed % 250)
  bytes[31] = 0x40
  return bytes.toString('base64url')
}
const id = (seed: number) => `00000000-0000-7000-8000-${seed.toString(16).padStart(12, '0')}`

async function register(cookie: string, seed: number, role: 'host' | 'client') {
  const response = await call('/devices/register', {
    body: { v: 1, device: { deviceId: id(seed), name: `dev-${seed}`, role, platform: 'linux', identityKey: key(seed + 5), clientVersion: 'a-1' } },
    cookie,
  })
  expect(response.status, JSON.stringify(response.data)).toBe(200)
  return response.data as { accessToken: string }
}

async function hello(deviceIdValue: string, role: 'host' | 'client', accessToken: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/v1/connect`)
  const frames: any[] = []
  await once(ws, 'open')
  ws.on('message', raw => { try { frames.push(JSON.parse(String(raw))) } catch { /* ignore */ } })
  ws.send(JSON.stringify({
    v: 1,
    id: `hello-${Math.random().toString(16).slice(2)}`,
    timestamp: Date.now(),
    type: 'hello',
    payload: { role, deviceId: deviceIdValue, accessToken, protocols: [1], capabilities: ['transport.relay', 'transport.p2p'], clientVersion: 'a-1' },
  }))
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !frames.some(f => f.type === 'hello.ack' || f.type === 'error')) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return { ws, frames }
}

const connectRequest = (ws: WebSocket, hostDeviceId: string) => ws.send(JSON.stringify({
  v: 1,
  id: `req-${Math.random().toString(16).slice(2)}`,
  timestamp: Date.now(),
  type: 'connect.request',
  payload: { hostDeviceId, preferredTransports: ['relay'] },
}))

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-isolation-')) })
afterEach(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }) })

describe('gateway tenant isolation', () => {
  it('never forwards connect.incoming across accounts', async () => {
    await start()
    const alice = await signIn('alice@example.com')
    const bob = await signIn('bob@example.com')
    const aliceHost = await register(alice, 1, 'host')
    const bobClient = await register(bob, 2, 'client')

    const host = await hello(id(1), 'host', aliceHost.accessToken)
    const client = await hello(id(2), 'client', bobClient.accessToken)
    expect(host.frames.some(f => f.type === 'hello.ack')).toBe(true)
    expect(client.frames.some(f => f.type === 'hello.ack')).toBe(true)

    connectRequest(client.ws, id(1))
    await new Promise(resolve => setTimeout(resolve, 400))

    // The cross-account request must not reach the Host at all.
    expect(host.frames.filter(f => f.type === 'connect.incoming')).toHaveLength(0)
    // And the caller learns nothing: same code as a missing device.
    expect(client.frames.filter(f => f.type === 'error').map(f => f.payload?.code)).toContain('CONNECTION_NOT_FOUND')

    host.ws.close(); client.ws.close()
  })

  it('still forwards a same-account connect.request', async () => {
    await start()
    const alice = await signIn('alice@example.com')
    const hostTok = await register(alice, 11, 'host')
    const clientTok = await register(alice, 12, 'client')

    const host = await hello(id(11), 'host', hostTok.accessToken)
    const client = await hello(id(12), 'client', clientTok.accessToken)
    expect(host.frames.some(f => f.type === 'hello.ack')).toBe(true)
    expect(client.frames.some(f => f.type === 'hello.ack')).toBe(true)

    connectRequest(client.ws, id(11))
    await new Promise(resolve => setTimeout(resolve, 400))

    expect(host.frames.filter(f => f.type === 'connect.incoming')).toHaveLength(1)

    host.ws.close(); client.ws.close()
  })
})

describe('unauthenticated socket budget', () => {
  it('idle sockets cannot exhaust the authenticated cap', async () => {
    await start(60_000)
    /*
     * Fill far beyond the per-address budget with idle handshakes. The gateway
     * evicts the oldest, so every upgrade still opens (the newcomer wins) and
     * no unauthenticated socket ever counts against the authenticated cap.
     */
    const idle: WebSocket[] = []
    let failedToOpen = 0
    for (let index = 0; index < MAX_PENDING_PER_ADDRESS + 8; index += 1) {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/v1/connect`)
      ws.on('error', () => undefined)
      const outcome = await new Promise<string>(resolve => {
        ws.once('open', () => resolve('open'))
        ws.once('unexpected-response', (_req, response) => resolve(`rejected:${response.statusCode}`))
        ws.once('close', () => resolve('closed'))
        setTimeout(() => resolve('timeout'), 2000)
      })
      if (outcome === 'open') idle.push(ws)
      else failedToOpen += 1
    }
    // A flood never locks the door: the newest connection is always admitted.
    expect(failedToOpen).toBe(0)

    // A real device can still authenticate while the idle sockets are held.
    const alice = await signIn('alice@example.com')
    const tok = await register(alice, 21, 'host')
    const real = await hello(id(21), 'host', tok.accessToken)
    expect(real.frames.some(f => f.type === 'hello.ack')).toBe(true)

    real.ws.close()
    for (const ws of idle) ws.terminate()
  })
})
