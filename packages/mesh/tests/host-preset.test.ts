import { describe, expect, it } from 'vitest'
import { withIncomingPreset } from '../src/host.js'

describe('incoming preset injection', () => {
  it('adds agentPreset to a remote session/create request', () => {
    const payload = { args: { request: { workspaceId: 'ws-1' } } }
    expect(withIncomingPreset('session/create', payload, 'standard')).toEqual({
      args: { request: { workspaceId: 'ws-1', agentPreset: 'standard' } },
    })
  })

  it('overrides a caller-supplied preset', () => {
    const payload = { args: { request: { workspaceId: 'ws-1', agentPreset: 'computer-use' } } }
    expect(withIncomingPreset('session/create', payload, 'standard')).toEqual({
      args: { request: { workspaceId: 'ws-1', agentPreset: 'standard' } },
    })
  })

  it('leaves other endpoints and malformed payloads untouched', () => {
    const payload = { args: { request: { sessionId: 's-1' } } }
    expect(withIncomingPreset('session/prompt', payload, 'standard')).toBe(payload)
    expect(withIncomingPreset('session/create', undefined, 'standard')).toBeUndefined()
    expect(withIncomingPreset('session/create', { args: {} }, 'standard')).toEqual({ args: {} })
    expect(withIncomingPreset('session/create', payload, '')).toBe(payload)
  })
})