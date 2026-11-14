/**
 * Pairing-string parsing.
 *
 * Two deployment styles have to keep working:
 *
 *   - hosted / public certificate -> `fp` omitted, client uses the platform CA
 *     store;
 *   - self-hosted / self-signed    -> `fp` pins a 43-character SPKI digest.
 *
 * Loopback hosts resolve to plain HTTP so a local development server can be
 * paired without provisioning a certificate.
 */
import { describe, expect, it } from 'vitest'
import { parsePairing } from '../src/pair.js'

const DIGEST = 'A'.repeat(43)

describe('parsePairing', () => {
  it('accepts a pairing string without a fingerprint', () => {
    const parsed = parsePairing('dshmesh://mesh.example.com/pair?v=1&code=KJRM2H69')
    expect(parsed).toEqual({
      serverUrl: 'https://mesh.example.com',
      code: 'KJRM2H69',
      fingerprint: '',
    })
  })

  it('accepts an explicitly empty fp parameter', () => {
    const parsed = parsePairing('dshmesh://mesh.example.com/pair?v=1&code=KJRM2H69&fp=')
    expect(parsed.fingerprint).toBe('')
  })

  it('accepts and preserves a full fingerprint', () => {
    const parsed = parsePairing(`dshmesh://mesh.example.com/pair?v=1&code=KJRM2H69&fp=${DIGEST}`)
    expect(parsed.serverUrl).toBe('https://mesh.example.com')
    expect(parsed.fingerprint).toBe(DIGEST)
  })

  it('rejects a truncated fingerprint instead of silently downgrading', () => {
    // A short but non-empty value is a truncated copy, not "no pinning".
    expect(() => parsePairing('dshmesh://mesh.example.com/pair?v=1&code=KJRM2H69&fp=abc'))
      .toThrow(/fingerprint/)
  })

  it('keeps the port when one is present', () => {
    expect(parsePairing('dshmesh://mesh.example.com:8443/pair?v=1&code=KJRM2H69').serverUrl)
      .toBe('https://mesh.example.com:8443')
  })

  it('uses http for loopback hosts so local development works without TLS', () => {
    expect(parsePairing('dshmesh://localhost:8899/pair?v=1&code=KJRM2H69').serverUrl)
      .toBe('http://localhost:8899')
    expect(parsePairing('dshmesh://127.0.0.1:8080/pair?v=1&code=KJRM2H69').serverUrl)
      .toBe('http://127.0.0.1:8080')
  })

  it('normalizes the code to upper case', () => {
    expect(parsePairing('dshmesh://mesh.example.com/pair?v=1&code=kjrm2h69').code).toBe('KJRM2H69')
  })

  it('rejects a missing code', () => {
    expect(() => parsePairing('dshmesh://mesh.example.com/pair?v=1')).toThrow(/code/)
  })

  it('rejects an unsupported version and a wrong path', () => {
    expect(() => parsePairing('dshmesh://mesh.example.com/pair?v=2&code=KJRM2H69')).toThrow(/version/)
    expect(() => parsePairing('dshmesh://mesh.example.com/other?v=1&code=KJRM2H69')).toThrow(/dshmesh/)
  })

  it('rejects a non-dshmesh scheme', () => {
    expect(() => parsePairing('https://mesh.example.com/pair?v=1&code=KJRM2H69')).toThrow(/dshmesh/)
  })
})
