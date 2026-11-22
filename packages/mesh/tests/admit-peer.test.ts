import { describe, expect, it } from 'vitest'
import { admitPeer } from '../src/host.js'

describe('admitPeer', () => {
  it('refuses everything when allowIncoming is off', () => {
    expect(admitPeer({ allowIncoming: false, allowedCallers: [] }, { deviceId: 'a', name: 'Mac' })).toBe(false)
    // An allow list must not override the master switch.
    expect(admitPeer({ allowIncoming: false, allowedCallers: ['a'] }, { deviceId: 'a', name: 'Mac' })).toBe(false)
  })

  it('admits any device on the account when the allow list is empty', () => {
    expect(admitPeer({ allowIncoming: true, allowedCallers: [] }, { deviceId: 'other', name: 'Phone' })).toBe(true)
  })

  it('admits only listed devices once the allow list is non-empty', () => {
    const prefs = { allowIncoming: true, allowedCallers: ['trusted-id'] }
    expect(admitPeer(prefs, { deviceId: 'trusted-id', name: 'Mac' })).toBe(true)
    expect(admitPeer(prefs, { deviceId: 'stranger', name: 'Phone' })).toBe(false)
  })

  it('accepts a display name as well as an id', () => {
    expect(admitPeer({ allowIncoming: true, allowedCallers: ['书房 Mac'] }, { deviceId: 'x', name: '书房 Mac' })).toBe(true)
  })

  it('ignores blank entries rather than locking everyone out', () => {
    expect(admitPeer({ allowIncoming: true, allowedCallers: ['', '   '] }, { deviceId: 'x', name: 'Mac' })).toBe(true)
  })
})

describe('isPathInsideHome', () => {
  it('accepts paths under the home directory', async () => {
    const { isPathInsideHome } = await import('../src/service.js')
    expect(isPathInsideHome('/Users/me/Downloads/dsh-mesh', '/Users/me')).toBe(true)
    expect(isPathInsideHome('/Users/me', '/Users/me')).toBe(true)
  })

  it('rejects traversal, sibling prefixes and system locations', async () => {
    const { isPathInsideHome } = await import('../src/service.js')
    expect(isPathInsideHome('/Users/me/../etc', '/Users/me')).toBe(false)
    expect(isPathInsideHome('/Users/mewtwo/Downloads', '/Users/me')).toBe(false)
    expect(isPathInsideHome('/etc/LaunchDaemons', '/Users/me')).toBe(false)
    expect(isPathInsideHome('relative/path', '/Users/me')).toBe(false)
    expect(isPathInsideHome('', '/Users/me')).toBe(false)
  })
})
