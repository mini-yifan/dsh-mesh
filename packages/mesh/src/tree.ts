import type { LocalTypertGateway } from 'ds-harness-remote/internal'
import type { MeshSession, MeshSessionStatus, MeshWorkspace } from './types.js'

export interface CatalogGateway {
  open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>
  dispatch(endpoint: string, payload: unknown, signal: AbortSignal): Promise<
    | { ok: true; value?: unknown }
    | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }
  >
}

interface WorkspaceRow {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

interface SessionRow {
  sessionId: string
  title?: string
  running: boolean
  updatedAt: number
  parentSessionId?: string
  origin?: string
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function parseWorkspace(value: unknown): WorkspaceRow {
  const item = record(value)
  if (typeof item.workspaceId !== 'string' || typeof item.path !== 'string' || typeof item.title !== 'string' || !Array.isArray(item.sessionIds)) {
    throw new Error('INVALID_WORKSPACE_BASELINE')
  }
  return {
    workspaceId: item.workspaceId,
    path: item.path,
    title: item.title,
    sessionIds: item.sessionIds.filter((id): id is string => typeof id === 'string'),
  }
}

function parseSession(value: unknown): SessionRow {
  const item = record(value)
  if (typeof item.sessionId !== 'string' || typeof item.running !== 'boolean' || typeof item.updatedAt !== 'number') {
    throw new Error('INVALID_SESSION_ROW')
  }
  return {
    sessionId: item.sessionId,
    ...(typeof item.title === 'string' ? { title: item.title } : {}),
    running: item.running,
    updatedAt: item.updatedAt,
    ...(typeof item.parentSessionId === 'string' ? { parentSessionId: item.parentSessionId } : {}),
    ...(typeof item.origin === 'string' ? { origin: item.origin } : {}),
  }
}

async function readWorkspaces(gateway: CatalogGateway, signal: AbortSignal): Promise<WorkspaceRow[]> {
  const lifetime = new AbortController()
  const active = AbortSignal.any([signal, lifetime.signal])
  const source = await gateway.open('workspace/follow', { args: {} }, active)
  const iterator = source[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done) throw new Error('INVALID_WORKSPACE_BASELINE')
    const frame = record(first.value)
    if (frame.type !== 'baseline') throw new Error('INVALID_WORKSPACE_BASELINE')
    const items = record(frame.value).items
    if (!Array.isArray(items)) throw new Error('INVALID_WORKSPACE_BASELINE')
    return items.map(parseWorkspace)
  } finally {
    lifetime.abort('workspace-baseline-read')
    await iterator.return?.()
  }
}

async function readSessions(gateway: CatalogGateway, signal: AbortSignal): Promise<SessionRow[]> {
  const result = await gateway.dispatch('session/list', { args: { _request: {} } }, signal)
  if (!result.ok) throw new Error(result.error.code || 'SESSION_LIST_FAILED')
  const items = record(result.value).items
  if (!Array.isArray(items)) throw new Error('INVALID_SESSION_LIST')
  return items.map(parseSession)
}

function statusOf(row: SessionRow): MeshSessionStatus {
  if (row.running) return 'running'
  return 'idle'
}

export interface RemoteCatalog {
  workspaces: MeshWorkspace[]
  sessions: Map<string, MeshSession>
}

export async function readRemoteCatalog(gateway: CatalogGateway, signal: AbortSignal): Promise<RemoteCatalog> {
  const [workspaceRows, sessionRows] = await Promise.all([
    readWorkspaces(gateway, signal),
    readSessions(gateway, signal),
  ])
  const byId = new Map(sessionRows.filter(row => row.parentSessionId === undefined && row.origin !== 'subagent')
    .map(row => [row.sessionId, row]))
  const sessions = new Map<string, MeshSession>()
  const workspaces: MeshWorkspace[] = workspaceRows.map(workspace => {
    const rows = workspace.sessionIds
      .map(id => byId.get(id))
      .filter((row): row is SessionRow => row !== undefined)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    return {
      workspaceId: workspace.workspaceId,
      title: workspace.title || workspace.path,
      path: workspace.path,
      sessions: rows.map(row => {
        const session: MeshSession = {
          sessionId: row.sessionId,
          title: row.title ?? row.sessionId,
          status: statusOf(row),
          updatedAt: row.updatedAt,
          controllable: false,
        }
        sessions.set(row.sessionId, session)
        return session
      }),
    }
  })
  return { workspaces, sessions }
}

export function localGatewayOf(gateway: LocalTypertGateway): CatalogGateway {
  return gateway
}