import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMeshConfig } from '../src/config.js'
import { remoteCompletionText } from '../src/device-agent.js'
import { MeshService } from '../src/service.js'
import type { MeshState } from '../src/state.js'
import type { MeshTask } from '../src/types.js'

function makeService(task: MeshTask): MeshService {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-mesh-wait-'))
  const service = new MeshService(
    resolveMeshConfig({ stateDir, platform: 'darwin', deviceName: 'Mac' }),
    {
      supportsCarrier: false,
      async invoke() { return {} },
      async dispatch() { return { ok: true, value: {} } },
      async open() { throw new Error('local stream unsupported') },
      failure(error: unknown) { return { code: 'INVALID_MESSAGE', message: String(error) } },
    },
    { debug() {}, info() {}, warn() {}, error() {} },
  )
  const state: MeshState = {
    v: 1,
    serverUrl: 'https://mesh.example',
    fingerprint: 'fp',
    platform: 'darwin',
    pairedAt: Date.now(),
    prefs: { allowIncoming: true, allowedCallers: [], allowGuardedTools: false },
    tasks: [task],
  }
  ;(service as unknown as { state: MeshState }).state = state
  ;(service as unknown as {
    peers: { peer(): { status: string; gateway: { dispatch(): Promise<{ ok: true; value: { items: { sessionId: string; running: boolean }[] } }> } } }
  }).peers = {
    peer: () => ({
      status: 'online',
      gateway: {
        dispatch: async () => ({
          ok: true,
          value: { items: [{ sessionId: 'session-remote', running: false }] },
        }),
      },
    }),
  }
  return service
}

function task(status: MeshTask['status']): MeshTask {
  return {
    taskId: 'task-1',
    originNodeId: 'node-a',
    targetNodeId: 'node-b',
    sessionId: 'session-remote',
    status,
    prompt: 'test',
    files: [],
    createdAt: Date.now() - 10_000,
    updatedAt: Date.now() - 10_000,
  }
}

describe('remote task cancellation', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a user-stop terminal instead of overwriting it with done', async () => {
    vi.useFakeTimers()
    const service = makeService(task('cancelled'))
    const pending = service.waitTask('task-1', 10_000)
    await vi.advanceTimersByTimeAsync(2_500)
    const settled = await pending
    expect(settled.status).toBe('cancelled')
  })

  it('settles a persisted running task after two idle reconciliations', async () => {
    const service = makeService(task('running'))
    const reconcile = (service as unknown as { reconcileTasks(): Promise<void> }).reconcileTasks.bind(service)
    await reconcile()
    expect(service.tasks()[0]?.status).toBe('running')
    await reconcile()
    expect(service.tasks()[0]?.status).toBe('done')
  })

  it('tells the caller that a manual stop is terminal, without the retry invitation', () => {
    const running = task('running')
    const stopped = { ...running, status: 'cancelled' as const }
    const text = remoteCompletionText('win32-node', running, stopped, 'partial output')
    expect(text).toContain('用户已经在互联窗口手动停止了远程后台任务')
    expect(text).toContain('状态：用户已手动停止')
    expect(text).toContain('不要重新启动它')
    expect(text).toContain('不要再次调用 device_agent')
  })
})
describe('remote session live stream', () => {
  it('returns only durable events newer than the cursor', async () => {
    async function* frames() {
      yield {
        type: 'snapshot',
        cursor: 5,
        records: [{ type: 'event', event: { type: 'user/message', seq: 5, data: { text: 'hi' } } }],
      }
      yield { type: 'event', event: { type: 'assistant/message', seq: 6, data: { text: 'ok' } } }
      yield { type: 'assistant-stream', frame: { text: 'ignored' } }
      yield { type: 'event', event: { type: 'turn/end', seq: 7, data: { turn: 1 } } }
    }
    const service = makeService(task('running'))
    ;(service as unknown as {
      peers: { peer(): { status: string; gateway: { open(): Promise<AsyncIterable<unknown>> } } }
    }).peers = {
      peer: () => ({ status: 'online', gateway: { open: async () => frames() } }),
    }
    const first = await service.stream('node-b', 'session-remote', 4)
    expect(first.items.map(item => (item as { seq: number }).seq)).toEqual([5])
    expect(first.cursor).toBe(5)
    const second = await service.stream('node-b', 'session-remote', 5)
    expect(second.items.map(item => (item as { seq: number }).seq)).toEqual([6])
    expect(second.cursor).toBe(6)
  })
})
