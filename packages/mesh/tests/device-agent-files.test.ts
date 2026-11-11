import { describe, expect, it } from 'vitest'
import { apply } from '../src/device-agent.js'

describe('device_agent attachments', () => {
  it('resolves relative paths from the caller workspace and forwards the receive root', async () => {
    const tools = new Map<string, any>()
    let options: any
    const mesh = {
      nodes: () => [{ nodeId: 'node-b', name: 'B', platform: 'linux', online: true, hostDeviceId: 'host-b' }],
      tasks: () => [],
      tree: async () => ({
        nodes: [{
          nodeId: 'node-b',
          name: 'B',
          platform: 'linux',
          online: true,
          hostDeviceId: 'host-b',
          workspaces: [{ workspaceId: 'ws-1', title: 'dsh_orb', path: '/B/.dsh/dsh_orb', sessions: [] }],
        }],
        cursor: 1,
      }),
      createTaskSession: async (_nodeId: string, _workspaceId: string, _text: string, next: unknown) => {
        options = next
        return {
          task: { taskId: 'task-1', sessionId: 'session-1', files: [] },
          workspaceId: 'ws-1',
        }
      },
    }
    const ctx = {
      get: (name: string) => name === 'mesh' ? mesh : undefined,
      tools: { register: (definition: any) => { tools.set(definition.name, definition) } },
    }
    apply(ctx as never)
    const result = await tools.get('device_agent')!.execute(
      { device: 'B', task: 'do the work', attachments: ['input/report.pdf'] },
      { agent: { session: { header: { cwd: '/A/.dsh/dsh_orb' } } } },
    )
    expect(result.accepted).toBe(true)
    expect(options.attachments).toEqual(['/A/.dsh/dsh_orb/input/report.pdf'])
    expect(options.receiveRoot).toBe('/A/.dsh/dsh_orb')
  })

  it('rejects attachments when continuing an existing task', async () => {
    const tools = new Map<string, any>()
    const mesh = {
      nodes: () => [{ nodeId: 'node-b', name: 'B', platform: 'linux', online: true, hostDeviceId: 'host-b' }],
      tasks: () => [{ taskId: 'task-1', targetNodeId: 'node-b', sessionId: 'session-1', files: [] }],
    }
    const ctx = {
      get: (name: string) => name === 'mesh' ? mesh : undefined,
      tools: { register: (definition: any) => { tools.set(definition.name, definition) } },
    }
    apply(ctx as never)
    const result = await tools.get('device_agent')!.execute(
      { device: 'B', task: 'continue', session_id: 'session-1', attachments: ['/A/input.pdf'] },
      { agent: { session: { header: { cwd: '/A' } } } },
    )
    expect(result).toMatchObject({ accepted: false, reason: 'attachments_require_new_task' })
  })
})