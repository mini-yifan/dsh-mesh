/**
 * The signed-in portal: own devices plus pairing codes for adding new ones.
 *
 * Read-only on device names, matching the v0 decision (only the device itself
 * may rename). Revocation is allowed because losing a phone must be actionable
 * from the web.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  PortalError,
  createPairingCode,
  loadDevices,
  loadMe,
  platformLabel,
  relativeTime,
  revokeDevice,
  revokePairingCode,
  listPairingCodes,
  signOut,
  type PairingCode,
  type PortalDevice,
  type PortalMe,
} from './portal-api'

interface Props {
  onSignedOut(): void
}

export function PortalDevices({ onSignedOut }: Props) {
  const [me, setMe] = useState<PortalMe>()
  const [devices, setDevices] = useState<PortalDevice[]>([])
  const [codes, setCodes] = useState<PairingCode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [created, setCreated] = useState<PairingCode>()
  const [copied, setCopied] = useState(false)

  const handleFailure = useCallback((failure: unknown, fallback: string) => {
    const portalError = failure as PortalError
    if (portalError.status === 401) { onSignedOut(); return }
    setError(portalError.message || fallback)
  }, [onSignedOut])

  const refresh = useCallback(async () => {
    setError('')
    try {
      const [profile, deviceList, codeList] = await Promise.all([loadMe(), loadDevices(), listPairingCodes()])
      setMe(profile)
      setDevices(deviceList.items)
      setCodes(codeList.items)
    } catch (failure) {
      handleFailure(failure, '加载失败，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }, [handleFailure])

  useEffect(() => { void refresh() }, [refresh])

  // Keep the online column roughly live without hammering the API.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadDevices().then(result => setDevices(result.items)).catch(() => undefined)
    }, 20_000)
    return () => window.clearInterval(timer)
  }, [])

  async function addDevice() {
    const name = label.trim()
    if (!name) { setError('给这台设备起个名字，之后在互联窗口里更容易认出来。'); return }
    setBusy(true); setError('')
    try {
      const code = await createPairingCode(name)
      setCreated(code)
      setLabel('')
      setAdding(false)
      setCodes(previous => [code, ...previous])
    } catch (failure) {
      handleFailure(failure, '生成配对串失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  async function copyPairing() {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.pairing)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('复制失败，请手动选中下面的配对串。')
    }
  }

  async function removeDevice(device: PortalDevice) {
    if (!window.confirm(`撤销「${device.name}」？这台设备需要重新配对才能再次互联。`)) return
    setBusy(true)
    try {
      await revokeDevice(device.nodeId)
      setDevices(previous => previous.filter(item => item.nodeId !== device.nodeId))
    } catch (failure) {
      handleFailure(failure, '撤销失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  async function dropCode(code: PairingCode) {
    setBusy(true)
    try {
      await revokePairingCode(code.id)
      setCodes(previous => previous.filter(item => item.id !== code.id))
    } catch (failure) {
      handleFailure(failure, '作废失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  async function logout() {
    try { await signOut() } catch { /* sign out locally regardless */ }
    onSignedOut()
  }

  const onlineCount = devices.filter(device => device.online).length
  const activeCodes = codes.filter(code => !code.usedAt && !code.revokedAt && code.expiresAt > Date.now())

  return (
    <div className="orb-shell">
      <header className="orb-topbar">
        <span className="orb-brand"><span className="orb-ball" data-state={onlineCount > 0 ? 'online' : 'idle'} />DSH Orb·互联</span>
        <span className="orb-topbar-spacer" />
        {me && <span style={{ color: 'var(--orb-muted)', fontSize: 13 }}>{me.account.emailMasked}</span>}
        <button className="orb-button is-ghost is-small" type="button" onClick={() => void logout()}>退出登录</button>
      </header>

      <main className="orb-main is-wide">
        <h1 className="orb-page-title">我的设备</h1>
        <p className="orb-page-sub">
          {loading ? '正在加载…' : `${devices.length} 台设备，${onlineCount} 台在线`}
        </p>

        {error && <div className="orb-notice is-error">{error}</div>}

        <div className="orb-card">
          <div className="orb-card-head">
            <h2>设备</h2>
            <span className="orb-count">{onlineCount}/{devices.length} 在线</span>
            <button className="orb-button is-primary is-small" type="button" disabled={busy} onClick={() => { setAdding(true); setCreated(undefined) }}>
              添加设备
            </button>
          </div>

          {adding && (
            <div className="orb-card-body" style={{ borderBottom: '1px solid var(--orb-separator)' }}>
              <div className="orb-field">
                <label className="orb-label" htmlFor="device-label">设备名称</label>
                <input
                  id="device-label"
                  className="orb-input"
                  maxLength={80}
                  placeholder="例如：书房的 Mac"
                  value={label}
                  autoFocus
                  disabled={busy}
                  onChange={event => setLabel(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') void addDevice() }}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="orb-button is-primary" type="button" disabled={busy} onClick={() => void addDevice()}>
                  {busy ? <><span className="orb-spinner" />生成中…</> : '生成配对串'}
                </button>
                <button className="orb-button is-ghost" type="button" disabled={busy} onClick={() => { setAdding(false); setError('') }}>取消</button>
              </div>
            </div>
          )}

          {created && (
            <div className="orb-card-body" style={{ borderBottom: '1px solid var(--orb-separator)' }}>
              <div className="orb-notice is-ok" style={{ marginBottom: 12 }}>
                配对串已生成，30 分钟内有效，只能使用一次。
              </div>
              <code className="orb-code">{created.pairing}</code>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="orb-button is-primary is-small" type="button" onClick={() => void copyPairing()}>
                  {copied ? '已复制' : '复制配对串'}
                </button>
                <button className="orb-button is-ghost is-small" type="button" onClick={() => setCreated(undefined)}>完成</button>
              </div>
              <p className="orb-hint">
                在另一台设备的「互联」设置里粘贴这条串，点连接即可。设备上线后会出现在下面的列表里。
              </p>
            </div>
          )}

          {loading ? (
            <div className="orb-empty"><p className="orb-empty-sub"><span className="orb-spinner" style={{ display: 'inline-block', verticalAlign: 'middle' }} /> 正在加载设备…</p></div>
          ) : devices.length === 0 ? (
            <div className="orb-empty">
              <p className="orb-empty-title">还没有设备</p>
              <p className="orb-empty-sub">
                点上面的「添加设备」生成配对串，然后在电脑或手机的「互联」设置里粘贴它。
              </p>
            </div>
          ) : (
            <div className="orb-list">
              {devices.map(device => (
                <div className="orb-row" key={device.nodeId}>
                  <div className="orb-row-main">
                    <div className="orb-row-name">
                      <span>{device.name}</span>
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
                  <button
                    className="orb-button is-danger is-small"
                    type="button"
                    disabled={busy}
                    onClick={() => void removeDevice(device)}
                  >
                    撤销
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {activeCodes.length > 0 && (
          <>
            <p className="orb-section-label" style={{ marginTop: 28 }}>未使用的配对串</p>
            <div className="orb-group">
              {activeCodes.map(code => (
                <div className="orb-group-row" key={code.id}>
                  <span className="orb-group-label">{code.label}</span>
                  <span className="orb-group-value" style={{ color: 'var(--orb-muted)', fontVariantNumeric: 'tabular-nums' }}>
                    {Math.max(0, Math.round((code.expiresAt - Date.now()) / 60000))} 分钟后过期
                  </span>
                  <button className="orb-button is-ghost is-small" type="button" disabled={busy} onClick={() => void dropCode(code)}>作废</button>
                </div>
              ))}
            </div>
          </>
        )}

        {me && (
          <>
            <p className="orb-section-label" style={{ marginTop: 28 }}>服务器</p>
            <div className="orb-group">
              <div className="orb-group-row">
                <span className="orb-group-label">地址</span>
                <span className="orb-group-value orb-code" style={{ padding: 0, background: 'none' }}>{me.serverUrl}</span>
              </div>
              <div className="orb-group-row">
                <span className="orb-group-label">账号</span>
                <span className="orb-group-value">{me.account.emailMasked}</span>
              </div>
            </div>
            <p className="orb-hint">
              在这台服务器上，同一账号的设备互相可见、可以互相派任务。服务器只转发加密流量，看不到会话内容。
            </p>
          </>
        )}
      </main>
    </div>
  )
}
