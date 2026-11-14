/**
 * Email-code sign-in.
 *
 * One field and one button: a first-time mailbox is registered and an existing
 * one is signed in by the same flow, so the UI never reveals whether an address
 * has an account.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { PortalError, loadConfig, sendCode, verifyCode, type PortalAccount, type PortalConfig } from './portal-api'

interface Props {
  onSignedIn(account: PortalAccount): void
  initialNotice?: string
}

export function PortalLogin({ onSignedIn, initialNotice }: Props) {
  const [config, setConfig] = useState<PortalConfig>()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [challengeId, setChallengeId] = useState<string>()
  const [masked, setMasked] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'error' | 'ok'; text: string } | undefined>(
    initialNotice ? { kind: 'error', text: initialNotice } : undefined,
  )
  const [cooldown, setCooldown] = useState(0)
  const [expiresIn, setExpiresIn] = useState(0)
  const codeInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void loadConfig().then(setConfig).catch(() => undefined)
  }, [])

  // Resend cooldown.
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setTimeout(() => setCooldown(value => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  // Code lifetime, so the user knows when to ask for a new one.
  useEffect(() => {
    if (expiresIn <= 0) return
    const timer = window.setTimeout(() => setExpiresIn(value => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [expiresIn])

  const request = useCallback(async () => {
    const address = email.trim()
    if (!address) { setNotice({ kind: 'error', text: '请输入邮箱地址。' }); return }
    setBusy(true); setNotice(undefined)
    try {
      const sent = await sendCode(address)
      setChallengeId(sent.challengeId)
      setMasked(sent.emailMasked)
      setCooldown(sent.resendAfter)
      setExpiresIn(sent.expiresIn)
      setCode('')
      setNotice({ kind: 'ok', text: `验证码已发送到 ${sent.emailMasked}` })
      window.setTimeout(() => codeInput.current?.focus(), 40)
    } catch (error) {
      const portalError = error as PortalError
      setNotice({ kind: 'error', text: portalError.message })
      if (portalError.code.startsWith('RATE_LIMITED')) setCooldown(30)
    } finally {
      setBusy(false)
    }
  }, [email])

  const submit = useCallback(async () => {
    if (!challengeId) return
    if (!/^\d{6}$/.test(code)) { setNotice({ kind: 'error', text: '请输入 6 位数字验证码。' }); return }
    setBusy(true); setNotice(undefined)
    try {
      const result = await verifyCode(email.trim(), challengeId, code)
      onSignedIn(result.account)
    } catch (error) {
      setNotice({ kind: 'error', text: (error as PortalError).message })
      setCode('')
      codeInput.current?.select()
    } finally {
      setBusy(false)
    }
  }, [challengeId, code, email, onSignedIn])

  const mailHint = config?.mail.transport === 'console'
    ? '这台服务器没有配置邮件服务，验证码会打印在服务器终端里。'
    : undefined

  return (
    <div className="orb-shell">
      <header className="orb-topbar">
        <span className="orb-brand"><span className="orb-ball" data-state="online" />DSH Orb·互联</span>
        <span className="orb-topbar-spacer" />
      </header>

      <main className="orb-main">
        <h1 className="orb-page-title">{challengeId ? '输入验证码' : '登录'}</h1>
        <p className="orb-page-sub">
          {challengeId
            ? `验证码已发送到 ${masked}，10 分钟内有效。`
            : '输入邮箱，我们会发一个 6 位验证码。第一次验证会自动创建账号，不需要密码。'}
        </p>

        {notice && <div className={`orb-notice is-${notice.kind}`}>{notice.text}</div>}

        {!challengeId ? (
          <div className="orb-card">
            <div className="orb-card-body">
              <div className="orb-field">
                <label className="orb-label" htmlFor="portal-email">邮箱地址</label>
                <input
                  id="portal-email"
                  className="orb-input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength={320}
                  placeholder="you@example.com"
                  value={email}
                  disabled={busy}
                  onChange={event => setEmail(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') void request() }}
                />
              </div>
              <button className="orb-button is-primary is-block" type="button" disabled={busy} onClick={() => void request()}>
                {busy ? <><span className="orb-spinner" />发送中…</> : '获取验证码'}
              </button>
              {mailHint && <p className="orb-hint">{mailHint}</p>}
            </div>
          </div>
        ) : (
          <div className="orb-card">
            <div className="orb-card-body">
              <div className="orb-field">
                <label className="orb-label" htmlFor="portal-code">验证码</label>
                <input
                  id="portal-code"
                  ref={codeInput}
                  className="orb-input is-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="000000"
                  value={code}
                  autoFocus
                  disabled={busy}
                  onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={event => { if (event.key === 'Enter') void submit() }}
                />
              </div>
              <button className="orb-button is-primary is-block" type="button" disabled={busy || code.length !== 6} onClick={() => void submit()}>
                {busy ? <><span className="orb-spinner" />验证中…</> : '验证并登录'}
              </button>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
                <span className="orb-hint" style={{ margin: 0 }}>
                  {expiresIn > 0 ? `${Math.ceil(expiresIn / 60)} 分钟内有效` : '验证码已过期'}
                </span>
                <button
                  className="orb-button is-ghost is-small"
                  type="button"
                  disabled={busy || cooldown > 0}
                  onClick={() => void request()}
                >
                  {cooldown > 0 ? `${cooldown}s 后可重新获取` : '重新获取'}
                </button>
              </div>
            </div>
          </div>
        )}

        <p className="orb-hint" style={{ textAlign: 'center', marginTop: 22 }}>
          账号只属于你一个人。服务器不保存会话内容和文件。
        </p>
      </main>
    </div>
  )
}
