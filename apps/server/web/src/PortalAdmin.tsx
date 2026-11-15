/**
 * Server-wide reports for the operator.
 *
 * Separate from `PortalDevices` on purpose: that page answers "what is mine",
 * this one answers "who is using this server". It is gated twice — the route
 * refuses non-admins, and `PortalApp` only routes here when `/portal/me` said
 * `isAdmin`, so a curious visitor never sees the empty shell of a report they
 * cannot read.
 *
 * Addresses are masked in the table for the same reason the login page masks
 * them: a screenshot or a shared screen should not leak somebody's mailbox.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  PortalError,
  elapsedSince,
  loadAdminStats,
  platformLabel,
  signOut,
  type AdminActivityDay,
  type AdminStats,
  type AdminUser,
} from './portal-api'

interface Props {
  /** Signed-in account, for the header. */
  emailMasked: string
  onSignedOut(): void
}

export function PortalAdmin({ emailMasked, onSignedOut }: Props) {
  const [stats, setStats] = useState<AdminStats>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  /** Empty means "all users"; otherwise a case-insensitive substring of the email. */
  const [query, setQuery] = useState('')

  const refresh = useCallback(async () => {
    setError('')
    try {
      setStats(await loadAdminStats())
    } catch (failure) {
      const portalError = failure as PortalError
      if (portalError.status === 401) { onSignedOut(); return }
      setError(portalError.message)
    } finally {
      setLoading(false)
    }
  }, [onSignedOut])

  useEffect(() => { void refresh() }, [refresh])

  // Presence moves without anybody touching this page.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadAdminStats().then(setStats).catch(() => undefined)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  async function logout() {
    try { await signOut() } catch { /* sign out locally regardless */ }
    onSignedOut()
  }

  const needle = query.trim().toLowerCase()
  const rows = (stats?.list ?? []).filter(user => needle === '' || user.email.toLowerCase().includes(needle))

  return (
    <div className="orb-shell">
      <header className="orb-topbar">
        <span className="orb-brand">
          <span className="orb-ball" data-state={(stats?.devices.online ?? 0) > 0 ? 'online' : 'idle'} />
          DSH Orb·互联
        </span>
        <span className="orb-topbar-spacer" />
        <a className="orb-button is-ghost is-small orb-topbar-link" href="/app/devices">我的设备</a>
        <span style={{ color: 'var(--orb-muted)', fontSize: 13 }}>{emailMasked}</span>
        <button className="orb-button is-ghost is-small" type="button" onClick={() => void logout()}>退出登录</button>
      </header>

      <main className="orb-main is-wide">
        <h1 className="orb-page-title">管理员</h1>
        <p className="orb-page-sub">
          {loading
            ? '正在加载…'
            : stats
              ? `共 ${stats.users.total} 个账号、${stats.devices.total} 台设备 · ${elapsedSince(stats.generatedAt)}更新`
              : '服务器概况'}
        </p>

        {error && <div className="orb-notice is-error">{error}</div>}

        {stats && (
          <>
            <div className="orb-card">
              <div className="orb-card-head"><h2>用户</h2></div>
              <div className="orb-stat-grid">
                <Stat label="总账号" value={stats.users.total} />
                <Stat label="今日新增" value={stats.users.newToday} />
                <Stat label="近 7 天新增" value={stats.users.newLast7Days} />
                <Stat label="近 30 天新增" value={stats.users.newLast30Days} />
                <Stat label="近 7 天登录过" value={stats.users.activeLast7Days} />
              </div>
            </div>

            <div className="orb-card">
              <div className="orb-card-head">
                <h2>设备</h2>
                <span className="orb-count">{stats.devices.online}/{stats.devices.total} 在线</span>
              </div>
              <div className="orb-stat-grid">
                <Stat label="已登记" value={stats.devices.total} />
                <Stat label="在线" value={stats.devices.online} tone="ok" />
                <Stat label="离线" value={stats.devices.offline} />
                <Stat label="设备记录" value={stats.devices.deviceRecords} />
              </div>
              {Object.keys(stats.devices.byPlatform).length > 0 && (
                <div className="orb-card-body" style={{ paddingTop: 0 }}>
                  <div className="orb-platform-row">
                    {Object.entries(stats.devices.byPlatform)
                      .sort((left, right) => right[1] - left[1])
                      .map(([platform, count]) => (
                        <span className="orb-pill" key={platform}>{platformLabel(platform)} {count}</span>
                      ))}
                  </div>
                </div>
              )}
            </div>

            <ActivityChart days={stats.activity} />

            <div className="orb-card">
              <div className="orb-card-head">
                <h2>账号明细</h2>
                <span className="orb-count">{rows.length}/{stats.list.length}</span>
              </div>
              <div className="orb-card-body" style={{ paddingBottom: 8 }}>
                <input
                  className="orb-input"
                  placeholder="按邮箱筛选"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              {rows.length === 0 ? (
                <div className="orb-empty">
                  <p className="orb-empty-sub">{stats.list.length === 0 ? '还没有账号。' : '没有匹配的账号。'}</p>
                </div>
              ) : (
                <div className="orb-table-wrap">
                  <table className="orb-table">
                    <thead>
                      <tr>
                        <th>账号</th>
                        <th>注册</th>
                        <th>最后登录</th>
                        <th className="is-num">设备</th>
                        <th className="is-num">在线</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(user => (
                        <AdminRow key={user.email} user={user} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <p className="orb-hint">
              设备记录是网关里的角色数：授权时先登记主机角色，插件拿到凭证后再登记客户端角色。
              两个数字相等说明每台设备都完成了这两步。账号地址在列表里已脱敏。
            </p>
          </>
        )}
      </main>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' }) {
  return (
    <div className="orb-stat">
      <span className={`orb-stat-value${tone === 'ok' ? ' is-ok' : ''}`}>{value}</span>
      <span className="orb-stat-label">{label}</span>
    </div>
  )
}

function AdminRow({ user }: { user: AdminUser }) {
  return (
    <tr>
      <td>
        <span className="orb-table-primary">{user.emailMasked}</span>
        {user.isAdmin && <span className="orb-pill is-pending" style={{ marginLeft: 8 }}>管理员</span>}
      </td>
      <td>{elapsedSince(user.createdAt)}</td>
      <td>{elapsedSince(user.lastLoginAt)}</td>
      <td className="is-num">{user.devices}</td>
      <td className="is-num">{user.devicesOnline}</td>
    </tr>
  )
}

/**
 * Seven-day activity as two bars per day.
 *
 * Plain divs rather than a chart library: the numbers are tiny, a dependency
 * would outweigh them, and CSS keeps the orb look without a theme override.
 */
function ActivityChart({ days }: { days: AdminActivityDay[] }) {
  const peak = Math.max(1, ...days.map(day => Math.max(day.newAccounts, day.codeRequests)))
  return (
    <div className="orb-card">
      <div className="orb-card-head">
        <h2>近 7 天</h2>
        <span className="orb-count">
          <span className="orb-legend-dot is-accounts" />新增账号
          <span className="orb-legend-dot is-requests" />验证码请求
        </span>
      </div>
      <div className="orb-card-body">
        <div className="orb-chart" role="img" aria-label="近 7 天新增账号与验证码请求">
          {days.map(day => {
            // A zero bar would still render as a hairline (min-height), which
            // reads as "a small value" rather than "nothing happened". Drop the
            // bar entirely and let the baseline stand for zero.
            const barHeight = (value: number) => value === 0 ? 0 : Math.max(4, Math.round((value / peak) * 100))
            return (
              <div className="orb-chart-col" key={day.date}>
                <div className="orb-chart-bars">
                  {day.newAccounts > 0 && (
                    <div
                      className="orb-chart-bar is-accounts"
                      style={{ height: `${barHeight(day.newAccounts)}%` }}
                      title={`${day.date} 新增账号 ${day.newAccounts}`}
                    />
                  )}
                  {day.codeRequests > 0 && (
                    <div
                      className="orb-chart-bar is-requests"
                      style={{ height: `${barHeight(day.codeRequests)}%` }}
                      title={`${day.date} 验证码请求 ${day.codeRequests}`}
                    />
                  )}
                </div>
                <span className="orb-chart-label">{day.date.slice(5)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
