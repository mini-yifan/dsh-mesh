import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveMeshConfig } from '../src/config.js'
import { apply as applyDeviceAgent } from '../src/device-agent.js'
import { MeshService } from '../src/service.js'
import type { MeshState } from '../src/state.js'
import type { MeshNode, MeshTask } from '../src/types.js'

function fakeGateway(sessions: Array<{ sessionId: string; title: string; running: boolean; updatedAt: number }>, calls: Array<{ endpoint: string; payload: unknown }>) {
  return {
    async open(endpoint: string) {
      if (endpoint === 'workspace/follow') {
        return (async function* () {
          yield {
            type: 'baseline',
            value: {
              items: [{
                workspaceId: 'ws-1',
                path: '/work/ws-1',
                title: 'Workspace 1',
                sessionIds: sessions.map(s => s.sessionId),
              }],
            },
          }
        })()
      }
      throw new Error(`unexpected open: ${endpoint}`)
    },
    async dispatch(endpoint: string, payload: unknown) {
      calls.push({ endpoint, payload })
      if (endpoint === 'session/list') {
        return { ok: true as const, value: { items: sessions } }
      }
      return { ok: true as const, value: {} }
    },
  }
}

function setupService() {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-mesh-chat-'))
  const localCalls: Array<{ endpoint: string; payload: unknown }> = []
  const remoteCalls: Array<{ endpoint: string; payload: unknown }> = []
  const localGw = fakeGateway([{ sessionId: 'local-1', title: 'Local chat', running: false, updatedAt: 100 }], localCalls)
  const remoteGw = fakeGateway([
    { sessionId: 'normal-1', title: 'Normal chat', running: false, updatedAt: 200 },
    { sessionId: 'task-sess-1', title: 'Task chat', running: true, updatedAt: 300 },
  ], remoteCalls)

  const service = new MeshService(
    resolveMeshConfig({ stateDir, platform: 'darwin', deviceName: 'Mac' }),
    {
      supportsCarrier: false,
      async invoke() { return {} },
      dispatch: localGw.dispatch,
      open: localGw.open,
      failure(error: unknown) { return { code: 'INVALID_MESSAGE', message: String(error) } },
    },
    { debug() {}, info() {}, warn() {}, error() {} },
  )

  const task: MeshTask = {
    taskId: 'task-1',
    originNodeId: 'node-self',
    targetNodeId: 'node-remote',
    sessionId: 'task-sess-1',
    status: 'running',
    prompt: 'run task',
    files: [],
    createdAt: 100,
    updatedAt: 100,
  }
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
  ;(service as unknown as { localNode: MeshNode }).localNode = {
    nodeId: 'node-self',
    name: 'Mac',
    platform: 'darwin',
    online: true,
    hostDeviceId: 'host-self',
  }
  const nodes: MeshNode[] = [
    { nodeId: 'node-self', name: 'Mac', platform: 'darwin', online: true, hostDeviceId: 'host-self' },
    { nodeId: 'node-remote', name: 'Phone', platform: 'android', online: true, hostDeviceId: 'host-remote' },
    { nodeId: 'node-offline', name: 'Win', platform: 'win32', online: false, hostDeviceId: 'host-offline' },
  ]
  ;(service as unknown as { peers: unknown }).peers = {
    nodes: () => nodes,
    peer: (id: string) => id === 'node-remote'
      ? { status: 'online', gateway: remoteGw }
      : { status: 'offline', gateway: undefined },
  }
  return { service, remoteCalls, localCalls }
}

describe('remote normal session chat', () => {
  it('marks online remote sessions controllable and attaches taskId only to task sessions', async () => {
    const { service } = setupService()
    const tree = await service.tree()
    const selfNode = tree.nodes.find(n => n.nodeId === 'node-self')!
    const remoteNode = tree.nodes.find(n => n.nodeId === 'node-remote')!

    expect(selfNode.workspaces[0]?.sessions[0]).toMatchObject({
      sessionId: 'local-1',
      controllable: false,
    })
    expect(selfNode.workspaces[0]?.sessions[0]?.taskId).toBeUndefined()

    const normal = remoteNode.workspaces[0]?.sessions.find(s => s.sessionId === 'normal-1')
    const taskSess = remoteNode.workspaces[0]?.sessions.find(s => s.sessionId === 'task-sess-1')
    expect(normal).toMatchObject({ sessionId: 'normal-1', controllable: true })
    expect(normal?.taskId).toBeUndefined()
    expect(taskSess).toMatchObject({ sessionId: 'task-sess-1', controllable: true, taskId: 'task-1' })
  })

  it('prompts and cancels a normal remote session without mutating tasks', async () => {
    const { service, remoteCalls } = setupService()
    await service.prompt('node-remote', 'normal-1', 'hello normal')
    await service.cancel('node-remote', 'normal-1')

    expect(remoteCalls.some(c => c.endpoint === 'session/prompt')).toBe(true)
    expect(remoteCalls.some(c => c.endpoint === 'session/cancel')).toBe(true)
    expect(service.tasks()[0]?.status).toBe('running')
  })

  it('rejects prompting self or offline devices', async () => {
    const { service } = setupService()
    await expect(service.prompt('node-self', 'local-1', 'hi')).rejects.toMatchObject({ code: 'local_not_remote', status: 400 })
    await expect(service.prompt('node-offline', 'x', 'hi')).rejects.toMatchObject({ code: 'offline', status: 503 })
  })

  it('still keeps device_agent and device_agent_stop restricted to task sessions', async () => {
    const tools = new Map<string, any>()
    const mesh = {
      nodes: () => [{ nodeId: 'node-remote', name: 'Phone', platform: 'android', online: true, hostDeviceId: 'host-remote' }],
      tasks: () => [{ taskId: 'task-1', targetNodeId: 'node-remote', sessionId: 'task-sess-1', files: [] }],
      cancel: async () => {},
    }
    const ctx = {
      get: (name: string) => name === 'mesh' ? mesh : undefined,
      tools: { register: (def: any) => { tools.set(def.name, def) } },
    }
    applyDeviceAgent(ctx as never)
    const promptNormal = await tools.get('device_agent')!.execute(
      { device: 'Phone', task: 'continue', session_id: 'normal-1' },
      {},
    )
    expect(promptNormal).toMatchObject({ accepted: false, reason: 'session_not_remote_controllable' })

    const stopNormal = await tools.get('device_agent_stop')!.execute(
      { device: 'Phone', session_id: 'normal-1' },
      {},
    )
    expect(stopNormal).toEqual({ accepted: false })
  })
})
