/**
 * Pluggable mail delivery.
 *
 * Two transports, both dependency-free so the published source tree installs
 * and runs without any vendor SDK:
 *
 * - `smtp`   talks to any SMTP server over implicit TLS (465) or STARTTLS.
 * - `console` prints the code to the server log (development / self-hosting
 *            by someone who has no mail account yet).
 *
 * Nothing here knows about Alibaba Cloud, a domain, or an access key: every
 * value comes from the operator's environment. See `.env.example`.
 */
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { connect as netConnect, type Socket } from 'node:net'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'

export class MailError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export type MailTransport = 'console' | 'smtp'

export interface MailSettings {
  transport: MailTransport
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

export interface Mailer {
  sendCode(input: { recipient: string; code: string; ttlSeconds: number }): Promise<void>
}

/** Minimal SMTP client: EHLO, AUTH LOGIN, MAIL/RCPT/DATA, QUIT. */
class SmtpSession {
  private buffer = ''
  private chunks: string[] = []
  private socket!: TLSSocket | Socket
  private waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = []
  private failure: Error | undefined

  private constructor(private readonly settings: NonNullable<MailSettings['smtp']>) {}

  static async open(settings: NonNullable<MailSettings['smtp']>): Promise<SmtpSession> {
    const session = new SmtpSession(settings)
    await session.connect()
    return session
  }

  private connect(): Promise<void> {
    const { host, port, security, timeoutMs } = this.settings
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket?.destroy()
        reject(new MailError('SMTP_TIMEOUT', `SMTP 连接超时（${host}:${port}）`))
      }, timeoutMs)

      const onError = (error: Error) => { clearTimeout(timer); reject(new MailError('SMTP_CONNECT', `无法连接 SMTP 服务器：${error.message}`)) }

      if (security === 'ssl') {
        this.socket = tlsConnect({ host, port, servername: host, rejectUnauthorized: true }, () => {
          clearTimeout(timer); resolve()
        })
      } else {
        this.socket = netConnect({ host, port }, () => {
          clearTimeout(timer); resolve()
        })
      }
      this.socket.setEncoding('utf8')
      this.socket.once('error', onError)
      this.socket.on('data', (chunk: string) => this.onData(chunk))
      this.socket.on('close', () => {
        const error = this.failure ?? new MailError('SMTP_CLOSED', 'SMTP 连接被服务器关闭')
        for (const waiter of this.waiters.splice(0)) waiter.reject(error)
      })
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 2)
      this.chunks.push(line)
      // A multi-line reply ends with "250 " (space), continuation uses "250-".
      if (line.length >= 4 && line[3] === '-') continue
      const reply = this.chunks.join('\n')
      this.chunks = []
      const waiter = this.waiters.shift()
      waiter?.resolve(reply)
    }
  }

  private read(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  private async command(line: string): Promise<{ code: number; text: string }> {
    this.socket.write(`${line}\r\n`)
    const reply = await this.read()
    const code = Number(reply.slice(0, 3))
    return { code, text: reply }
  }

  private expect(result: { code: number; text: string }, expected: readonly number[], stage: string): string {
    if (!expected.includes(result.code)) {
      throw new MailError('SMTP_REJECTED', `SMTP ${stage} 被拒绝（${result.code}）`)
    }
    return result.text
  }

  async ehlo(): Promise<string> {
    const banner = await this.read()
    this.expect({ code: Number(banner.slice(0, 3)), text: banner }, [220], '握手')
    const helo = await this.command(`EHLO ${hostname() || 'localhost'}`)
    return this.expect(helo, [250], 'EHLO')
  }

  async startTls(): Promise<void> {
    const capability = await this.ehlo()
    if (!/STARTTLS/i.test(capability)) throw new MailError('SMTP_NO_STARTTLS', '服务器不支持 STARTTLS')
    const result = await this.command('STARTTLS')
    this.expect(result, [220], 'STARTTLS')

    await new Promise<void>((resolve, reject) => {
      const plain = this.socket as Socket
      const secure = tlsConnect({ socket: plain, servername: this.settings.host, rejectUnauthorized: true }, () => {
        this.socket = secure
        this.socket.setEncoding('utf8')
        this.socket.on('data', (chunk: string) => this.onData(chunk))
        resolve()
      })
      secure.once('error', reject)
    })
    const again = await this.command(`EHLO ${hostname() || 'localhost'}`)
    this.expect(again, [250], 'EHLO (TLS)')
  }

  async authLogin(): Promise<void> {
    const { username, password } = this.settings
    const start = await this.command('AUTH LOGIN')
    if (start.code === 235) return
    this.expect(start, [334], 'AUTH LOGIN')
    const user = await this.command(Buffer.from(username, 'utf8').toString('base64'))
    this.expect(user, [334], 'AUTH USER')
    const pass = await this.command(Buffer.from(password, 'utf8').toString('base64'))
    this.expect(pass, [235], 'AUTH PASSWORD')
  }

  async sendMail(from: string, to: string, message: string): Promise<void> {
    this.expect(await this.command(`MAIL FROM:<${from}>`), [250], 'MAIL FROM')
    this.expect(await this.command(`RCPT TO:<${to}>`), [250, 251], 'RCPT TO')
    this.expect(await this.command('DATA'), [354], 'DATA')
    // Dot-stuffing: a line starting with "." must be doubled.
    const body = message.replace(/\r\n/g, '\n').split('\n').map(line => (line.startsWith('.') ? `.${line}` : line)).join('\r\n')
    this.socket.write(`${body}\r\n.\r\n`)
    this.expect(await this.read().then(reply => ({ code: Number(reply.slice(0, 3)), text: reply })), [250], '邮件投递')
  }

  close(): void {
    try { this.socket.write('QUIT\r\n') } catch { /* already gone */ }
    this.socket.end()
  }

  abort(error: Error): void {
    this.failure = error
    this.socket?.destroy()
  }
}

