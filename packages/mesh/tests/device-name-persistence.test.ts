import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMeshConfig } from '../src/config.js'
import { resolveHostRuntimeConfig } from '../src/host.js'
import { MeshService } from '../src/service.js'
import { loadDeviceProfile, saveDeviceProfile, type MeshState } from '../src/state.js'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} }
const createdDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mesh-name-'))
  createdDirs.push(dir)
  return dir
}

function makeGateway() {
  return {
    supportsCarrier: false,
    async invoke() { return {} },
    async dispatch() { return { ok: true, value: {} } },
    async open() { throw new Error('local stream unsupported') },
    failure(error: unknown) { return { code: 'INVALID_MESSAGE', message: String(error) } },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true })
  }
})

describe('MeshService device name persistence', () => {
  it('reports default platform name before any custom name is saved', () => {
    const stateDir = tempDir()
    const service = new MeshService(
      resolveMeshConfig({ stateDir, platform: 'android' }),
      makeGateway(),
      silentLogger as never,
    )
    const status = service.status()
    expect(status.paired).toBe(false)
    expect(status.deviceName).toBe('android-node')
    expect(status.deviceNameSaved).toBe(false)
  })

  it('rejects empty device name on startLink and pair without persisting', async () => {
    const stateDir = tempDir()
    const service = new MeshService(
      resolveMeshConfig({ stateDir, platform: 'android' }),
      makeGateway(),
      silentLogger as never,
    )
    await expect(service.startLink('https://mesh.example', '   ')).rejects.toMatchObject({ code: 'invalid_name' })
    await expect(service.pair({
      serverUrl: 'https://mesh.example',
      code: 'ABCD1234',
      fingerprint: 'A'.repeat(43),
      name: '   ',
    })).rejects.toMatchObject({ code: 'invalid_name' })
    expect(loadDeviceProfile(stateDir)).toBeUndefined()
  })

  it('persists name on startLink, reconciles server-suffixed name on pollLink, revokes on unpair, and keeps it across unpair', async () => {
    const stateDir = tempDir()
    let registeredDeviceId = ''
    let nodeName = '我的手机2'
    const revokeHeaders: string[] = []

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      const headers = new Headers(init?.headers)
      const jsonResponse = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

      if (url.endsWith('/api/v1/link/start')) {
        registeredDeviceId = String(body.deviceId ?? 'dev-host')
        expect(body.deviceName).toBe('我的手机')
        return jsonResponse({
          linkId: 'link-1',
          nonce: 'nonce-1',
          approveUrl: 'https://mesh.example/link?t=link-1',
          expiresAt: Date.now() + 60_000,
        })
      }
      if (url.endsWith('/api/v1/link/collect')) {
        return jsonResponse({
          serverUrl: 'https://mesh.example',
          deviceId: registeredDeviceId,
          accessToken: 'access-token-1234567890abcdef',
          accessTokenExpiresAt: Date.now() + 3600_000,
          refreshToken: 'refresh-token-1234567890abcdef',
          refreshTokenExpiresAt: Date.now() + 86_400_000,
          account: { email: 'user@example.com', emailMasked: 'u***r@example.com' },
        })
      }
      if (url.endsWith('/api/v1/devices/register-owned-role')) {
        return jsonResponse({
          accessToken: 'client-access-token-1234567890',
          accessTokenExpiresAt: Date.now() + 3600_000,
          refreshToken: 'client-refresh-token-1234567890',
          refreshTokenExpiresAt: Date.now() + 86_400_000,
        })
      }
      if (url.endsWith('/api/v1/nodes/self') && init?.method === 'DELETE') {
        revokeHeaders.push(headers.get('authorization') ?? '')
        return jsonResponse({ status: 'revoked' })
      }
      if (url.endsWith('/api/v1/auth/token')) {
        return jsonResponse({
          accessToken: 'access-token-2345678901abcdef',
          accessTokenExpiresAt: Date.now() + 3600_000,
          refreshToken: 'refresh-token-2345678901abcdef',
          refreshTokenExpiresAt: Date.now() + 86_400_000,
        })
      }
      if (url.endsWith('/api/v1/nodes/self')) {
        return jsonResponse({
          nodeId: 'node-1',
          name: nodeName,
          platform: 'android',
          online: true,
          hostDeviceId: registeredDeviceId,
        })
      }
      if (url.endsWith(`/api/v1/devices/${encodeURIComponent(registeredDeviceId)}/name`)) {
        nodeName = `${String(body.name)}2`
        return jsonResponse({
          node: { nodeId: 'node-1', name: nodeName, platform: 'android', online: true, hostDeviceId: registeredDeviceId },
        })
      }
      if (url.endsWith('/api/v1/devices')) {
        return jsonResponse({ items: [] })
      }
      return jsonResponse({}, 404)
    }))

    const config = resolveMeshConfig({ stateDir, platform: 'android' })
    const service = new MeshService(config, makeGateway(), silentLogger as never)

    await service.startLink('https://mesh.example', '我的手机')
    // Saved immediately when user starts linking.
    expect(loadDeviceProfile(stateDir)?.deviceName).toBe('我的手机')
    expect(service.status().deviceName).toBe('我的手机')
    expect(service.status().deviceNameSaved).toBe(true)

    const linkedStatus = await service.pollLink()
    expect(linkedStatus?.paired).toBe(true)
    expect(linkedStatus?.node?.name).toBe('我的手机2')
    expect(linkedStatus?.deviceName).toBe('我的手机2')
    // Server-confirmed suffixed name overwrote local persistence.
    expect(loadDeviceProfile(stateDir)?.deviceName).toBe('我的手机2')

    const renamed = await service.rename('客厅平板')
    expect(renamed.name).toBe('客厅平板2')
    expect(loadDeviceProfile(stateDir)?.deviceName).toBe('客厅平板2')

    await service.unpair()
    // Must actually send an authenticated DELETE /api/v1/nodes/self before clearing local state.
    expect(revokeHeaders).toEqual(['Bearer access-token-1234567890abcdef'])
    const afterUnpair = service.status()
    expect(afterUnpair.paired).toBe(false)
    expect(afterUnpair.deviceName).toBe('客厅平板2')
    expect(afterUnpair.deviceNameSaved).toBe(true)

    // A fresh service instance after restart still sees the persisted name.
    const restarted = new MeshService(config, makeGateway(), silentLogger as never)
    expect(restarted.status().deviceName).toBe('客厅平板2')
    expect(restarted.status().deviceNameSaved).toBe(true)
    await service.stop()
    await restarted.stop()
  })

  it('prefers persisted device name over config fallback in resolveHostRuntimeConfig', () => {
    const stateDir = tempDir()
    saveDeviceProfile(stateDir, { deviceName: '书房主机' })
    const config = resolveMeshConfig({ stateDir, platform: 'darwin', deviceName: 'DefaultHost' })
    const state: MeshState = {
      v: 1,
      serverUrl: 'https://mesh.example',
      fingerprint: '',
      platform: 'darwin',
      pairedAt: Date.now(),
      prefs: { allowIncoming: true, allowedCallers: [], allowGuardedTools: false },
      tasks: [],
    }
    expect(resolveHostRuntimeConfig(state, config).deviceName).toBe('书房主机')
    expect(resolveHostRuntimeConfig({ ...state, node: { nodeId: 'n1', name: '书房主机2', platform: 'darwin', online: true, hostDeviceId: 'h1' } }, config).deviceName)
      .toBe('书房主机2')
  })
})
