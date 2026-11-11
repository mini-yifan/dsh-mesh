import type { Context } from '@deepseek-ai/cordis'
import { SafeLogger } from 'ds-harness-remote/internal'
import { Config, resolveMeshConfig, type MeshConfig } from './config.js'
import { MeshHost } from './host.js'
import { MeshService } from './service.js'
import { registerMeshRoutes } from './routes.js'

export const name = '@dsh-mesh/plugin'
export { Config }
export { MeshService, MeshError } from './service.js'
export { MeshPeers } from './peers.js'
export { MeshHost } from './host.js'
export { parsePairing, pairMesh, unpairMesh, MeshPairError } from './pair.js'
export type { PairingInput } from './pair.js'
export * from './types.js'

export function apply(ctx: Context, entry: MeshConfig | undefined = undefined): void {
  const config = resolveMeshConfig(entry ?? {})
  const logger = new SafeLogger({
    debug: message => { ctx.logger.debug(message); console.debug(message) },
    info: message => { ctx.logger.info(message); console.info(message) },
    warn: message => { ctx.logger.warn(message); console.warn(message) },
    error: message => { ctx.logger.error(message); console.error(message) },
  }, () => config.logLevel)

  ctx.inject(['typertGateway'], async (runtimeContext: Context) => {
    const host = new MeshHost(runtimeContext, config, logger)
    const service = new MeshService(config, host.localGateway, logger, host)
    try {
      ;(runtimeContext as unknown as { provide(name: string, value: unknown): void }).provide('mesh', service)
    } catch (error) {
      logger.warn('mesh service is already provided', { code: error instanceof Error ? error.message.slice(0, 120) : 'PROVIDE_CONFLICT' })
    }
    const webServer = runtimeContext.get('webServer', false) as Parameters<typeof registerMeshRoutes>[0]
    const connection = runtimeContext.get('connection', false) as Parameters<typeof registerMeshRoutes>[1]
    const disposeRoutes = registerMeshRoutes(webServer, connection, service)
    runtimeContext.effect(() => () => {
      void disposeRoutes()
      void service.stop()
      void host.dispose()
    }, 'dsh-mesh lifecycle')
    await service.start()
  })
}