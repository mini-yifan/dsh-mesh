import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { WebSocket as WsWebSocket } from 'ws'
import type { FetchImplementation } from './server-api.js'
import type { WebSocketFactory } from './server-connection.js'

/**
 * v0 pins the Server's SPKI, not the certificate file. Rotating the
 * certificate while keeping the same key therefore does not require re-pairing.
 * The pairing string carries the fingerprint as unpadded base64url; curl and
 * other tools expect standard base64, so normalize before comparing.
 */
export function fingerprintBytes(fingerprint: string): Buffer {
  const normalized = fingerprint.trim().replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new Error('Invalid certificate fingerprint.')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  const bytes = Buffer.from(padded, 'base64')
  if (bytes.length !== 32) throw new Error('Certificate fingerprint must be a SHA-256 digest.')
  return bytes
}

function publicKeyBytes(certificate: PeerCertificate): Buffer {
  if (certificate.pubkey !== undefined) return certificate.pubkey
  return new X509Certificate(certificate.raw).publicKey.export({ type: 'spki', format: 'der' })
}

function verifyPinned(certificate: PeerCertificate, expected: Buffer): Error | undefined {
  const actual = createHash('sha256').update(publicKeyBytes(certificate)).digest()
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? undefined
    : new Error('Server certificate public key does not match the pinned fingerprint.')
}

/**
 * A `fetch` replacement for the device control plane. It is intentionally
 * small: the control plane only exchanges JSON, while file payloads use the
 * encrypted relay. Non-HTTPS URLs (local development) fall back to the platform
 * fetch so `mock`/localhost flows keep working without a certificate.
 */
export function createPinnedFetch(fingerprint: string): FetchImplementation {
  const expected = fingerprintBytes(fingerprint)
  const agent = new HttpsAgent({
    keepAlive: true,
    // v0 pins the SPKI instead of a public CA. The custom check below is the
    // authentication decision; a private CA or the system store is not required.
    rejectUnauthorized: false,
    checkServerIdentity: (host, certificate) => {
      const identity = checkServerIdentity(host, certificate)
      if (identity !== undefined) return identity
      return verifyPinned(certificate, expected)
    },
  })
  const pinned: FetchImplementation = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.protocol !== 'https:') return fetch(input, init)
    const method = init.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    const headers: Record<string, string> = {}
    new Headers(init.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined)).forEach((value, key) => { headers[key] = value })
    const body = init.body
    return await new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(url, { method, headers, agent, signal: init.signal ?? undefined }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        response.on('end', () => {
          const responseHeaders: Record<string, string> = {}
          for (const [key, value] of Object.entries(response.headers)) {
            if (value === undefined) continue
            responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value)
          }
          resolve(new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 502,
            statusText: response.statusMessage ?? '',
            headers: responseHeaders,
          }))
        })
        response.on('error', reject)
      })
      request.on('error', reject)
      if (body !== undefined && body !== null) {
        if (typeof body === 'string' || Buffer.isBuffer(body)) request.write(body)
        else reject(new Error('Pinned fetch only supports string or Buffer request bodies.'))
      }
      request.end()
    })
  }
  return pinned
}

/**
 * `ws` accepts the same TLS options as `https.request`, so the Host control
 * connection uses the identical SPKI check. The returned object is structurally
 * compatible with the DOM WebSocket surface used by AdaptiveTransport.
 */
export function createPinnedWebSocketFactory(fingerprint: string): WebSocketFactory {
  const expected = fingerprintBytes(fingerprint)
  const agent = new HttpsAgent({
    keepAlive: true,
    rejectUnauthorized: false,
    checkServerIdentity: (host, certificate) => {
      const identity = checkServerIdentity(host, certificate)
      if (identity !== undefined) return identity
      return verifyPinned(certificate, expected)
    },
  })
  return (url: string) => new WsWebSocket(url, { agent }) as unknown as ReturnType<WebSocketFactory>
}

/** Same pin, typed for the browser-shaped WebSocket used by AdaptiveTransport. */
export function createPinnedAdaptiveWebSocket(fingerprint: string): (url: string) => WebSocket {
  const factory = createPinnedWebSocketFactory(fingerprint)
  return url => factory(url) as unknown as WebSocket
}