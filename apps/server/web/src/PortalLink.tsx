/**
 * Device approval page — the web half of the link hand-off.
 *
 * Opened by the plugin with `?t=<linkId>`. The URL deliberately carries no
 * secret: approval requires a signed-in session, and the resulting credentials
 * are only released to whoever can prove it holds the nonce.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  PortalError,
  approveLink,
  describeLink,
  loadMe,
  platformLabel,
  type LinkDescription,
  type PortalAccount,
} from './portal-api'
import { PortalLogin } from './PortalLogin'

interface Props {
  linkId: string
  /** Called after approval so the page can show the "return to your device" state. */
  onApproved?(): void
}

export function PortalLink({ linkId, onApproved }: Props) {
  const [description, setDescription] = useState<LinkDescription>()
  const [account, setAccount] = useState<PortalAccount>()
  const [state, setState] = useState<'loading' | 'needs-login' | 'ready' | 'approving' | 'done' | 'failed'>('loading')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const described = await describeLink(linkId)
      setDescription(described)
      if (described.approved) { setState('done'); return }
      try {
        const me = await loadMe()
        setAccount(me.account)
        setState('ready')
      } catch (failure) {
        if ((failure as PortalError).status === 401) { setState('needs-login'); return }
        throw failure
      }
    } catch (failure) {
      const portalError = failure as PortalError
      setError(portalError.message)
      setState('failed')
    }
  }, [linkId])

  useEffect(() => { void load() }, [load])

  async function approve() {
    setState('approving'); setError('')
    try {
      await approveLink(linkId)
      setState('done')
      onApproved?.()
    } catch (failure) {
      setError((failure as PortalError).message)
      setState('failed')
    }
  }

  if (state === 'needs-login') {
    return (
      <PortalLogin
        initialNotice="先登录，再授权这台设备。"
        onSignedIn={signedIn => { setAccount(signedIn); setState('ready') }}
      />
    )
  }

  const deviceName = description?.deviceName ?? '这台设备'
  const platform = description ? platformLabel(description.platform) : ''

  return (
    <div className="orb-shell">
      <header className="orb-topbar">
        <span className="orb-brand"><span className="orb-ball" data-state={state === 'done' ? 'online' : 'idle'} />DSH Orb·互联</span>
      </header>

      <main className="orb-main">
        {state === 'loading' && (
          <div className="orb-empty">
            <p className="orb-empty-sub"><span className="orb-spinner" style={{ display: 'inline-block', verticalAlign: 'middle' }} /> 正在读取连接请求…</p>
          </div>
        )}

        {state === 'failed' && (
          <>
            <h1 className="orb-page-title">连接请求无效</h1>
            <div className="orb-notice is-error">{error}</div>
            <p className="orb-hint">回到设备上的「互联」设置，重新点一次开关即可生成新的请求。</p>
          </>
        )}

        {(state === 'ready' || state === 'approving') && (
          <>
            <div className="orb-link-hero">
              <h1 className="orb-page-title">授权这台设备</h1>
              <p className="orb-page-sub" style={{ marginBottom: 0 }}>
                授权后，它会加入你的账号，和你的其他设备互相可见。
              </p>
              <div className="orb-link-device">
                <span className="orb-ball" data-state="online" />
                <span>{deviceName}</span>
                {platform && <span style={{ color: 'var(--orb-muted)', fontWeight: 400 }}>· {platform}</span>}
              </div>
            </div>

            {error && <div className="orb-notice is-error">{error}</div>}

            <div className="orb-card">
              <div className="orb-card-body">
                {account && (
                  <div className="orb-notice is-info" style={{ marginBottom: 16 }}>
                    将授权到这个账号：{account.emailMasked}
                  </div>
                )}
                <button
                  className="orb-button is-primary is-block"
                  type="button"
                  disabled={state === 'approving'}
                  onClick={() => void approve()}
                >
                  {state === 'approving' ? <><span className="orb-spinner" />授权中…</> : '授权并完成'}
                </button>
                <p className="orb-hint">
                  只有你能看到这个页面。授权后这台设备会拿到自己的凭证，服务器不会把你的账号密码交给它。
                </p>
              </div>
            </div>
          </>
        )}

        {state === 'done' && (
          <div className="orb-link-hero">
            <h1 className="orb-page-title">已授权</h1>
            <p className="orb-page-sub">
              {deviceName} 已经加入你的账号。可以关掉这个页面，回到设备上的互联设置了。
            </p>
            <div className="orb-link-device">
              <span className="orb-ball" data-state="online" />
              <span>{deviceName} 已连接</span>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