function encodeHeader(value: string): string {
  // RFC 2047 for non-ASCII subjects and display names.
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function buildMessage(input: {
  from: string
  fromAlias?: string
  to: string
  subject: string
  text: string
  html: string
}): string {
  const boundary = `dsh-${randomUUID()}`
  const alias = input.fromAlias ? `${encodeHeader(input.fromAlias)} ` : ''
  const domain = input.from.split('@')[1] ?? 'localhost'
  return [
    `From: ${alias}<${input.from}>`,
    `To: <${input.to}>`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(input.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(input.html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

export class ConsoleMailer implements Mailer {
  async sendCode(input: { recipient: string; code: string; ttlSeconds: number }): Promise<void> {
    const minutes = Math.max(1, Math.round(input.ttlSeconds / 60))
    console.info(
      '\n================ MAIL (console transport) ================\n' +
      `To:      ${input.recipient}\n` +
      'Subject: 登录验证码\n\n' +
      `    ${input.code}\n\n` +
      `有效 ${minutes} 分钟，只能使用一次。\n` +
      '==========================================================',
    )
  }
}

export class SmtpMailer implements Mailer {
  constructor(private readonly settings: MailSettings) {
    if (!settings.smtp) throw new MailError('SMTP_NOT_CONFIGURED', 'SMTP 未配置')
  }

  async sendCode(input: { recipient: string; code: string; ttlSeconds: number }): Promise<void> {
    const smtp = this.settings.smtp!
    const minutes = Math.max(1, Math.round(input.ttlSeconds / 60))
    const app = this.settings.appName
    const subject = `${app} 登录验证码`
    const text = `你好，\n\n你的 ${app} 登录验证码是：\n\n    ${input.code}\n\n验证码 ${minutes} 分钟内有效，且只能使用一次。\n如果这不是你本人的操作，请忽略这封邮件，也不要把它告诉任何人。\n`
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.7;color:#172033;max-width:480px">` +
      `<p>你好，</p><p>你的 ${app} 登录验证码是：</p>` +
      `<p style="margin:24px 0;font-size:32px;font-weight:700;letter-spacing:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${input.code}</p>` +
      `<p>验证码 ${minutes} 分钟内有效，且只能使用一次。</p>` +
      `<p style="color:#667085">如果这不是你本人的操作，请忽略这封邮件，也不要把它告诉任何人。</p></div>`

    const message = buildMessage({
      from: this.settings.from,
      fromAlias: this.settings.fromAlias,
      to: input.recipient,
      subject,
      text,
      html,
    })

    const session = await SmtpSession.open(smtp)
    try {
      if (smtp.security === 'starttls') await session.startTls()
      else await session.ehlo()
      await session.authLogin()
      await session.sendMail(this.settings.from, input.recipient, message)
    } catch (error) {
      session.abort(error instanceof Error ? error : new MailError('SMTP_FAILED', '发送失败'))
      throw error instanceof MailError ? error : new MailError('SMTP_FAILED', '邮件发送失败')
    } finally {
      session.close()
    }
  }
}

export function createMailer(settings: MailSettings): Mailer {
  return settings.transport === 'smtp' ? new SmtpMailer(settings) : new ConsoleMailer()
}
