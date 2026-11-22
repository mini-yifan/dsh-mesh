import { resolve } from 'node:path'
import {
  createRemoteServer,
  parseHelloTimeout,
  parseHeartbeatInterval,
  parseHeartbeatDisconnect,
  parseForceTerminateGrace,
  parseMaxFramesPerSec,
} from './server.js'
import { parseLogLevel } from './logger.js'
import { parseIceConfig } from './ice.js'
import { parseMode, readAccountEnv } from './account-config.js'

const port = Number(process.env.DSH_SERVER_PORT ?? '8080')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DSH_SERVER_PORT.')

const heartbeatIntervalMs = parseHeartbeatInterval(process.env.DSH_SERVER_HEARTBEAT_INTERVAL_MS)
const heartbeatDisconnectMs = parseHeartbeatDisconnect(process.env.DSH_SERVER_HEARTBEAT_DISCONNECT_MS, heartbeatIntervalMs)
const helloTimeoutMs = parseHelloTimeout(process.env.DSH_SERVER_HELLO_TIMEOUT_MS)
const forceTerminateGraceMs = parseForceTerminateGrace(process.env.DSH_SERVER_FORCE_TERMINATE_GRACE_MS)
const maxFramesPerSec = parseMaxFramesPerSec(process.env.DSH_SERVER_MAX_FRAMES_PER_SEC)
const logLevel = parseLogLevel(process.env.DSH_SERVER_LOG_LEVEL)

const mode = parseMode(process.env.DSH_MESH_MODE)
const accountEnv = readAccountEnv()

/**
 * Personal mode keeps the v0 single-tenant contract, including its hard
 * requirement for an admin account and a >=12 character password.
 *
 * Account mode has no shared admin credential. A fixed local identity is used
 * for the internal store scope only; every authorization decision is made by
 * the account layer, so this value never authenticates anything.
 */
const adminAccount = process.env.DSH_SERVER_ACCOUNT?.trim() || (mode === 'account' ? 'hosted@local' : '')
const adminPassword = process.env.DSH_SERVER_PASSWORD || (mode === 'account' ? 'hosted-mode-no-admin-password' : '')

const app = createRemoteServer({
  account: adminAccount,
  password: adminPassword,
  publicUrl: process.env.DSH_SERVER_PUBLIC_URL ?? `http://localhost:${port}`,
  certFingerprint: process.env.DSH_SERVER_CERT_FINGERPRINT ?? '',
  dataFile: resolve(process.env.DSH_SERVER_DATA_FILE ?? 'data/state.json'),
  trustedProxyIps: (process.env.DSH_SERVER_TRUSTED_PROXY_IPS ?? '').split(',').map(value => value.trim()).filter(Boolean),
  helloTimeoutMs,
  heartbeatIntervalMs,
  heartbeatDisconnectMs,
  forceTerminateGraceMs,
  maxFramesPerSec,
  logLevel,
  ice: parseIceConfig(process.env),
  ...(accountEnv === undefined
    ? {}
    : { accounts: { env: { ...accountEnv, dataFile: resolve(accountEnv.dataFile) } } }),
})
app.server.listen(port, process.env.DSH_SERVER_HOST ?? '127.0.0.1', () => {
  console.info(`Remote Server listening on port ${port} (mode=${mode})`)
})
app.server.on('error', () => { console.error('Remote Server could not listen. Check address and port.'); process.exitCode = 1; app.gateway.close() })
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return
  stopping = true
  void app.close().then(() => { process.exitCode = 0 }, () => { process.exitCode = 1 })
})
