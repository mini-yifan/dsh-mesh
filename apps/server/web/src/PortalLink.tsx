/**
 * Device approval page — the web half of the link hand-off.
 *
 * Opened by the plugin with `?t=<linkId>`. The URL deliberately carries no
 * secret: approval requires a signed-in session, and the resulting credentials
 * are only released to whoever can prove it holds the nonce.
 *
 * Two things this page has to get right beyond "one button":
 *
 *  - The account it authorizes is the browser's, not necessarily the intended
 *    one. Someone signing in on a borrowed browser must be able to leave that
 *    account before their device is bound to it, so switching accounts is an
 *    action on this page rather than a trip to another URL.
 *  - Approval is not the end of the story: the user wants to see what the
 *    account now contains — the newcomer online, the machines that were already
 *    linked, and which of those are currently offline.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  PortalError,
  approveLink,
  describeLink,
  loadDevices,
  loadMe,
  platformLabel,
  relativeTime,
  signOut,
  type LinkDescription,
  type PortalAccount,
  type PortalDevice,
} from './portal-api'
import { PortalLogin } from './PortalLogin'

interface Props {
  linkId: string
  /** Called after approval so the page can show the "return to your device" state. */
  onApproved?(): void
}

type Stage = 'loading' | 'needs-login' | 'ready' | 'approving' | 'done' | 'failed'

export function PortalLink({ linkId, onApproved }: Props) {
  const [description, setDescription] = useState<LinkDescription>()
  const [account, setAccount] = useState<PortalAccount>()
  const [stage, setStage] = useState<Stage>('loading')
  const [error, setError] = useState('')
  /** Set while the user is deliberately signing in as somebody else. */
  const [switching, setSwitching] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      const described = await describeLink(linkId)
      setDescription(described)
      // A finished hand-off stays finished across reloads: the plugin collected
      // its credentials within seconds, and reporting "invalid request" here
      // would read as a failure of an authorization that worked.
      if (described.approved) {
        setStage('done')
        return
      }
      try {
        const me = await loadMe()
        setAccount(me.account)
        setStage('ready')
      } catch (failure) {
        if ((failure as PortalError).status === 401) { setStage('needs-login'); return }
        throw failure
      }
    } catch (failure) {
      const portalError = failure as PortalError
      setError(portalError.message)
      setStage('failed')
    }
  }, [linkId])

  useEffect(() => { void load() }, [load])

  async function approve() {
    setStage('approving'); setError('')
    try {
      await approveLink(linkId)
      // Re-read so the page learns the node id it just created; the device list
      // highlights that row instead of making the user hunt for it.
      const described = await describeLink(linkId).catch(() => undefined)
      if (described) setDescription(described)
      setStage('done')
      onApproved?.()
    } catch (failure) {
      setError((failure as PortalError).message)
      setStage('failed')
    }
  }

  /** Leave the current account so the next sign-in binds the device elsewhere. */
  async function switchAccount() {
    setError('')
    try { await signOut() } catch { /* the cookie may already be gone; sign in anyway */ }
    setAccount(undefined)
    setSwitching(true)
    setStage('needs-login')
  }

  if (stage === 'needs-login') {
    return (
      <PortalLogin
        initialNotice={switching ? '已退出原来的账号。用要授权的账号登录。' : '先登录，再授权这台设备。'}
        onSignedIn={signedIn => {
          setAccount(signedIn)
          setSwitching(false)
          setStage('ready')
        }}
      />
    )
  }

  const deviceName = description?.deviceName ?? '这台设备'
  const platform = description ? platformLabel(description.platform) : ''

  return (
    <div className="orb-shell">
      <header className="orb-topbar">
        <span className="orb-brand"><span className="orb-ball" data-state={stage === 'done' ? 'online' : 'idle'} />DSH Orb·互联</span>
        <span className="orb-topbar-spacer" />
        {/* Reachable at every stage: someone comparing accounts or checking an
            existing device should not have to finish this page first. */}
        <a className="orb-button is-ghost is-small orb-topbar-link" href="/app/devices">网站主页</a>
        {account && stage !== 'done' && (
          <>
            <span style={{ color: 'var(--orb-muted)', fontSize: 13 }}>{account.emailMasked}</span>
            <button
              className="orb-button is-ghost is-small"
              type="button"
              disabled={stage === 'approving'}
              onClick={() => void switchAccount()}
            >
              切换账号
            </button>
          </>
        )}
      </header>

      <main className="orb-main">
        {stage === 'loading' && (
          <div className="orb-empty">
            <p className="orb-empty-sub"><span className="orb-spinner" style={{ display: 'inline-block', verticalAlign: 'middle' }} /> 正在读取连接请求…</p>
          </div>
        )}

        {stage === 'failed' && (
          <>
            <h1 className="orb-page-title">连接请求无效</h1>
            <div className="orb-notice is-error">{error}</div>
            <p className="orb-hint">回到设备上的「互联」设置，重新点一次开关即可生成新的请求。</p>
          </>
        )}

        {(stage === 'ready' || stage === 'approving') && (
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
                  disabled={stage === 'approving'}
                  onClick={() => void approve()}
                >
                  {stage === 'approving' ? <><span className="orb-spinner" />授权中…</> : '授权并完成'}
                </button>
                {account && (
                  <p className="orb-hint" style={{ textAlign: 'center' }}>
                    不是这个账号？
                    <button
                      className="orb-button is-ghost is-small"
                      type="button"
                      disabled={stage === 'approving'}
                      style={{ marginLeft: 4, padding: '2px 6px' }}
                      onClick={() => void switchAccount()}
                    >
                      换一个账号登录
                    </button>
                  </p>
                )}
                <p className="orb-hint">
                  只有你能看到这个页面。授权后这台设备会拿到自己的凭证，服务器不会把你的账号密码交给它。
                </p>
              </div>
            </div>
          </>
        )}

        {stage === 'done' && (
          <LinkDone
            deviceId={description?.deviceId}
            deviceName={deviceName}
          />
        )}
      </main>
    </div>
  )
}

