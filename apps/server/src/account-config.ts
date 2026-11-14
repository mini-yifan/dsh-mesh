/**
 * Hosted-mode configuration, read from the environment.
 *
 * Two deployment shapes share one image:
 *
 *   DSH_MESH_MODE=personal  single tenant, admin password + pairing codes,
 *                           no account endpoints (the v0 behaviour).
 *   DSH_MESH_MODE=account   multi-tenant: email codes, web portal, device links.
 *
 * Every value that identifies a deployment (domain, SMTP host, sender) is
 * supplied by the operator. Nothing site-specific is compiled in, so the
 * published source tree is safe to fork and self-host.
 */
export type MeshMode = 'personal' | 'account'

export interface MailEnv {
  transport: 'console' | 'smtp'
  appName: string
  from: string
  fromAlias?: string
  smtp?: {
    host: string
    port: number
    security: 'ssl' | 'starttls' | 'none'
    username: string
    password: string
    timeoutMs: number
  }
}

export interface AccountEnv {
  dataFile: string
  /** HMAC key for code digests and rate-limit buckets. Required in account mode. */
  pepper: string
  limits: {
    codeTtlSeconds: number
    sessionTtlSeconds: number
    sendCooldownSeconds: number
    emailSendsPerDay: number
    ipSendsPerHour: number
    ipSendsPerDay: number
    maxVerifyFailures: number
    linkTtlSeconds: number
  }
  mail: MailEnv
  /** Optional shared invite code; empty means open registration. */
  inviteCode?: string
  /** Emails allowed into the operator UI. Empty means every account. */
  adminEmails: readonly string[]
}

