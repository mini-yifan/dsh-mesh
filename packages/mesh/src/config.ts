import { homedir } from 'node:os'
import { join } from 'node:path'
import s from '@deepseek-ai/schemastery'

export interface MeshConfig {
  platform?: string
  deviceName?: string
  incomingPreset?: string
  remoteToolGuard?: string[]
  receiveDir?: string
  stateDir?: string
  mock?: boolean
  /** Local-only test hook: allow creating a Computer Use session through /.dsh-mesh. */
  devComputerUse?: boolean
  /** Escape hatch for a profile whose state.json was removed. */
  serverUrl?: string
  serverFingerprint?: string
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

export interface ResolvedMeshConfig {
  platform: string
  deviceName?: string
  incomingPreset: string
  remoteToolGuard: string[]
  receiveDir?: string
  stateDir: string
  mock: boolean
  devComputerUse: boolean
  serverUrl?: string
  serverFingerprint?: string
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export const Config = s.object({
  platform: s.string(),
  deviceName: s.string(),
  incomingPreset: s.string(),
  remoteToolGuard: s.array(s.string()),
  receiveDir: s.string(),
  stateDir: s.string(),
  mock: s.boolean(),
  devComputerUse: s.boolean(),
  serverUrl: s.string(),
  serverFingerprint: s.string(),
  logLevel: s.union(['debug', 'info', 'warn', 'error'] as const),
})

export function resolveMeshConfig(input: MeshConfig = {}): ResolvedMeshConfig {
  const platform = input.platform?.trim() || process.platform
  return {
    platform,
    ...(input.deviceName?.trim() === undefined || input.deviceName.trim() === ''
      ? {}
      : { deviceName: input.deviceName.trim().slice(0, 80) }),
    incomingPreset: input.incomingPreset?.trim() || 'standard',
    remoteToolGuard: [...new Set((input.remoteToolGuard ?? (platform === 'android' ? ['mcp__phone__*'] : []))
      .map(value => value.trim()).filter(Boolean))],
    ...(input.receiveDir?.trim() === undefined || input.receiveDir.trim() === ''
      ? {}
      : { receiveDir: input.receiveDir.trim() }),
    stateDir: input.stateDir?.trim() || join(homedir(), '.dsh', 'dsh-mesh'),
    mock: input.mock === true,
    devComputerUse: input.devComputerUse === true,
    ...(input.serverUrl?.trim() === undefined || input.serverUrl.trim() === ''
      ? {}
      : { serverUrl: input.serverUrl.trim() }),
    ...(input.serverFingerprint?.trim() === undefined || input.serverFingerprint.trim() === ''
      ? {}
      : { serverFingerprint: input.serverFingerprint.trim() }),
    logLevel: input.logLevel ?? 'info',
  }
}