/**
 * The post-approval view: this device plus everything else on the account.
 *
 * Listing all devices is the point. "已授权" alone leaves the user guessing
 * whether the rest of their account is reachable, so the same rows the portal
 * shows are rendered here, newcomer first and highlighted.
 */
function LinkDone({ deviceId, deviceName }: { deviceId?: string; deviceName: string }) {
  const [devices, setDevices] = useState<PortalDevice[]>()
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const read = () => {
      void loadDevices()
        .then(result => { if (!cancelled) setDevices(result.items) })
        .catch(failure => {
          if (cancelled) return
          const portalError = failure as PortalError
          // The list is informational; a signed-out tab still shows success.
          if (portalError.status !== 401) setError(portalError.message)
          setDevices([])
        })
    }
    read()
    // Presence moves while the page is open; keep the online column honest.
    const timer = window.setInterval(read, 15_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

  // The link carries the host *device* id; the portal lists *nodes*. Match on
  // the node's host or client device id so the newcomer is highlighted.
  const isNewcomer = (device: PortalDevice) =>
    deviceId !== undefined && (device.hostDeviceId === deviceId || device.clientDeviceId === deviceId)

  const sorted = [...(devices ?? [])].sort((left, right) => {
    if (isNewcomer(left)) return -1
    if (isNewcomer(right)) return 1
    if (left.online !== right.online) return left.online ? -1 : 1
    return (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0)
  })
  const onlineCount = sorted.filter(device => device.online).length

  return (
    <>
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

      {error && <div className="orb-notice is-error">{error}</div>}

      <div className="orb-card">
        <div className="orb-card-head">
          <h2>账号里的设备</h2>
          <span className="orb-count">
            {devices === undefined ? '正在加载…' : `${onlineCount}/${sorted.length} 在线`}
          </span>
        </div>
        {devices === undefined ? (
          <div className="orb-empty">
            <p className="orb-empty-sub"><span className="orb-spinner" style={{ display: 'inline-block', verticalAlign: 'middle' }} /> 正在加载设备…</p>
          </div>
        ) : sorted.length === 0 ? (
          <div className="orb-empty">
            <p className="orb-empty-sub">这个账号下暂时只有刚刚授权的这台设备。</p>
          </div>
        ) : (
          <div className="orb-list">
            {sorted.map(device => {
              const isNew = isNewcomer(device)
              return (
                <div className="orb-row" key={device.nodeId}>
                  <div className="orb-row-main">
                    <div className="orb-row-name">
                      <span>{device.name}</span>
                      {isNew && <span className="orb-pill is-pending">刚授权</span>}
                      <span className={`orb-pill ${device.online ? 'is-online' : ''}`}>
                        {device.online ? '在线' : '离线'}
                      </span>
                    </div>
                    <div className="orb-row-meta">
                      {platformLabel(device.platform)}
                      {' · '}
                      {device.online ? '已连接' : relativeTime(device.lastSeenAt)}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <p className="orb-hint">
        同一账号的设备互相可见、可以互相派任务。服务器只转发加密流量，看不到会话内容。
      </p>

      {/* The hand-off ends here, but the account does not: this is where the
          user is heading anyway, so give them the door instead of making them
          retype the site address. */}
      <div className="orb-link-actions">
        <a className="orb-button is-primary" href="/app/devices">进入网站主页</a>
      </div>
      <p className="orb-hint" style={{ textAlign: 'center' }}>
        在主页可以查看账号信息、管理已授权的设备，以及生成新的配对串。
      </p>
    </>
  )
}
