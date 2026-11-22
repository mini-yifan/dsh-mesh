/**
 * Entry point for hosted mode.
 *
 * Mounted by `main.tsx` only when the server advertises account mode, so the
 * personal-mode bundle and its routes are untouched.
 */
import { useCallback, useEffect, useState } from 'react'
import { PortalError, loadMe, type PortalAccount } from './portal-api'
import { PortalLogin } from './PortalLogin'
import { PortalDevices } from './PortalDevices'
import { PortalAdmin, type AdminView } from './PortalAdmin'
import { PortalLink } from './PortalLink'
import { ThemeToggle } from './ThemeToggle'
import './orb.css'

type Route =
  | { name: 'login' }
  | { name: 'devices' }
  | { name: 'admin'; view: AdminView }
  | { name: 'link'; linkId: string }

function currentRoute(): Route {
  const path = window.location.pathname
  if (path === '/link') {
    const linkId = new URLSearchParams(window.location.search).get('t') ?? ''
    return { name: 'link', linkId }
  }
  if (path === '/app/admin' || path === '/app/admin/overview') return { name: 'admin', view: 'overview' }
  if (path === '/app/admin/accounts') return { name: 'admin', view: 'accounts' }
  if (path === '/app/devices' || path === '/app/remote') return { name: 'devices' }
  return { name: 'login' }
}

function pathFor(route: Route): string {
  switch (route.name) {
    case 'link': return `/link?t=${encodeURIComponent(route.linkId)}`
    case 'devices': return '/app/devices'
    case 'admin': return route.view === 'accounts' ? '/app/admin/accounts' : '/app/admin'
    default: return '/'
  }
}

export function PortalApp() {
  const [route, setRoute] = useState<Route>(currentRoute)
  const [account, setAccount] = useState<PortalAccount>()
  const [isAdmin, setIsAdmin] = useState(false)
  const [checking, setChecking] = useState(true)

  const navigate = useCallback((next: Route) => {
    const path = pathFor(next)
    if (window.location.pathname + window.location.search !== path) window.history.pushState({}, '', path)
    setRoute(next)
  }, [])

  useEffect(() => {
    const onPop = () => setRoute(currentRoute())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Resolve the session once. A 401 is the normal signed-out state.
  useEffect(() => {
    void loadMe()
      .then(me => {
        setAccount(me.account)
        setIsAdmin(me.isAdmin)
        setRoute(current => (current.name === 'login' ? { name: 'devices' } : current))
      })
      .catch(() => setAccount(undefined))
      .finally(() => setChecking(false))
  }, [])

  if (checking) {
    return (
      <div className="orb-shell">
        <main className="orb-main">
          <div className="orb-empty">
            <p className="orb-empty-sub">
              <span className="orb-spinner" style={{ display: 'inline-block', verticalAlign: 'middle' }} /> 正在检查登录状态…
            </p>
          </div>
        </main>
      </div>
    )
  }

  // The link page owns its own sign-in so the approval flow is never interrupted
  // by a route change.
  if (route.name === 'link') {
    if (!/^[0-9a-f-]{36}$/i.test(route.linkId)) {
      return (
        <div className="orb-shell">
          <main className="orb-main">
            <h1 className="orb-page-title">连接请求无效</h1>
            <p className="orb-page-sub">回到设备上的「互联」设置，重新打开开关即可生成新的请求。</p>
          </main>
        </div>
      )
    }
    return <PortalLink linkId={route.linkId} />
  }

  // The admin routes are gated again server-side; this is only so an account
  // that is not an administrator never lands on a shell it cannot fill.
  if (route.name === 'admin' && account && isAdmin) {
    return (
      <>
        <ThemeToggleFloating />
        <PortalAdmin
          view={route.view}
          emailMasked={account.emailMasked}
          onNavigate={view => navigate({ name: 'admin', view })}
          onSignedOut={() => { setAccount(undefined); setIsAdmin(false); navigate({ name: 'login' }) }}
        />
      </>
    )
  }

  // A non-administrator asking for an admin path gets the ordinary portal, not
  // a blank page: the URL is guessable and a dead end would be confusing.
  if (route.name === 'admin' && account) {
    return (
      <>
        <ThemeToggleFloating />
        <PortalDevices
          isAdmin={false}
          onSignedOut={() => { setAccount(undefined); setIsAdmin(false); navigate({ name: 'login' }) }}
        />
      </>
    )
  }

  if (route.name === 'devices' && account) {
    return (
      <>
        <ThemeToggleFloating />
        <PortalDevices
          isAdmin={isAdmin}
          onOpenAdmin={() => navigate({ name: 'admin', view: 'overview' })}
          onSignedOut={() => { setAccount(undefined); setIsAdmin(false); navigate({ name: 'login' }) }}
        />
      </>
    )
  }

  return (
    <>
      <ThemeToggleFloating />
      <PortalLogin
        onSignedIn={signedIn => { setAccount(signedIn); navigate({ name: 'devices' }) }}
        initialNotice={undefined}
      />
    </>
  )
}

/** Theme switch pinned to the corner so it never competes with page actions. */
function ThemeToggleFloating() {
  return (
    <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 20 }}>
      <div style={{
        background: 'var(--orb-surface)',
        border: '1px solid var(--orb-border)',
        borderRadius: 'var(--orb-radius-pill)',
        boxShadow: 'var(--orb-shadow)',
        padding: 2,
      }}>
        <ThemeToggle />
      </div>
    </div>
  )
}

export { PortalError }
