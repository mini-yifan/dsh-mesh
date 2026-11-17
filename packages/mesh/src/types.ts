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
  /** Startup failure detail, surfaced so "offline" is actionable. */
  error?: string
  /**
   * This machine's own Host control connection, when the build has one.
   *
   * A paired device is always "connected" to the server through its Client
   * socket, so `connection` cannot express "other machines cannot reach me".
   * `hostOnline: false` is that state: peers see this node as offline.
   */
  hostOnline?: boolean
  /** A Host reconnect is in flight; the node is expected to come back on its own. */
  hostReconnecting?: boolean
  /**
   * Last Host control failure. Distinguishes "the server rejected us" from
   * "the network dropped us", which need opposite user actions.
   */
  hostError?: string
  /**
   * Origin the sign-in switch offers first, when the deployment configured one.
   * Absent means the user has to type an address.
   */
  defaultServer?: string
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
  /** The asking text, for the Orb bookmark strip and Mesh task cards. */
  prompt?: string
  /** The local conversation that called device_agent; used for attribution labels. */
  callerSessionId?: string
  files: Array<{
    name: string
    size: number
    direction: 'out' | 'in'
    localPath?: string
    remotePath?: string
    state: 'transferring' | 'done' | 'failed'
    progress?: number
    error?: string
  }>
  /** Workspace that receives files returned by the remote worker. */
  receiveRoot?: string
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