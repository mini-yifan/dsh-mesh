import type { IncomingMessage, ServerResponse } from 'node:http'
import { parsePairing, type PairingInput } from './pair.js'
import { MeshError, type MeshService } from './service.js'

export const MESH_ROUTE_PREFIX = '/.dsh-mesh/v1'

interface WebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  }): () => void | Promise<void>
}

interface ConnectionLike {
  requestRejection?(request: { headers: IncomingMessage['headers'] }): number | undefined
}

const MAX_BODY = 64 * 1024

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new MeshError('invalid_message', 'Content-Type must be application/json.', 415)
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new MeshError('frame_too_large', 'Request body is too large.', 413)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new MeshError('invalid_message', 'Request body is not JSON.', 400)
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function registerMeshRoutes(
  webServer: WebServerLike | undefined,
  connection: ConnectionLike | undefined,
  service: MeshService,
): () => void {
  if (webServer === undefined) {
    const dispose = () => undefined
    return dispose
  }
  return webServer.register({
    kind: 'prefix',
    path: MESH_ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        /*
         * Fail closed. These routes expose pairing, prefs, session prompts and a
         * Computer Use test hook; each one is a privileged local action. The
         * host's own connection service normally guards them, so a missing
         * service or a missing method means the guard cannot run — and treating
         * that as "allowed" would turn a version skew into a local
         * privilege-escalation hole.
         */
        const rejection = typeof connection?.requestRejection === 'function'
          ? connection.requestRejection({ headers: req.headers })
          : 401
        if (rejection !== undefined) {
          json(res, rejection, { error: 'unauthorized', message: 'This request is not authenticated.' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const path = url.pathname.slice(MESH_ROUTE_PREFIX.length) || '/'
        const method = req.method ?? 'GET'
        if (method === 'GET' && path === '/status') { json(res, 200, service.status()); return }
        if (method === 'POST' && path === '/pair') {
          const input = record(await body(req))
          const pairing: PairingInput = typeof input.pairing === 'string'
            ? parsePairing(input.pairing)
            : {
                serverUrl: String(input.serverUrl ?? '').trim(),
                code: String(input.code ?? '').trim(),
                fingerprint: String(input.fingerprint ?? '').trim(),
              }
          if (pairing.serverUrl === '' || pairing.code === '' || pairing.fingerprint === '') {
            throw new MeshError('bad_pairing', 'serverUrl, code and fingerprint are required.')
          }
          json(res, 200, await service.pair(pairing)); return
        }
        if (method === 'POST' && path === '/unpair') { await service.unpair(); json(res, 200, service.status()); return }
        if (method === 'POST' && path === '/link') {
          // Step 1: create the pending link and return the approval URL at once.
          // It must not wait for approval: the caller needs this URL to open the
          // browser, so blocking here would deadlock the UI.
          const input = record(await body(req))
          json(res, 200, await service.startLink(
            String(input.serverUrl ?? '').trim(),
            typeof input.name === 'string' ? input.name.trim() : undefined,
          ))
          return
        }
        if (method === 'POST' && path === '/link/finish') {
          // Step 2: wait for the browser approval and adopt the credentials.
          // The UI calls this after opening the browser and shows a spinner.
          json(res, 200, await service.finishLink())
          return
        }
        if (method === 'POST' && path === '/link/poll') {
          // Step 2 for a mobile client: one collect attempt. A phone must not
          // hold a request open for the whole approval, because the app is
          // suspended in the background and its HTTP client has a deadline.
          const status = await service.pollLink()
          json(res, 200, status === undefined ? { pending: true } : { pending: false, status })
          return
        }
        if (method === 'POST' && path === '/link/cancel') {
          json(res, 200, service.cancelLink()); return
        }
        if (method === 'GET' && path === '/link/status') {
          json(res, 200, service.pendingLinkStatus()); return
        }
        if (method === 'POST' && path === '/name') {
          const input = record(await body(req))
          json(res, 200, await service.rename(String(input.name ?? ''))); return
        }
        if (method === 'GET' && path === '/prefs') { json(res, 200, service.prefs()); return }
        if (method === 'PUT' && path === '/prefs') { json(res, 200, service.updatePrefs(record(await body(req)) as never)); return }
        if (method === 'GET' && path === '/nodes') { json(res, 200, { items: service.nodes() }); return }
        if (method === 'GET' && path === '/tree') { json(res, 200, await service.tree()); return }
        if (method === 'GET' && path === '/events') {
          json(res, 200, { items: [], cursor: Number(url.searchParams.get('since') ?? 0) }); return
        }
        if (method === 'GET' && path === '/interactions') { json(res, 200, { items: service.interactions() }); return }
        if (method === 'GET' && path === '/tasks') { json(res, 200, { items: service.tasks() }); return }
        if (method === 'POST' && path === '/dev/computer-use') {
          const input = record(await body(req))
          json(res, 200, await service.createLocalComputerUseSession(
            typeof input.workspaceId === 'string' ? input.workspaceId : undefined,
            String(input.text ?? ''),
          )); return
        }
        const session = /^\/sessions\/([^/]+)\/([^/]+)\/(page|stream|prompt|cancel)$/.exec(path)
        if (session !== null) {
          const [, nodeId, sessionId, action] = session
          if (method === 'GET' && action === 'page') {
            json(res, 200, await service.page(decodeURIComponent(nodeId!), decodeURIComponent(sessionId!)))
            return
          }
          if (method === 'GET' && action === 'stream') {
            const since = Number(url.searchParams.get('since') ?? 0)
            json(res, 200, await service.stream(decodeURIComponent(nodeId!), decodeURIComponent(sessionId!), since))
            return
          }
          if (method === 'POST' && action === 'prompt') {
            const input = record(await body(req))
            await service.prompt(decodeURIComponent(nodeId!), decodeURIComponent(sessionId!), String(input.text ?? ''))
            json(res, 200, { ok: true }); return
          }
          if (method === 'POST' && action === 'cancel') {
            await service.cancel(decodeURIComponent(nodeId!), decodeURIComponent(sessionId!))
            json(res, 200, { ok: true }); return
          }
        }
        throw new MeshError('not_found', 'Unknown mesh route.', 404)
      } catch (error) {
        const mesh = error instanceof MeshError
          ? error
          : new MeshError('internal_error', error instanceof Error ? error.message : 'Unexpected error.', 500)
        json(res, mesh.status, { error: mesh.code, message: mesh.message })
      }
    },
  }) as () => void
}