import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MeshNode, MeshPrefs, MeshTask } from './types.js'

export interface MeshState {
  v: 1
  serverUrl: string
  fingerprint: string
  node?: MeshNode
  platform: string
  pairedAt: number
  /** Host registration succeeded but the Client role or the first connection has not. */
  pending?: boolean
  prefs: MeshPrefs
  tasks: MeshTask[]
}

export const defaultPrefs = (): MeshPrefs => ({
  allowIncoming: true,
  allowedCallers: [],
  allowGuardedTools: false,
})

export function stateFile(stateDir: string): string {
  return join(stateDir, 'state.json')
}

export function serverScopedDirectory(stateDir: string, serverUrl: string): string {
  return join(stateDir, createHash('sha256').update(serverUrl).digest('hex').slice(0, 24))
}

export function loadState(stateDir: string): MeshState | undefined {
  const file = stateFile(stateDir)
  if (!existsSync(file)) return undefined
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<MeshState>
    if (value.v !== 1 || typeof value.serverUrl !== 'string' || typeof value.fingerprint !== 'string') return undefined
    return {
      v: 1,
      serverUrl: value.serverUrl,
      fingerprint: value.fingerprint,
      ...(value.node === undefined ? {} : { node: value.node }),
      platform: typeof value.platform === 'string' ? value.platform : process.platform,
      pairedAt: typeof value.pairedAt === 'number' ? value.pairedAt : Date.now(),
      ...(value.pending === true ? { pending: true } : {}),
      prefs: {
        allowIncoming: value.prefs?.allowIncoming !== false,
        allowedCallers: Array.isArray(value.prefs?.allowedCallers) ? value.prefs!.allowedCallers.filter(item => typeof item === 'string') : [],
        allowGuardedTools: value.prefs?.allowGuardedTools === true,
        ...(typeof value.prefs?.receiveDir === 'string' ? { receiveDir: value.prefs.receiveDir } : {}),
      },
      tasks: Array.isArray(value.tasks) ? value.tasks.filter(item => item !== null && typeof item === 'object') as MeshTask[] : [],
    }
  } catch {
    return undefined
  }
}

export function saveState(stateDir: string, state: MeshState): void {
  mkdirSync(dirname(stateFile(stateDir)), { recursive: true, mode: 0o700 })
  const file = stateFile(stateDir)
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(temporary, file)
}

export function clearState(stateDir: string): void {
  rmSync(stateFile(stateDir), { force: true })
}

export function clearServerScoped(stateDir: string, serverUrl: string): void {
  rmSync(serverScopedDirectory(stateDir, serverUrl), { recursive: true, force: true })
}