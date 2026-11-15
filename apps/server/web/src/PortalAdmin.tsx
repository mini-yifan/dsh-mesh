/**
 * Server-wide reports for the operator.
 *
 * Separate from `PortalDevices` on purpose: that page answers "what is mine",
 * this one answers "who is using this server". It is gated twice — the route
 * refuses non-admins, and `PortalApp` only routes here when `/portal/me` said
 * `isAdmin`, so a curious visitor never sees the empty shell of a report they
 * cannot read.
 *
 * Split into two views because they scale differently. The overview is a fixed
 * set of aggregates; the account list is unbounded, so it lives on its own page
 * and is fetched one page at a time. Rendering both in one column would turn
 * into an endless scroll on any server with real usage.
 *
 * Addresses are masked in the table for the same reason the login page masks
 * them: a screenshot or a shared screen should not leak somebody's mailbox.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  PortalError,
  elapsedSince,
  loadAdminAccounts,
  loadAdminStats,
  platformLabel,
  signOut,
  type AdminAccountSort,
  type AdminAccountsPage,
  type AdminActivityDay,
  type AdminStats,
  type AdminUser,
} from './portal-api'

export type AdminView = 'overview' | 'accounts'

interface Props {
  view: AdminView
  /** Signed-in account, for the header. */
  emailMasked: string
  onNavigate(view: AdminView): void
  onSignedOut(): void
}

const PAGE_SIZE = 50

export function PortalAdmin({ view, emailMasked, onNavigate, onSignedOut }: Props) {
  const [stats, setStats] = useState<AdminStats>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const handleFailure = useCallback((failure: unknown) => {
    const portalError = failure as PortalError
    if (portalError.status === 401) { onSignedOut(); return }
    setError(portalError.message)
  }, [onSignedOut])

  // The sidebar's badge numbers come from the overview, so it is fetched even
  // while the account list is the visible view.
  const refresh = useCallback(async () => {
    setError('')
    try {
      setStats(await loadAdminStats())
    } catch (failure) {
      handleFailure(failure)
    } finally {
      setLoading(false)
    }
  }, [handleFailure])

  useEffect(() => { void refresh() }, [refresh])

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

      <div className="orb-admin">
        <nav className="orb-admin-nav" aria-label="管理员">
          <NavItem
            label="概览"
            active={view === 'overview'}
            onClick={() => onNavigate('overview')}
          />
          <NavItem
            label="账号"
            active={view === 'accounts'}
            {...(stats === undefined ? {} : { badge: stats.users.total })}
            onClick={() => onNavigate('accounts')}
          />
        </nav>

        <main className="orb-admin-main">
          {error && <div className="orb-notice is-error">{error}</div>}

          {view === 'overview' ? (
            <AdminOverview stats={stats} loading={loading} onOpenAccounts={() => onNavigate('accounts')} />
          ) : (
            <AdminAccounts onFailure={handleFailure} />
          )}
        </main>
      </div>
    </div>
  )
}

function NavItem({ label, active, badge, onClick }: {
  label: string
  active: boolean
  badge?: number
  onClick(): void
}) {
  return (
    <button
      className={`orb-admin-nav-item${active ? ' is-active' : ''}`}
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <span>{label}</span>
      {badge !== undefined && <span className="orb-admin-nav-badge">{badge}</span>}
    </button>
  )
}

