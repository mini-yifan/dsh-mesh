import { describe, expect, it } from 'vitest'
import { pickDefaultWorkspace } from '../src/device-agent.js'
import type { MeshSession, MeshWorkspace } from '../src/types.js'

function workspace(id: string, title: string, path: string, sessionCount = 0): MeshWorkspace {
  const sessions = Array.from({ length: sessionCount }, (_, index): MeshSession => ({
    sessionId: `${id}-${index}`,
    title: `session ${index}`,
    status: 'idle',
    controllable: false,
  }))
  return { workspaceId: id, title, path, sessions }
}

describe('device_agent default workspace', () => {
  it('prefers the floating-ball dsh_orb workspace over larger project workspaces', () => {
    const picked = pickDefaultWorkspace([
      workspace('project', 'dsh-orb-cordis', 'C:\\projects\\dsh-orb-cordis', 68),
      workspace('ball', 'dsh_orb', 'C:\\Users\\me\\.dsh\\dsh_orb', 81),
      workspace('other', '压缩机科研', 'E:\\压缩机科研', 10),
    ])
    expect(picked?.workspaceId).toBe('ball')
  })

  it('matches the default ball path on macOS and Windows', () => {
    expect(pickDefaultWorkspace([
      workspace('other', 'project', '/Users/me/work', 99),
      workspace('mac', 'dsh_orb', '/Users/me/.dsh/dsh_orb', 1),
    ])?.workspaceId).toBe('mac')
    expect(pickDefaultWorkspace([
      workspace('other', 'project', 'C:\\work', 99),
      workspace('win', 'dsh_orb', 'C:\\Users\\me\\.dsh\\dsh_orb', 1),
    ])?.workspaceId).toBe('win')
  })

  it('falls back to the busiest workspace when no dsh_orb exists', () => {
    const picked = pickDefaultWorkspace([
      workspace('small', 'small', '/work/small', 1),
      workspace('busy', 'busy', '/work/busy', 9),
    ])
    expect(picked?.workspaceId).toBe('busy')
  })
})