import * as DshConnection from '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
import {
  HostPluginRuntime,
  HostServerApi,
  IdentityStore,
  SafeLogger,
  ServerCredentialStore,
  TypertGatewaySwitch,
  createOwnerPeerFactory,
  createPinnedFetch,
  createPinnedWebSocketFactory,
  ownerPeerConstructor,
  resolveConfig,
  type LocalTypertGateway,
  type OwnerPeerServiceLike,
  type ResolvedConfig,
  type TypertGatewayLike,
} from 'ds-harness-remote/internal'
import { join } from 'node:path'
import type { ResolvedMeshConfig } from './config.js'
import { serverScopedDirectory, type MeshState } from './state.js'

/**
 * The v0 Host half. It deliberately instantiates the upstream Host runtime
 * without loading the upstream DSH entry: no sidebar, no settings page, no
 * `remote_*` model tools and no remote terminal.
 */
export class MeshHost {
  readonly localGateway: LocalTypertGateway
  private runtime?: HostPluginRuntime
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedMeshConfig,
    private readonly logger: SafeLogger,
  ) {
    const native = this.ctx.get('typertGateway') as TypertGatewayLike
    const connection = this.ctx.get('connection', false) as OwnerPeerServiceLike | undefined
    const createOwnerPeer = createOwnerPeerFactory(
      this.ctx,
      ownerPeerConstructor(DshConnection as Record<string, unknown>),
      connection,
    )
    const fallbackPeer = createOwnerPeer()
    this.ctx.effect(() => () => {
      void fallbackPeer?.dispose?.()
    }, 'dsh-mesh fallback owner peer')
    const switchGateway = new TypertGatewaySwitch(native, () => fallbackPeer)
    const local = switchGateway.local()
    local.createPeer = (): LocalTypertGateway => {
      const peer = createOwnerPeer()
      if (peer === undefined) return local
      return {
        ...switchGateway.local(peer),
        dispose: async () => { await peer.dispose?.() },
      }
    }
    // Remote-created Sessions must run the configured incoming preset, regardless
// of the target user's current UI preset. The bridge forwards session/create
// through this local dispatch, so this is the enforcement point.
    const dispatch = local.dispatch.bind(local)
    local.dispatch = async (endpoint, payload, signal) => {
      return dispatch(endpoint, withIncomingPreset(endpoint, payload, this.config.incomingPreset), signal)
    }
    this.localGateway = local
  }

  async start(state: MeshState): Promise<void> {
    if (this.disposed || this.runtime !== undefined) return
    const scoped = serverScopedDirectory(this.config.stateDir, state.serverUrl)
    const hostDir = join(scoped, 'host')
    const identities = new IdentityStore({ directory: hostDir, role: 'host' })
    const pinnedFetch = createPinnedFetch(state.fingerprint)
    const serverApi = new HostServerApi(state.serverUrl, new ServerCredentialStore(hostDir), pinnedFetch)
    const runtimeConfig = this.runtimeConfig(state)
    const runtime = new HostPluginRuntime(
      runtimeConfig,
      identities,
      this.logger,
      this.localGateway,
      () => this.ctx.get('fileViewerHost', false) as never,
      undefined,
      undefined,
      undefined,
      serverApi,
      createPinnedWebSocketFactory(state.fingerprint),
    )
    try {
      await runtime.start()
      this.runtime = runtime
    } catch (error) {
      await runtime.close().catch(() => undefined)
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.runtime?.close().catch(() => undefined)
    this.runtime = undefined
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  private runtimeConfig(state: MeshState): ResolvedConfig {
    return resolveConfig({
      enabled: true,
      role: 'both',
      serverUrl: state.serverUrl,
      serverFingerprint: state.fingerprint,
      deviceName: this.config.deviceName ?? `${this.config.platform}-node`,
      forceRelay: true,
      terminal: { enabled: false },
      remoteTools: { enabled: false },
      hostControl: { enabled: true },
      loopback: { ports: [] },
      codex: { enabled: false },
      cursor: { enabled: false },
      acp: { enabled: false, backends: [] },
      reconnect: false,
      logLevel: this.config.logLevel,
    })
  }
}

/**
 * Force every remote-created Session onto the configured incoming preset. The
 * target user's current UI preset must not decide what an incoming task can do.
 */
export function withIncomingPreset(endpoint: string, payload: unknown, incomingPreset: string): unknown {
  if (endpoint !== 'session/create' || incomingPreset === '') return payload
  const root = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
  const args = root?.args !== null && typeof root?.args === 'object' ? root.args as Record<string, unknown> : undefined
  const request = args?.request !== null && typeof args?.request === 'object' ? args.request as Record<string, unknown> : undefined
  if (root === undefined || args === undefined || request === undefined) return payload
  return { ...root, args: { ...args, request: { ...request, agentPreset: incomingPreset } } }
}