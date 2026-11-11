import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  ClientServerApi,
  HostServerApi,
  IdentityStore,
  SafeLogger,
  ServerCredentialStore,
  createPinnedAdaptiveWebSocket,
  createPinnedFetch,
  resolveConfig,
  type LocalTypertGateway,
  type ResolvedConfig,
} from 'ds-harness-remote/internal'
import type { ResolvedMeshConfig } from './config.js'
import { MeshPeers } from './peers.js'
import { pairMesh, unpairMesh, type PairingInput } from './pair.js'
import { loadState, saveState, serverScopedDirectory, type MeshState } from './state.js'
import { readRemoteCatalog } from './tree.js'
import type {
  MeshInteraction,
  MeshNode,
  MeshPrefs,
  MeshStatus,
  MeshTask,
  MeshTree,
} from './types.js'

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

const SESSION_TIMEOUT_MS = 5 * 60_000

export class MeshError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
  }
}

/**
 * The in-process face consumed by `/.dsh-mesh/v1/*` and by orb-host. It owns
 * the persisted node state, one multi-peer client manager, and the task table
 * that authorizes remote prompt/cancel.
 */
export interface MeshHostController {
  start(state: MeshState): Promise<void>
  stop(): Promise<void>
}

export class MeshService {
  private state?: MeshState
  private peers?: MeshPeers
  private startError?: string
  private localNode: MeshNode
  private treeCursor = 0
  private clientRetry?: ReturnType<typeof setTimeout>
  private closedClient = false

  constructor(
    private readonly config: ResolvedMeshConfig,
    private readonly localGateway: LocalTypertGateway,
    private readonly logger: SafeLogger,
    private readonly host?: MeshHostController,
  ) {
    this.state = loadState(config.stateDir)
    this.localNode = {
      ...(this.state?.node ?? {}),
      nodeId: this.state?.node?.nodeId ?? 'local',
      name: this.state?.node?.name ?? config.deviceName ?? `${config.platform}-local`,
      platform: config.platform,
      online: true,
      hostDeviceId: this.state?.node?.hostDeviceId ?? 'local',
      self: true,
    }
  }

  async start(): Promise<void> {
    const state = this.state
    if (state === undefined || state.pending === true) return
    try {
      await this.host?.start(state)
    } catch (error) {
      this.startError = error instanceof Error ? error.message : 'host startup failed'
      this.logger.warn('mesh host startup failed', { code: this.startError.slice(0, 160) })
    }
    await this.startClient(state)
  }

  async stop(): Promise<void> {
    this.closedClient = true
    this.clearClientRetry()
    await this.peers?.close()
    this.peers = undefined
    await this.host?.stop().catch(() => undefined)
  }

  status(): MeshStatus {
    const state = this.state
    if (state === undefined) return { paired: false, connection: 'unpaired', peersOnline: 0, peersTotal: 0 }
    const online = this.peers?.onlineCount() ?? 0
    const total = this.peers?.size ?? 0
    return {
      paired: true,
      server: { url: state.serverUrl, fingerprint: state.fingerprint },
      node: { ...this.localNode, online: true, self: true },
      connection: this.startError !== undefined ? 'offline' : online > 0 ? 'connected' : 'connecting',
      peersOnline: online,
      peersTotal: total,
    }
  }

  async pair(input: PairingInput): Promise<MeshStatus> {
    const result = await pairMesh(this.config, input)
    this.state = result.state
    this.localNode = { ...this.localNode, ...(result.state.node ?? {}), self: true }
    await this.peers?.close()
    this.peers = undefined
    await this.host?.stop().catch(() => undefined)
    this.startError = undefined
    try {
      await this.host?.start(result.state)
    } catch (error) {
      this.startError = error instanceof Error ? error.message : 'host startup failed'
      this.logger.warn('mesh host startup failed', { code: this.startError.slice(0, 160) })
    }
    await this.startClient(result.state)
    return this.status()
  }

  async unpair(): Promise<void> {
    this.clearClientRetry()
    await this.peers?.close()
    this.peers = undefined
    await this.host?.stop().catch(() => undefined)
    await unpairMesh(this.config)
    this.state = undefined
    this.startError = undefined
  }

  async rename(name: string): Promise<MeshNode> {
    const state = this.requireState()
    const trimmed = name.trim().slice(0, 80)
    if (!trimmed) throw new MeshError('invalid_name', 'Device name must not be empty.')
    const host = this.hostApi(state)
    const identity = await this.hostIdentity(state)
    await host.authenticate(identity)
    await host.renameSelf(trimmed)
    state.node = { ...(state.node ?? this.localNode), name: trimmed }
    saveState(this.config.stateDir, state)
    this.localNode = { ...this.localNode, name: trimmed }
    return this.localNode
  }

