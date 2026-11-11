export interface MeshNode {
  nodeId: string
  name: string
  platform: string
  online: boolean
  lastSeenAt?: number
  hostDeviceId: string
  clientDeviceId?: string
  harnessVersion?: string
  appVersion?: string
  self?: boolean
}

export interface MeshWorkspace {
  workspaceId: string
  title: string
  path: string
  sessions: MeshSession[]
}

export type MeshSessionStatus = 'idle' | 'running' | 'waiting-approval' | 'waiting-question' | 'failed' | 'unknown'

export interface MeshSession {
  sessionId: string
  title: string
  status: MeshSessionStatus
  updatedAt?: number
  taskId?: string
  controllable: boolean
}

export interface MeshTree {
  nodes: Array<MeshNode & { workspaces: MeshWorkspace[] }>
  cursor: number
}

export interface MeshStatus {
  paired: boolean
  server?: { url: string; fingerprint: string }
  node?: MeshNode
  connection: 'unpaired' | 'connecting' | 'connected' | 'offline'
  peersOnline: number
  peersTotal: number
}

export interface MeshPrefs {
  allowIncoming: boolean
  allowedCallers: string[]
  allowGuardedTools: boolean
  receiveDir?: string
}

export interface MeshTask {
  taskId: string
  originNodeId: string
  targetNodeId: string
  sessionId: string
  workspaceId?: string
  status: 'running' | 'waiting-input' | 'done' | 'failed' | 'cancelled' | 'unknown'
  files: Array<{
    name: string
    size: number
    direction: 'out' | 'in'
    localPath?: string
    state: 'transferring' | 'done' | 'failed'
    progress?: number
  }>
  createdAt: number
  updatedAt: number
}

export interface MeshInteraction {
  nodeId: string
  sessionId: string
  eventId: string
  clientId: string
  kind: 'approval' | 'question'
  toolName?: string
  reason?: string
  originNodeId: string
  createdAt: number
}

export interface MeshFrame {
  nodeId: string
  sessionId: string
  seq: number
  event: unknown
}

export interface MeshEventBatch {
  items: unknown[]
  cursor: number
  reset?: boolean
}