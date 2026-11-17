import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveMeshConfig } from '../src/config.js'
import { resolveHostRuntimeConfig } from '../src/host.js'
import { MeshService, type MeshHostController } from '../src/service.js'
import type { MeshState } from '../src/state.js'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }

function makeService(host?: MeshHostController): MeshService {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-mesh-host-'))
  const service = new MeshService(
    resolveMeshConfig({ stateDir, platform: 'darwin', deviceName: 'Mac' }),
    {
      supportsCarrier: false,
      async invoke() { return {} },
      async dispatch() { return { ok: true, value: {} } },
      async open() { throw new Error('local stream unsupported') },
      failure(error: unknown) { return { code: 'INVALID_MESSAGE', message: String(error) } },
    },
    silentLogger,
    host,
  )
  const state: MeshState = {
    v: 1,
    serverUrl: 'https://mesh.example',
    fingerprint: 'fp',
    platform: 'darwin',
    pairedAt: Date.now(),
    prefs: { allowIncoming: true, allowedCallers: [], allowGuardedTools: false },
    tasks: [],
  }
  ;(service as unknown as { state: MeshState }).state = state
  return service
}

describe('MeshService host health reporting', () => {
  it('reports hostOnline false when the Host control socket is down', () => {
    const service = makeService({
      async start() {},
      async stop() {},
      hostStatus: () => ({ online: false, reconnecting: true }),
      reconnectHost: () => true,
    })
    const status = service.status()
    expect(status.connection).toBe('connected')
    expect(status.hostOnline).toBe(false)
    expect(status.hostReconnecting).toBe(true)
    // The node's own `online` flag must agree with the Host socket: otherwise a
    // machine whose Host silently retired itself looks healthy from its own UI.
    expect(status.node?.online).toBe(false)
  })

  it('surfaces the Host error so a rejected authorization is distinguishable', () => {
    const service = makeService({
      async start() {},
      async stop() {},
      hostStatus: () => ({ online: false, reconnecting: false, error: 'CONNECTION_REPLACED' }),
      reconnectHost: () => true,
    })
    expect(service.status().hostError).toBe('CONNECTION_REPLACED')
  })

  it('omits Host fields on a controller without a Host side', () => {
    const service = makeService({ async start() {}, async stop() {} })
    const status = service.status()
    expect(status.hostOnline).toBeUndefined()
    expect(status.hostError).toBeUndefined()
  })

  it('nudges a stuck Host reconnect but rate-limits repeated polls', () => {
    const reconnectHost = vi.fn(() => true)
    const service = makeService({
      async start() {},
      async stop() {},
      hostStatus: () => ({ online: false, reconnecting: false }),
      reconnectHost,
    })
    service.status()
    service.status()
    service.status()
    // A /status poll every few hundred ms must not become an authentication
    // storm against a Host whose authorization was terminally rejected.
    expect(reconnectHost).toHaveBeenCalledTimes(1)
  })

  it('does not nudge while a reconnect is already in flight', () => {
    const reconnectHost = vi.fn(() => true)
    const service = makeService({
      async start() {},
      async stop() {},
      hostStatus: () => ({ online: false, reconnecting: true }),
      reconnectHost,
    })
    service.status()
    expect(reconnectHost).not.toHaveBeenCalled()
  })

  it('does not nudge a healthy Host', () => {
    const reconnectHost = vi.fn(() => true)
    const service = makeService({
      async start() {},
      async stop() {},
      hostStatus: () => ({ online: true, reconnecting: false }),
      reconnectHost,
    })
    const status = service.status()
    expect(reconnectHost).not.toHaveBeenCalled()
    expect(status.hostOnline).toBe(true)
    expect(status.node?.online).toBe(true)
  })
})

describe('Host runtime reconnect policy', () => {
  const state: MeshState = {
    v: 1,
    serverUrl: 'https://mesh.example',
    fingerprint: '',
    platform: 'darwin',
    pairedAt: Date.now(),
    prefs: { allowIncoming: true, allowedCallers: [], allowGuardedTools: false },
    tasks: [],
  }

  it('keeps automatic reconnect enabled for the Host control socket', () => {
    const config = resolveHostRuntimeConfig(state, resolveMeshConfig({ stateDir: '/tmp/x', platform: 'darwin' }))
    // Regression guard: `reconnect: false` retires the Host for the whole
    // process after one dropped socket, which is exactly the reported symptom.
    expect(config.reconnect.enabled).toBe(true)
    expect(config.hostControl.enabled).toBe(true)
  })

  it('backoffs within the 4s-30s window so an outage cannot stampede', () => {
    const config = resolveHostRuntimeConfig(state, resolveMeshConfig({ stateDir: '/tmp/x', platform: 'darwin' }))
    expect(config.reconnect.initialDelayMs).toBe(4_000)
    expect(config.reconnect.maxDelayMs).toBe(30_000)
    expect(config.reconnect.jitter).toBeGreaterThan(0)
  })

  it('omits the fingerprint when the deployment uses a public CA', () => {
    const config = resolveHostRuntimeConfig(state, resolveMeshConfig({ stateDir: '/tmp/x', platform: 'darwin' }))
    expect(config.serverFingerprint).toBeUndefined()
  })
})