  nodes(): MeshNode[] {
    const self = { ...this.localNode, online: true, self: true }
    return [self, ...(this.peers?.nodes() ?? [])]
  }

  prefs(): MeshPrefs {
    return this.state?.prefs ?? { allowIncoming: true, allowedCallers: [], allowGuardedTools: false }
  }

  updatePrefs(patch: Partial<MeshPrefs>): MeshPrefs {
    const state = this.state
    if (state === undefined) throw new MeshError('unpaired', 'This device is not paired.')
    state.prefs = {
      ...state.prefs,
      ...(patch.allowIncoming === undefined ? {} : { allowIncoming: patch.allowIncoming }),
      ...(patch.allowedCallers === undefined ? {} : { allowedCallers: patch.allowedCallers.filter(item => typeof item === 'string') }),
      ...(patch.allowGuardedTools === undefined ? {} : { allowGuardedTools: patch.allowGuardedTools }),
      ...(patch.receiveDir === undefined ? {} : { receiveDir: patch.receiveDir }),
    }
    saveState(this.config.stateDir, state)
    return state.prefs
  }

  async tree(): Promise<MeshTree> {
    const nodes: Array<MeshNode & { workspaces: MeshTree['nodes'][number]['workspaces'] }> = []
    const localCatalog = await readRemoteCatalog(this.localGateway, new AbortController().signal).catch(() => undefined)
    nodes.push({ ...this.localNode, online: true, self: true, workspaces: localCatalog?.workspaces ?? [] })
    for (const entry of this.peers?.nodes() ?? []) {
      if (entry.nodeId === this.localNode.nodeId) continue
      const peer = this.peers?.peer(entry.nodeId)
      if (peer?.gateway === undefined || peer.status !== 'online') {
        nodes.push({ ...entry, workspaces: [] })
        continue
      }
      const catalog = await readRemoteCatalog(peer.gateway, new AbortController().signal).catch(() => undefined)
      nodes.push({ ...entry, workspaces: catalog?.workspaces ?? [] })
    }
    this.treeCursor += 1
    return { nodes, cursor: this.treeCursor }
  }

  async page(nodeId: string, sessionId: string, maxMessages = 50): Promise<unknown> {
    const gateway = this.readGatewayFor(nodeId)
    // DSH 0.1.7 requires `throughSeq` on session/page while 0.2.2 makes it
    // optional. A follow snapshot carries the same records and is accepted by
    // both, so the Mesh view uses it as the cold-read primitive.
    const lifetime = new AbortController()
    const source = await gateway.open('session/follow', {
      args: { request: { address: { kind: 'session', sessionId }, maxMessages } },
    }, lifetime.signal)
    const iterator = source[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      const value = record(first.done ? undefined : first.value)
      return value.type === 'snapshot'
        ? { records: value.records, cursor: value.cursor, hasMore: value.hasMore, projections: value.projections }
        : { records: [], cursor: 0, hasMore: false }
    } finally {
      lifetime.abort('snapshot-read')
      await iterator.return?.()
    }
  }

  async stream(nodeId: string, sessionId: string, since?: number): Promise<{ items: unknown[]; cursor: number }> {
    const gateway = this.readGatewayFor(nodeId)
    const lifetime = new AbortController()
    const source = await gateway.open('session/follow', {
      args: { request: { address: { kind: 'session', sessionId }, maxMessages: 20 } },
    }, lifetime.signal)
    const iterator = source[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      const items = first.done ? [] : [first.value]
      return { items, cursor: since ?? items.length }
    } finally {
      lifetime.abort('snapshot-read')
      await iterator.return?.()
    }
  }

