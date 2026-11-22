import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { registerMeshRoutes } from '../src/routes.js'
import type { MeshService } from '../src/service.js'

/** Minimal request/response pair that records what the handler wrote. */
function harness() {
  const chunks: string[] = []
  let status = 0
  const res = {
    writeHead(code: number) { status = code },
    end(body?: string) { if (body !== undefined) chunks.push(body) },
  } as unknown as ServerResponse
  const req = { method: 'GET', url: '/.dsh-mesh/v1/status', headers: { host: '127.0.0.1:3080' } } as unknown as IncomingMessage
  return { req, res, get status() { return status }, body: () => chunks.join('') }
}

function fakeService(): MeshService {
  return { status: () => ({ paired: false, connection: 'unpaired', peersOnline: 0, peersTotal: 0 }) } as unknown as MeshService
}

describe('registerMeshRoutes authentication', () => {
  it('uses the connection supplied by the plugin Context when present', async () => {
    const requestRejection = vi.fn(() => undefined)
    const registered: Array<{ handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }> = []
    const webServer = { register: (route: never) => { registered.push(route); return () => undefined } }
    registerMeshRoutes(webServer, { requestRejection }, fakeService())
    const h = harness()
    await registered[0].handler(h.req, h.res)
    expect(requestRejection).toHaveBeenCalledOnce()
    expect(h.status).toBe(200)
  })

  it('falls back to the webServer Context connection on the phone', async () => {
    // The phone loads dsh-mesh as an app-level plugin: its own Context has no
    // `connection`, but the webServer's Context does. Without the fallback the
    // route answered 401 "This request is not authenticated." forever.
    const requestRejection = vi.fn(() => undefined)
    const registered: Array<{ handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }> = []
    const webServer = {
      register: (route: never) => { registered.push(route); return () => undefined },
      ctx: { get: (name: string, optional?: boolean) => name === 'connection' ? { requestRejection } : undefined },
    }
    registerMeshRoutes(webServer, undefined, fakeService())
    const h = harness()
    await registered[0].handler(h.req, h.res)
    expect(requestRejection).toHaveBeenCalledOnce()
    expect(h.status).toBe(200)
  })

  it('stays fail-closed when neither Context has a connection', async () => {
    const registered: Array<{ handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }> = []
    const webServer = { register: (route: never) => { registered.push(route); return () => undefined } }
    registerMeshRoutes(webServer, undefined, fakeService())
    const h = harness()
    await registered[0].handler(h.req, h.res)
    expect(h.status).toBe(401)
    expect(h.body()).toContain('This request is not authenticated')
  })

  it('resolves the webServer Context connection lazily, per request', async () => {
    // Reproduction of the phone bug: at registration time `connection` is not
    // in the webServer's Context yet (it arrives asynchronously). Resolving it
    // once during registration cached `undefined` and rejected every request.
    const requestRejection = vi.fn(() => undefined)
    let ready = false
    const registered: Array<{ handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }> = []
    const webServer = {
      register: (route: never) => { registered.push(route); return () => undefined },
      ctx: { get: () => ready ? { requestRejection } : undefined },
    }
    registerMeshRoutes(webServer, undefined, fakeService())
    ready = true // connection becomes available only after registration
    const h = harness()
    await registered[0].handler(h.req, h.res)
    expect(requestRejection).toHaveBeenCalledOnce()
    expect(h.status).toBe(200)
  })

  it('honours a rejection from the webServer Context connection', async () => {
    const registered: Array<{ handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }> = []
    const webServer = {
      register: (route: never) => { registered.push(route); return () => undefined },
      ctx: { get: () => ({ requestRejection: () => 403 }) },
    }
    registerMeshRoutes(webServer, undefined, fakeService())
    const h = harness()
    await registered[0].handler(h.req, h.res)
    expect(h.status).toBe(403)
  })

  it('does not register anything without a webServer', () => {
    expect(registerMeshRoutes(undefined, undefined, fakeService())()).toBeUndefined()
  })
})
