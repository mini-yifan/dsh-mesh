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

  /**
   * Live view of the owner's admission preferences. Set by MeshService, which
   * owns the state file; the Host runtime asks on every inbound connection so a
   * change in the UI takes effect without restarting the tunnel.
   */
  private prefsProvider: () => { allowIncoming: boolean; allowedCallers: string[] } =
    () => ({ allowIncoming: true, allowedCallers: [] })

  setPrefsProvider(provider: () => { allowIncoming: boolean; allowedCallers: string[] }): void {
    this.prefsProvider = provider
  }

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
    // Remote sessions are dispatched through a per-peer gateway created by
    // createPeer(), not through `local`, so both paths need the same wrapper.
    const enforceIncomingPreset = (gateway: LocalTypertGateway): LocalTypertGateway => {
      const dispatch = gateway.dispatch.bind(gateway)
      gateway.dispatch = async (endpoint, payload, signal) => {
        const result = await dispatch(endpoint, withIncomingPreset(endpoint, payload, this.config.incomingPreset), signal)
        // DSH may ignore `agentPreset` on session/create. Select it explicitly
        // before the caller sends the first prompt, so an incoming task always
        // runs the configured background preset (desktop in the desktop bundle).
        if (endpoint === 'session/create' && result.ok && result.value !== null && typeof result.value === 'object') {
          const value = result.value as Record<string, unknown>
          const sessionId = value.sessionId
          if (typeof sessionId === 'string' && value.agentPreset !== this.config.incomingPreset) {
            const selected = await dispatch('agentPresets/select', {
              args: { agentId: sessionId, agentPreset: this.config.incomingPreset },
            }, signal)
            if (!selected.ok) {
              this.logger.warn('incoming preset select failed', {
                preset: this.config.incomingPreset,
                code: selected.error.code,
              })
            }
          }
          // An unattended background task cannot answer approval prompts. Pin
          // the full-access preset on every remotely created Session so file
          // work outside the workspace and desktop actions are not blocked.
          if (typeof sessionId === 'string') {
            const command = await dispatch('commands/execute', {
              args: { agentId: sessionId, line: '/permission danger-full-access', submittedAttachments: [] },
            }, signal)
            if (!command.ok) {
              this.logger.warn('incoming permission switch failed', {
                code: command.error.code,
              })
            }
          }
        }
        return result
      }
      return gateway
    }
    const local = enforceIncomingPreset(switchGateway.local())
    local.createPeer = (): LocalTypertGateway => {
      const peer = createOwnerPeer()
      if (peer === undefined) return local
      return {
        ...enforceIncomingPreset(switchGateway.local(peer)),
        dispose: async () => { await peer.dispose?.() },
      }
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
      peer => this.admit(peer),
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

  private admit(peer: { deviceId: string; name: string }): boolean {
    let prefs: { allowIncoming: boolean; allowedCallers: string[] }
    try { prefs = this.prefsProvider() } catch { return false }
    return admitPeer(prefs, peer)
  }

  private runtimeConfig(state: MeshState): ResolvedConfig {
    return resolveHostRuntimeConfig(state, this.config)
  }

  /**
   * Live Host control-connection health.
   *
   * `MeshService` cannot infer this from its own start-up result: the runtime
   * starts fine and then loses its socket later. Without this, a machine whose
   * Host side is offline still reports itself as connected.
   */
  hostStatus(): { online: boolean; reconnecting: boolean; error?: string } {
    if (this.runtime === undefined) return { online: false, reconnecting: false }
    const status = this.runtime.hostStatus()
    return {
      online: status.online,
      reconnecting: status.reconnecting,
      ...(status.error === undefined ? {} : { error: status.error }),
    }
  }

  /** Force a fresh control connection; no-op when the runtime is not up. */
  reconnectHost(): boolean {
    if (this.runtime === undefined) return false
    try {
      this.runtime.reconnectHost()
      return true
    } catch {
      return false
    }
  }
}

/**
 * Host runtime configuration for one paired device.
 *
 * Exported so the reconnect policy is unit-testable: `reconnect: false` used to
 * live here, and re-introducing it silently makes this machine permanently
 * unreachable after the first control-socket drop.
 */
export function resolveHostRuntimeConfig(state: MeshState, config: ResolvedMeshConfig): ResolvedConfig {
  return resolveConfig({
    enabled: true,
    role: 'both',
    serverUrl: state.serverUrl,
    // A public-CA deployment has no pin. Passing an empty string fails
    // resolveConfig's `.min(32)` check, so omit the field entirely instead.
    ...(state.fingerprint === '' ? {} : { serverFingerprint: state.fingerprint }),
    deviceName: config.deviceName ?? `${config.platform}-node`,
    forceRelay: true,
    terminal: { enabled: false },
    remoteTools: { enabled: false },
    hostControl: { enabled: true },
    loopback: { ports: [] },
    codex: { enabled: false },
    cursor: { enabled: false },
    acp: { enabled: false, backends: [] },
    // WHY: the Host control socket is what makes this machine reachable at all.
    // With reconnect disabled, a single heartbeat timeout, sleep/wake or Wi-Fi
    // blip silently retired the Host for the rest of the process lifetime: every
    // peer saw this node as offline while its own UI still said "connected".
    // Any object (not `false`) enables the loop; 4s→30s with jitter keeps a long
    // outage from turning into a reconnect stampede.
    reconnect: { initialDelayMs: 4_000, maxDelayMs: 30_000, jitter: 0.2 },
    logLevel: config.logLevel,
  })
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

/**
 * The owner's answer to "may this machine accept work from that device?".
 *
 * `allowIncoming` is the master switch. `allowedCallers` is an allow-list of
 * device ids: an empty list means "anyone on this account", a non-empty list
 * restricts inbound work to exactly those devices. Names are accepted too so
 * the list stays usable when ids change after a re-pair.
 *
 * Exported so the rule is unit-testable without standing up a Host runtime.
 */
export function admitPeer(
  prefs: { allowIncoming: boolean; allowedCallers: readonly string[] },
  peer: { deviceId: string; name: string },
): boolean {
  if (prefs.allowIncoming !== true) return false
  const allowed = prefs.allowedCallers.filter(entry => typeof entry === 'string' && entry.trim() !== '')
  if (allowed.length === 0) return true
  const wanted = new Set(allowed.map(entry => entry.trim()))
  return wanted.has(peer.deviceId) || wanted.has(peer.name)
}
