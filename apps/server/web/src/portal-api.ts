/**
 * Hosted-mode API client.
 *
 * Kept separate from `api.ts` so the personal-mode bundle stays untouched.
 * Every call is same-origin with the session cookie; no token is ever stored in
 * JavaScript, which is why the cookie is HttpOnly.
 */

export interface PortalAccount {
  email: string
  emailMasked: string
  createdAt: number
}

export interface PortalMe {
  account: PortalAccount
  isAdmin: boolean
  serverUrl: string
}

export interface PortalDevice {
  nodeId: string
  name: string
  platform: string
  createdAt: number
  hostDeviceId: string
  clientDeviceId?: string
  harnessVersion?: string
  appVersion?: string
  online: boolean
  lastSeenAt?: number
}

export interface PortalConfig {
  mode: 'account'
  serverUrl: string
  mail: { transport: 'console' | 'smtp'; appName: string }
  requiresInvite: boolean
  codeTtlSeconds: number
  resendAfter: number
}

export interface LinkDescription {
  deviceName: string
  platform: string
  createdAt: number
  expiresAt: number
  /** The browser has approved this link. */
  approved: boolean
  /** The device has collected its credentials; the hand-off is complete. */
  consumed: boolean
  /** The node the approval created, once approved. */
  deviceId?: string
  /** True when the session viewing the page is the one that approved. */
  approvedByViewer: boolean
}

export class PortalError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message)
  }
}

/** Human-readable text for the error codes the server can return. */
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL: '邮箱格式不正确，请检查后重试。',
  RATE_LIMITED_TOO_SOON: '刚发过一封，请稍等片刻再试。',
  RATE_LIMITED_EMAIL_DAILY_LIMIT: '这个邮箱今天发送次数已达上限。',
  RATE_LIMITED_IP_HOURLY_LIMIT: '当前网络发送过于频繁，请稍后再试。',
  RATE_LIMITED_IP_DAILY_LIMIT: '当前网络今日发送次数已达上限。',
  RATE_LIMITED: '请求过于频繁，请稍后再试。',
  CODE_INVALID: '验证码不正确，请重新输入。',
  CODE_EXPIRED: '验证码已过期，请重新获取。',
  CODE_LOCKED: '错误次数过多，请重新获取验证码。',
  MAIL_UNAVAILABLE: '邮件暂时发不出去，请稍后再试。',
  ACCOUNT_AUTH_REQUIRED: '登录已过期，请重新登录。',
  ADMIN_REQUIRED: '这个账号没有管理员权限。',
  LINK_NOT_FOUND: '这个连接请求不存在或已失效。',
  LINK_EXPIRED: '这个连接请求已过期，请在设备上重新发起。',
  LINK_CONSUMED: '这个连接请求已经被使用过了。',
  LINK_ALREADY_APPROVED: '这个设备已经被授权过了。',
  LINK_PENDING: '等待授权中。',
  INTERNAL_ERROR: '服务出了点问题，请稍后再试。',
}

export async function portal<T>(path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: body === undefined ? (init.method ?? 'GET') : 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new PortalError('网络连接失败，请检查网络后重试。', 'NETWORK', 0)
  }
  let data: any = {}
  try { data = await response.json() } catch { /* empty body is fine */ }
  if (!response.ok) {
    const code = String(data?.error?.code ?? 'INTERNAL_ERROR')
    throw new PortalError(MESSAGES[code] ?? '请求失败，请稍后重试。', code, response.status)
  }
  return data as T
}

export interface SentCode {
  challengeId: string
  emailMasked: string
  expiresIn: number
  resendAfter: number
}

export const sendCode = (email: string) =>
  portal<SentCode>('/auth/email/send', { email })

export const verifyCode = (email: string, challengeId: string, code: string) =>
  portal<{ newAccount: boolean; account: PortalAccount }>('/auth/email/verify', { email, challengeId, code })

export const signOut = () => portal<{ status: string }>('/auth/signout', {})

export const loadMe = () => portal<PortalMe>('/portal/me')

export const loadDevices = () => portal<{ items: PortalDevice[]; serverUrl: string }>('/portal/devices')

export const loadConfig = () => portal<PortalConfig>('/account/config')

export interface PairingCode {
  id: string
  label: string
  platform?: string
  createdAt: number
  expiresAt: number
  usedAt?: number
  revokedAt?: number
  pairing: string
}

export const createPairingCode = (label: string, platform?: string) =>
  portal<PairingCode>('/portal/pairing-codes', { label, ...(platform ? { platform } : {}) })

export const listPairingCodes = () => portal<{ items: PairingCode[] }>('/portal/pairing-codes')

export const revokePairingCode = (id: string) =>
  portal<{ status: string }>(`/portal/pairing-codes/${id}`, undefined, { method: 'DELETE' })

export const revokeDevice = (nodeId: string) =>
  portal<{ status: string }>('/portal/devices/revoke', { nodeId })

export const describeLink = (linkId: string) =>
  portal<LinkDescription>(`/link/describe?linkId=${encodeURIComponent(linkId)}`)

export const approveLink = (linkId: string) =>
  portal<{ status: string }>('/link/approve', { linkId })

/** One row of the admin user table. `email` is in clear; the page masks it. */
export interface AdminUser {
  email: string
  emailMasked: string
  createdAt: number
  lastLoginAt: number
  sessions: number
  devices: number
  devicesOnline: number
  isAdmin: boolean
}

export interface AdminActivityDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string
  newAccounts: number
  codeRequests: number
}

export interface AdminStats {
  generatedAt: number
  users: {
    total: number
    newToday: number
    newLast7Days: number
    newLast30Days: number
    activeLast7Days: number
  }
  devices: {
    total: number
    online: number
    offline: number
    deviceRecords: number
    byPlatform: Record<string, number>
  }
  activity: AdminActivityDay[]
  list: AdminUser[]
}

export const loadAdminStats = () => portal<AdminStats>('/admin/stats')

/** Platform ids map to the labels the desktop orb uses. */
export function platformLabel(platform: string): string {
  switch (platform) {
    case 'darwin': return 'macOS'
    case 'win32': return 'Windows'
    case 'linux': return 'Linux'
    case 'android': return 'Android'
    default: return platform || '未知设备'
  }
}

export function relativeTime(timestamp?: number): string {
  if (!timestamp) return '从未在线'
  const seconds = Math.round((Date.now() - timestamp) / 1000)
  if (seconds < 60) return '刚刚在线'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前在线`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前在线`
  return `${Math.floor(seconds / 86400)} 天前在线`
}

/**
 * The same elapsed-time scale, phrased for a moment that is not "online" —
 * a registration or a sign-in. `relativeTime` cannot be reused with a string
 * replace: "刚刚在线" and "3 天前在线" do not share one suffix rule.
 */
export function elapsedSince(timestamp?: number): string {
  if (!timestamp) return '—'
  const seconds = Math.round((Date.now() - timestamp) / 1000)
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86400)} 天前`
}