function int(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} 必须是 >= ${min} 的整数。`)
  return value
}

export function parseMode(raw: string | undefined): MeshMode {
  const value = (raw ?? 'personal').trim().toLowerCase()
  if (value !== 'personal' && value !== 'account') {
    throw new Error('DSH_MESH_MODE 只能是 personal 或 account。')
  }
  return value
}

/**
 * Resolve the SMTP host for a well-known DirectMail region when the operator
 * did not spell it out. Kept as a lookup table rather than a default domain so
 * the code carries no brand-specific endpoint.
 */
const REGION_SMTP_HOSTS: Record<string, string> = {
  'cn-hangzhou': 'smtpdm.aliyun.com',
  'ap-southeast-1': 'smtpdm-ap-southeast-1.aliyuncs.com',
  'us-east-1': 'smtpdm-us-east-1.aliyuncs.com',
  'eu-central-1': 'smtpdm-eu-central-1.aliyuncs.com',
}

function readMail(): MailEnv {
  const transport = (process.env.DSH_MESH_MAIL_TRANSPORT?.trim().toLowerCase() || 'console') as 'console' | 'smtp'
  if (transport !== 'console' && transport !== 'smtp') {
    throw new Error('DSH_MESH_MAIL_TRANSPORT 只能是 console 或 smtp。')
  }
  const appName = process.env.DSH_MESH_MAIL_APP_NAME?.trim() || 'DSH Mesh'
  const from = process.env.DSH_MESH_MAIL_FROM?.trim() || process.env.DSH_MESH_SMTP_USERNAME?.trim() || ''
  const fromAlias = process.env.DSH_MESH_MAIL_FROM_ALIAS?.trim() || undefined

  if (transport === 'console') return { transport, appName, from, fromAlias }

  const region = process.env.DSH_MESH_MAIL_REGION?.trim().toLowerCase() ?? ''
  const host = process.env.DSH_MESH_SMTP_HOST?.trim() || REGION_SMTP_HOSTS[region] || ''
  const port = int('DSH_MESH_SMTP_PORT', 465, 1)
  const security = (process.env.DSH_MESH_SMTP_SECURITY?.trim().toLowerCase() || (port === 465 ? 'ssl' : 'starttls')) as 'ssl' | 'starttls' | 'none'
  const username = process.env.DSH_MESH_SMTP_USERNAME?.trim() ?? ''
  const password = process.env.DSH_MESH_SMTP_PASSWORD ?? ''

  const missing: string[] = []
  if (!host) missing.push('DSH_MESH_SMTP_HOST（或 DSH_MESH_MAIL_REGION）')
  if (!username) missing.push('DSH_MESH_SMTP_USERNAME')
  if (!password) missing.push('DSH_MESH_SMTP_PASSWORD')
  if (missing.length) throw new Error(`SMTP 模式缺少配置：${missing.join('、')}`)
  // `from` already falls back to the SMTP identity; only validate the result.
  if (!from) throw new Error('无法确定发信地址：请设置 DSH_MESH_MAIL_FROM 或 DSH_MESH_SMTP_USERNAME。')
  if (!from.includes('@')) throw new Error('发信地址必须是完整邮箱（形如 login@example.com）。')

  return {
    transport,
    appName,
    from,
    fromAlias,
    smtp: { host, port, security, username, password, timeoutMs: int('DSH_MESH_SMTP_TIMEOUT_SECONDS', 20, 1) * 1000 },
  }
}

export function readAccountEnv(): AccountEnv | undefined {
  if (parseMode(process.env.DSH_MESH_MODE) !== 'account') return undefined
  const pepper = process.env.DSH_MESH_ACCOUNT_PEPPER?.trim() ?? ''
  if (pepper.length < 32) {
    throw new Error('账号模式要求 DSH_MESH_ACCOUNT_PEPPER 至少 32 个字符（用于验证码与会话摘要）。')
  }
  return {
    dataFile: process.env.DSH_MESH_ACCOUNT_DB?.trim() || 'data/accounts.sqlite3',
    pepper,
    limits: {
      codeTtlSeconds: int('DSH_MESH_CODE_TTL_SECONDS', 600, 30),
      sessionTtlSeconds: int('DSH_MESH_SESSION_TTL_SECONDS', 7 * 24 * 3600, 300),
      sendCooldownSeconds: int('DSH_MESH_SEND_COOLDOWN_SECONDS', 60, 0),
      emailSendsPerDay: int('DSH_MESH_EMAIL_SENDS_PER_DAY', 5, 1),
      ipSendsPerHour: int('DSH_MESH_IP_SENDS_PER_HOUR', 10, 1),
      ipSendsPerDay: int('DSH_MESH_IP_SENDS_PER_DAY', 30, 1),
      maxVerifyFailures: int('DSH_MESH_MAX_VERIFY_FAILURES', 5, 1),
      linkTtlSeconds: int('DSH_MESH_LINK_TTL_SECONDS', 600, 60),
    },
    mail: readMail(),
    ...(process.env.DSH_MESH_INVITE_CODE?.trim()
      ? { inviteCode: process.env.DSH_MESH_INVITE_CODE.trim() }
      : {}),
    adminEmails: (process.env.DSH_MESH_ADMIN_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
  }
}

/** Disposable / role addresses that should not be able to register. */
const BLOCKED_DOMAINS = new Set([
  '10minutemail.com', '20minutemail.com', 'dispostable.com', 'emailondeck.com',
  'fakemail.net', 'getnada.com', 'grr.la', 'guerrillamail.com', 'guerrillamailblock.com',
  'maildrop.cc', 'mailinator.com', 'mailnesia.com', 'mintemail.com', 'mohmal.com',
  'sharklasers.com', 'temp-mail.org', 'tempmail.com', 'throwaway.email', 'tmpmail.org',
  'trashmail.com', 'yopmail.com',
])

export class EmailRejected extends Error {
  constructor(message: string) { super(message) }
}

/**
 * Normalize an address and reject throwaway domains. Deliberately conservative:
 * this runs before any mail is sent, but the authoritative check is the one the
 * mail provider performs.
 */
export function normalizeEmail(raw: string): string {
  const value = (raw ?? '').trim().toLowerCase()
  if (!value || value.length > 320) throw new EmailRejected('邮箱格式不正确。')
  const match = /^([a-z0-9!#$%&'*+/=?^_`{|}~.-]+)@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/.exec(value)
  if (!match) throw new EmailRejected('邮箱格式不正确。')
  const domain = match[2]!
  if (BLOCKED_DOMAINS.has(domain) || [...BLOCKED_DOMAINS].some(blocked => domain.endsWith(`.${blocked}`))) {
    throw new EmailRejected('暂不支持临时邮箱，请使用长期邮箱。')
  }
  const local = match[1]!
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    throw new EmailRejected('邮箱格式不正确。')
  }
  return value
}

/** `a***z@example.com` — enough for the owner to recognize, not enough to leak. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  if (local.length <= 1) return `*@${domain}`
  if (local.length === 2) return `${local[0]}*@${domain}`
  return `${local[0]}***${local[local.length - 1]}@${domain}`
}

export function extraDisposableDomains(): readonly string[] {
  return (process.env.DSH_MESH_DISPOSABLE_EMAIL_DOMAINS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
}