function AdminOverview({ stats, loading, onOpenAccounts }: {
  stats: AdminStats | undefined
  loading: boolean
  onOpenAccounts(): void
}) {
  return (
    <>
      <h1 className="orb-page-title">概览</h1>
      <p className="orb-page-sub">
        {loading
          ? '正在加载…'
          : stats
            ? `共 ${stats.users.total} 个账号、${stats.devices.total} 台设备 · ${elapsedSince(stats.generatedAt)}更新`
            : '服务器概况'}
      </p>

      {stats && (
        <>
          <div className="orb-card">
            <div className="orb-card-head">
              <h2>用户</h2>
              <button className="orb-button is-ghost is-small" type="button" onClick={onOpenAccounts}>查看账号明细</button>
            </div>
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

          <p className="orb-hint">
            设备记录是网关里的角色数：授权时先登记主机角色，插件拿到凭证后再登记客户端角色。
            两个数字相等说明每台设备都完成了这两步。
          </p>
        </>
      )}
    </>
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

/**
 * The paged account table.
 *
 * Every page is one request, so the tab stays responsive on a server with tens
 * of thousands of accounts. Search and sort are server-side for the same
 * reason: filtering only the fifty rows already loaded would look like a bug.
 */
function AdminAccounts({ onFailure }: { onFailure(failure: unknown): void }) {
  const [page, setPage] = useState<AdminAccountsPage>()
  const [loading, setLoading] = useState(true)
  /** What the user typed; `query` is the debounced value actually requested. */
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<AdminAccountSort>('lastLogin')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')

  // Typing must not fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(draft.trim())
      setOffset(0)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [draft])

  const read = useCallback(async () => {
    setLoading(true)
    try {
      setPage(await loadAdminAccounts({ offset, limit: PAGE_SIZE, ...(query ? { query } : {}), sort, direction }))
    } catch (failure) {
      onFailure(failure)
    } finally {
      setLoading(false)
    }
  }, [offset, query, sort, direction, onFailure])

  useEffect(() => { void read() }, [read])

  const total = page?.total ?? 0
  const first = total === 0 ? 0 : offset + 1
  const last = Math.min(offset + PAGE_SIZE, total)
  const canPrev = offset > 0
  const canNext = last < total

  function toggleSort(next: AdminAccountSort) {
    if (sort === next) { setDirection(direction === 'desc' ? 'asc' : 'desc') }
    else { setSort(next); setDirection('desc') }
    setOffset(0)
  }

  return (
    <>
      <h1 className="orb-page-title">账号明细</h1>
      <p className="orb-page-sub">
        {page === undefined ? '正在加载…' : `${total} 个账号 · 每页 ${PAGE_SIZE} 条`}
      </p>

      <div className="orb-card">
        <div className="orb-card-head">
          <h2>账号</h2>
          <span className="orb-count">{total === 0 ? '0' : `${first}–${last} / ${total}`}</span>
        </div>

        <div className="orb-card-body" style={{ paddingBottom: 10 }}>
          <input
            className="orb-input"
            placeholder="按邮箱筛选"
            value={draft}
            onChange={event => setDraft(event.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {loading && page === undefined ? (
          <div className="orb-empty">
            <p className="orb-empty-sub"><span className="orb-spinner" style={{ display: 'inline-block', verticalAlign: 'middle' }} /> 正在加载账号…</p>
          </div>
        ) : total === 0 ? (
          <div className="orb-empty">
            <p className="orb-empty-sub">{query === '' ? '还没有账号。' : `没有匹配「${query}」的账号。`}</p>
          </div>
        ) : (
          <div className="orb-table-wrap">
            <table className="orb-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>
                    <SortHeader label="注册" active={sort === 'created'} direction={direction} onClick={() => toggleSort('created')} />
                  </th>
                  <th>
                    <SortHeader label="最后登录" active={sort === 'lastLogin'} direction={direction} onClick={() => toggleSort('lastLogin')} />
                  </th>
                  <th className="is-num">设备</th>
                  <th className="is-num">在线</th>
                </tr>
              </thead>
              <tbody>
                {(page?.items ?? []).map(user => <AdminRow key={user.email} user={user} />)}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE_SIZE && (
          <div className="orb-pager">
            <button
              className="orb-button is-ghost is-small"
              type="button"
              disabled={!canPrev || loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              上一页
            </button>
            <span className="orb-pager-status">{first}–{last} / {total}</span>
            <button
              className="orb-button is-ghost is-small"
              type="button"
              disabled={!canNext || loading}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              下一页
            </button>
          </div>
        )}
      </div>

      <p className="orb-hint">
        账号地址在列表里已脱敏。设备数是该账号在互联里登记的设备台数，在线数来自当前网关连接。
      </p>
    </>
  )
}

function SortHeader({ label, active, direction, onClick }: {
  label: string
  active: boolean
  direction: 'asc' | 'desc'
  onClick(): void
}) {
  return (
    <button className={`orb-sort${active ? ' is-active' : ''}`} type="button" onClick={onClick}>
      {label}
      {active && <span aria-hidden="true">{direction === 'desc' ? '↓' : '↑'}</span>}
    </button>
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
            // A zero bar would still render as a hairline, which reads as "a
            // small value" rather than "nothing happened". Drop the bar
            // entirely and let the baseline stand for zero.
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