  async prompt(nodeId: string, sessionId: string, text: string): Promise<void> {
    const task = this.requireTask(nodeId, sessionId)
    const gateway = this.gatewayFor(nodeId)
    const result = await gateway.dispatch('session/prompt', {
      args: { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] } },
    }, new AbortController().signal)
    if (!result.ok) throw new MeshError(result.error.code, result.error.message, 502)
    task.updatedAt = Date.now()
    saveState(this.config.stateDir, this.requireState())
  }

  async cancel(nodeId: string, sessionId: string): Promise<void> {
    const task = this.requireTask(nodeId, sessionId)
    const gateway = this.gatewayFor(nodeId)
    const result = await gateway.dispatch('session/cancel', { args: { request: { sessionId } } }, new AbortController().signal)
    if (!result.ok) throw new MeshError(result.error.code, result.error.message, 502)
    task.status = 'cancelled'
    task.updatedAt = Date.now()
    saveState(this.config.stateDir, this.requireState())
  }

  interactions(): MeshInteraction[] {
    return []
  }

  tasks(): MeshTask[] {
    return this.state?.tasks ?? []
  }

  get devComputerUse(): boolean {
    return this.config.devComputerUse
  }

  /**
   * Local-only test hook: create a real Computer Use session in this Harness and
   * prompt it, so both directions of the model-facing `device_agent` path can be
   * exercised without the desktop app's browser cookie.
   */
  async createLocalComputerUseSession(workspaceId: string | undefined, text: string): Promise<{ sessionId: string }> {
    if (!this.config.devComputerUse) throw new MeshError('dev_disabled', 'The local Computer Use test hook is disabled.', 404)
    if (text.trim() === '') throw new MeshError('invalid_text', 'The test prompt must not be empty.')
    const tree = await this.tree()
    const local = tree.nodes.find(node => node.self === true || node.nodeId === this.localNode.nodeId)
    const normalized = (value: string) => value.replaceAll('\\', '/').toLowerCase().replaceAll('_', '-')
    const selected = workspaceId?.trim()
      || local?.workspaces.find(workspace => normalized(workspace.title) === 'dsh-orb'
        || normalized(workspace.path).endsWith('/.dsh/dsh-orb'))?.workspaceId
      || local?.workspaces[0]?.workspaceId
    if (selected === undefined || selected === '') throw new MeshError('needs_workspace', 'The local Harness has no workspace.', 409)
    const signal = new AbortController().signal
    const created = await this.localGateway.dispatch('session/create', {
      args: { request: { workspaceId: selected, agentPreset: 'computer-use' } },
    }, signal)
    if (!created.ok) throw new MeshError(created.error.code, created.error.message, 502)
    const createdValue = record(created.value)
    const sessionId = createdValue.sessionId
    if (typeof sessionId !== 'string') throw new MeshError('invalid_session', 'The local Harness did not return a session id.', 502)
    // Some DSH releases ignore `agentPreset` on local session/create. Select the
    // preset explicitly before the first turn; the registry endpoint takes the
    // agent id either at the args root or under `request`.
    if (createdValue.agentPreset !== 'computer-use') {
      const selectedPreset = await this.localGateway.dispatch('agentPresets/select', {
        args: { agentId: sessionId, agentPreset: 'computer-use' },
      }, signal)
      if (!selectedPreset.ok) {
        const fallback = await this.localGateway.dispatch('agentPresets/select', {
          args: { request: { agentId: sessionId, agentPreset: 'computer-use' } },
        }, signal)
        if (!fallback.ok) throw new MeshError(fallback.error.code, fallback.error.message, 502)
      }
    }
    const prompted = await this.localGateway.dispatch('session/prompt', {
      args: { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text }] } },
    }, signal)
    if (!prompted.ok) throw new MeshError(prompted.error.code, prompted.error.message, 502)
    return { sessionId }
  }

  async createTaskSession(targetNodeId: string, workspaceId: string, taskText: string): Promise<{ task: MeshTask; workspaceId: string }> {
    const state = this.requireState()
    const peer = this.peers?.peer(targetNodeId)
    if (peer?.gateway === undefined || peer.status !== 'online') throw new MeshError('offline', 'The target device is offline.', 503)
    const created = await peer.gateway.dispatch('session/create', { args: { request: { workspaceId } } }, new AbortController().signal)
    if (!created.ok) throw new MeshError(created.error.code, created.error.message, 502)
    const sessionId = record(created.value).sessionId
    if (typeof sessionId !== 'string') throw new MeshError('invalid_session', 'The target did not return a session id.', 502)
    const now = Date.now()
    const task: MeshTask = {
      taskId: randomUUID(),
      originNodeId: this.localNode.nodeId,
      targetNodeId,
      sessionId,
      workspaceId,
      status: 'running',
      files: [],
      createdAt: now,
      updatedAt: now,
    }
    state.tasks.push(task)
    saveState(this.config.stateDir, state)
    await this.prompt(targetNodeId, sessionId, taskText)
    return { task, workspaceId }
  }

  async waitTask(taskId: string, timeoutMs = SESSION_TIMEOUT_MS): Promise<MeshTask> {
    const state = this.requireState()
    const task = state.tasks.find(item => item.taskId === taskId)
    if (task === undefined) throw new MeshError('task_not_found', 'Task not found.', 404)
    const peer = this.peers?.peer(task.targetNodeId)
    if (peer?.gateway === undefined) {
      task.status = 'unknown'
      saveState(this.config.stateDir, state)
      return task
    }
    const deadline = Date.now() + timeoutMs
    let idle = 0
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1_000))
      const listed = await peer.gateway.dispatch('session/list', { args: { _request: {} } }, new AbortController().signal).catch(() => undefined)
      if (listed?.ok !== true) continue
      const items = record(listed.value).items
      const row = Array.isArray(items)
        ? items.map(record).find(item => item.sessionId === task.sessionId)
        : undefined
      if (row?.running === false) {
        idle += 1
        if (idle >= 2) {
          task.status = 'done'
          task.updatedAt = Date.now()
          saveState(this.config.stateDir, state)
          return task
        }
      } else {
        idle = 0
      }
    }
    task.status = 'unknown'
    task.updatedAt = Date.now()
    saveState(this.config.stateDir, state)
    return task
  }

  private async startClient(state: MeshState): Promise<void> {
    if (this.closedClient) return
    try {
      const scoped = serverScopedDirectory(this.config.stateDir, state.serverUrl)
      const clientDir = join(scoped, 'client')
      const identityStore = new IdentityStore({ directory: clientDir, role: 'client' })
      const identity = await identityStore.loadOrCreate(this.config.deviceName ?? `${this.config.platform}-node`)
      const server = new ClientServerApi(state.serverUrl, new ServerCredentialStore(clientDir), createPinnedFetch(state.fingerprint))
      await server.authenticate(identity)
      const runtimeConfig = this.runtimeConfig(state)
      const peers = new MeshPeers(
        this.config,
        runtimeConfig,
        server,
        identity,
        identityStore,
        this.logger,
        createPinnedAdaptiveWebSocket(state.fingerprint),
        state.node?.nodeId,
        state.node?.hostDeviceId,
      )
      await peers.start()
      this.peers = peers
      this.startError = undefined
      this.clearClientRetry()
    } catch (error) {
      this.startError = error instanceof Error ? error.message : 'client startup failed'
      this.logger.warn('mesh client startup failed', { code: this.startError.slice(0, 160) })
      this.scheduleClientRetry(state)
    }
  }

  private scheduleClientRetry(state: MeshState): void {
    if (this.clientRetry !== undefined || this.closedClient) return
    this.clientRetry = setTimeout(() => {
      this.clientRetry = undefined
      if (this.state !== undefined && this.peers === undefined) void this.startClient(state)
    }, 15_000)
    this.clientRetry.unref?.()
  }

  private clearClientRetry(): void {
    if (this.clientRetry === undefined) return
    clearTimeout(this.clientRetry)
    this.clientRetry = undefined
  }

  private runtimeConfig(state: MeshState): ResolvedConfig {
    return resolveConfig({
      enabled: true,
      role: 'client',
      serverUrl: state.serverUrl,
      serverFingerprint: state.fingerprint,
      deviceName: this.config.deviceName ?? `${this.config.platform}-node`,
      forceRelay: true,
      terminal: { enabled: false },
      remoteTools: { enabled: false },
      hostControl: { enabled: false },
      loopback: { ports: [] },
      codex: { enabled: false },
      cursor: { enabled: false },
      acp: { enabled: false, backends: [] },
      reconnect: false,
      logLevel: this.config.logLevel,
    })
  }

  private hostIdentity(state: MeshState): Promise<import('ds-harness-remote/internal').HostIdentity> {
    const scoped = serverScopedDirectory(this.config.stateDir, state.serverUrl)
    const store = new IdentityStore({ directory: join(scoped, 'host'), role: 'host' })
    return store.loadOrCreate(this.config.deviceName ?? `${this.config.platform}-node`)
  }

  private hostApi(state: MeshState): HostServerApi {
    const scoped = serverScopedDirectory(this.config.stateDir, state.serverUrl)
    const hostDir = join(scoped, 'host')
    return new HostServerApi(state.serverUrl, new ServerCredentialStore(hostDir), createPinnedFetch(state.fingerprint))
  }

  private readGatewayFor(nodeId: string): import('ds-harness-remote/internal').RemoteTypertGateway | LocalTypertGateway {
    if (nodeId === this.localNode.nodeId || nodeId === 'local') return this.localGateway
    return this.gatewayFor(nodeId)
  }

  private gatewayFor(nodeId: string): import('ds-harness-remote/internal').RemoteTypertGateway {
    if (nodeId === this.localNode.nodeId || nodeId === 'local') {
      throw new MeshError('local_not_remote', 'The local tree uses the local DSH UI.', 400)
    }
    const peer = this.peers?.peer(nodeId)
    if (peer?.gateway === undefined || peer.status !== 'online') throw new MeshError('offline', 'The target device is offline.', 503)
    return peer.gateway
  }

  private requireState(): MeshState {
    if (this.state === undefined) throw new MeshError('unpaired', 'This device is not paired.', 400)
    return this.state
  }

  private requireTask(nodeId: string, sessionId: string): MeshTask {
    const state = this.requireState()
    const task = state.tasks.find(item => item.targetNodeId === nodeId && item.sessionId === sessionId)
    if (task === undefined) throw new MeshError('session_not_remote_controllable', 'Only a task created by device_agent can be controlled.', 403)
    return task
  }
}