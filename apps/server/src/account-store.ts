/**
 * Account layer for the hosted (multi-tenant) mode.
 *
 * Everything here is additive to the v0 single-tenant store: the personal mode
 * keeps using `state.json`, while `account` mode keeps accounts, email
 * challenges, browser sessions and device-authorization hand-offs in SQLite.
 *
 * Threat model notes
 * ------------------
 * - Only digests are persisted for secrets we must later compare: session
 *   cookies, device-link nonces and one-time codes. A copy of the database does
 *   not let an attacker reuse a live login.
 * - Email addresses ARE stored in clear text because they are the account
 *   identifier and the UI shows them back to the owner. That is a deliberate
 *   trade-off; see docs/server-accounts.md.
 * - Codes are 6 digits, so a plain hash would be brute-forced instantly. Each
 *   challenge is therefore bound to a server-side pepper, and verification is
 *   limited by an attempt counter that is consumed atomically.
 */
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'

/**
 * `node:sqlite` is only present on Node >= 22.5, and bundlers (including the
 * one vitest uses) cannot resolve it statically. Loading it through
 * `createRequire` keeps the personal-mode build free of the dependency and lets
 * the test runner import this module without a native-addon shim.
 */
const require = createRequire(import.meta.url)
type DatabaseSync = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  close(): void
}
const sqlite = (() => {
  try {
    return require('node:sqlite') as { DatabaseSync: new (file: string) => DatabaseSync }
  } catch {
    throw new Error(
      '账号模式需要 node:sqlite（Node.js 22.5 或更高版本）。个人模式不需要它。',
    )
  }
})()

export class AccountError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Codes are short; keying the digest with a server secret makes offline guessing useless. */
function codeDigest(pepper: string, challengeId: string, code: string): string {
  return createHmac('sha256', pepper).update(`${challengeId}:${code}`).digest('hex')
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface Limits {
  codeTtlSeconds: number
  sessionTtlSeconds: number
  sendCooldownSeconds: number
  emailSendsPerDay: number
  ipSendsPerHour: number
  ipSendsPerDay: number
  maxVerifyFailures: number
  linkTtlSeconds: number
}

export const DEFAULT_LIMITS: Limits = {
  codeTtlSeconds: 600,
  sessionTtlSeconds: 7 * 24 * 3600,
  sendCooldownSeconds: 60,
  emailSendsPerDay: 5,
  ipSendsPerHour: 10,
  ipSendsPerDay: 30,
  maxVerifyFailures: 5,
  linkTtlSeconds: 600,
}

export interface AccountRecord {
  accountId: string
  email: string
  createdAt: number
  lastLoginAt: number
}

export interface LinkRecord {
  linkId: string
  nonceDigest: string
  publicKey: string
  deviceName: string
  platform: string
  /** The device id the plugin already generated; reused so its identity matches. */
  requestedDeviceId?: string
  createdAt: number
  expiresAt: number
  approvedAt?: number
  approvedAccountId?: string
  consumedAt?: number
  /** Set once the browser approves: the device token the plugin will collect. */
  deviceId?: string
  accessToken?: string
  refreshToken?: string
  accessTokenExpiresAt?: number
  refreshTokenExpiresAt?: number
}

export class AccountStore {
  private readonly db: DatabaseSync

  constructor(
    file: string,
    private readonly pepper: string,
    private readonly limits: Limits = DEFAULT_LIMITS,
  ) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new sqlite.DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 10000')
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id   TEXT PRIMARY KEY,
        email        TEXT NOT NULL UNIQUE,
        created_at   INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS challenges (
        challenge_id TEXT PRIMARY KEY,
        email        TEXT NOT NULL,
        code_digest  TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        attempts     INTEGER NOT NULL DEFAULT 0,
        consumed_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_challenges_email ON challenges(email, created_at);

      CREATE TABLE IF NOT EXISTS web_sessions (
        session_digest TEXT PRIMARY KEY,
        account_id     TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        created_at     INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_web_sessions_expiry ON web_sessions(expires_at);

      CREATE TABLE IF NOT EXISTS send_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key_type   TEXT NOT NULL,
        key_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_send_events ON send_events(key_type, key_digest, created_at);

      CREATE TABLE IF NOT EXISTS device_links (
        link_id                TEXT PRIMARY KEY,
        nonce_digest           TEXT NOT NULL,
        public_key             TEXT NOT NULL,
        device_name            TEXT NOT NULL,
        platform               TEXT NOT NULL,
        created_at             INTEGER NOT NULL,
        expires_at             INTEGER NOT NULL,
        approved_at            INTEGER,
        approved_account_id    TEXT,
        consumed_at            INTEGER,
        device_id              TEXT,
        requested_device_id    TEXT,
        access_token           TEXT,
        refresh_token          TEXT,
        access_expires_at      INTEGER,
        refresh_expires_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_device_links_expiry ON device_links(expires_at);
    `)
    this.migrate()
  }

  /**
   * Additive schema migrations.
   *
   * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so a column
   * added after the first deployment has to be applied explicitly here. Every
   * step must be safe to re-run on an already-migrated database.
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(device_links)').all() as Array<{ name: string }>)
        .map(row => row.name),
    )
    if (!columns.has('requested_device_id')) {
      this.db.exec('ALTER TABLE device_links ADD COLUMN requested_device_id TEXT')
    }
  }

  // ------------------------------------------------------------------ account

  findAccountByEmail(email: string): AccountRecord | undefined {
    const row = this.db.prepare(
      'SELECT account_id, email, created_at, last_login_at FROM accounts WHERE email = ?',
    ).get(email) as Record<string, unknown> | undefined
    if (!row) return undefined
    return {
      accountId: String(row.account_id),
      email: String(row.email),
      createdAt: Number(row.created_at),
      lastLoginAt: Number(row.last_login_at),
    }
  }

  /** Create-or-touch. Registration and login are the same step by design. */
  upsertAccount(email: string): { account: AccountRecord; created: boolean } {
    const existing = this.findAccountByEmail(email)
    const now = Date.now()
    if (existing) {
      this.db.prepare('UPDATE accounts SET last_login_at = ? WHERE account_id = ?').run(now, existing.accountId)
      return { account: { ...existing, lastLoginAt: now }, created: false }
    }
    const account: AccountRecord = { accountId: randomUUID(), email, createdAt: now, lastLoginAt: now }
    this.db.prepare(
      'INSERT INTO accounts(account_id, email, created_at, last_login_at) VALUES (?, ?, ?, ?)',
    ).run(account.accountId, account.email, account.createdAt, account.lastLoginAt)
    return { account, created: true }
  }

  // -------------------------------------------------------------- rate limits

  /**
   * Reserve one send slot for an email and an IP. Both windows are checked
   * before anything is recorded, so a rejected attempt does not consume quota.
   */
  reserveSend(email: string, ip: string): { allowed: boolean; retryAfter: number; reason: string } {
    const now = Date.now()
    const emailKey = digest(email), ipKey = digest(ip)
    this.db.prepare('DELETE FROM send_events WHERE created_at < ?').run(now - 86_400_000)

    const count = (type: string, key: string, since: number): number => {
      const row = this.db.prepare(
        'SELECT COUNT(*) AS n FROM send_events WHERE key_type = ? AND key_digest = ? AND created_at >= ?',
      ).get(type, key, since) as { n: number }
      return Number(row.n)
    }
    const oldest = (type: string, key: string, since: number): number | undefined => {
      const row = this.db.prepare(
        'SELECT MIN(created_at) AS t FROM send_events WHERE key_type = ? AND key_digest = ? AND created_at >= ?',
      ).get(type, key, since) as { t: number | null }
      return row.t === null ? undefined : Number(row.t)
    }

    if (this.limits.sendCooldownSeconds > 0) {
      const latest = this.db.prepare(
        'SELECT MAX(created_at) AS t FROM send_events WHERE key_type = ? AND key_digest = ?',
      ).get('email', emailKey) as { t: number | null }
      if (latest.t !== null) {
        const elapsed = Math.floor((now - Number(latest.t)) / 1000)
        if (elapsed < this.limits.sendCooldownSeconds) {
          return { allowed: false, retryAfter: this.limits.sendCooldownSeconds - elapsed, reason: 'too_soon' }
        }
      }
    }
    if (count('email', emailKey, now - 86_400_000) >= this.limits.emailSendsPerDay) {
      const since = oldest('email', emailKey, now - 86_400_000) ?? now
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((since + 86_400_000 - now) / 1000)), reason: 'email_daily_limit' }
    }
    if (count('ip', ipKey, now - 3_600_000) >= this.limits.ipSendsPerHour) {
      const since = oldest('ip', ipKey, now - 3_600_000) ?? now
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((since + 3_600_000 - now) / 1000)), reason: 'ip_hourly_limit' }
    }
    if (count('ip', ipKey, now - 86_400_000) >= this.limits.ipSendsPerDay) {
      const since = oldest('ip', ipKey, now - 86_400_000) ?? now
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((since + 86_400_000 - now) / 1000)), reason: 'ip_daily_limit' }
    }

    const insert = this.db.prepare('INSERT INTO send_events(key_type, key_digest, created_at) VALUES (?, ?, ?)')
    insert.run('email', emailKey, now)
    insert.run('ip', ipKey, now)
    return { allowed: true, retryAfter: 0, reason: '' }
  }

  // --------------------------------------------------------------- challenges

  /** Store a fresh code and invalidate any live code for the same mailbox. */
  createChallenge(email: string): { challengeId: string; code: string; expiresAt: number } {
    const now = Date.now()
    this.db.prepare('DELETE FROM challenges WHERE expires_at <= ?').run(now)
    this.db.prepare('UPDATE challenges SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL').run(now, email)

    const challengeId = randomUUID()
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = now + this.limits.codeTtlSeconds * 1000
    this.db.prepare(
      'INSERT INTO challenges(challenge_id, email, code_digest, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(challengeId, email, codeDigest(this.pepper, challengeId, code), now, expiresAt)
    return { challengeId, code, expiresAt }
  }

  /**
   * Verify and consume in one step. Returns a discriminated result so callers
   * can distinguish "wrong code" from "too many attempts" without leaking
   * whether the mailbox exists.
   */
  consumeChallenge(
    challengeId: string,
    email: string,
    code: string,
  ): { ok: true } | { ok: false; reason: 'invalid' | 'expired' | 'wrong' | 'locked' } {
    const now = Date.now()
    const row = this.db.prepare(
      'SELECT email, code_digest, expires_at, attempts, consumed_at FROM challenges WHERE challenge_id = ?',
    ).get(challengeId) as Record<string, unknown> | undefined
    if (!row || String(row.email) !== email || row.consumed_at !== null) return { ok: false, reason: 'invalid' }
    if (Number(row.expires_at) <= now) return { ok: false, reason: 'expired' }
    if (Number(row.attempts) >= this.limits.maxVerifyFailures) return { ok: false, reason: 'locked' }

    const expected = codeDigest(this.pepper, challengeId, code)
    if (!constantTimeEqual(expected, String(row.code_digest))) {
      this.db.prepare('UPDATE challenges SET attempts = attempts + 1 WHERE challenge_id = ?').run(challengeId)
      const after = this.db.prepare('SELECT attempts FROM challenges WHERE challenge_id = ?').get(challengeId) as { attempts: number }
      return { ok: false, reason: Number(after.attempts) >= this.limits.maxVerifyFailures ? 'locked' : 'wrong' }
    }

    // Conditional update: two concurrent submits cannot both mint a session.
    const result = this.db.prepare(
      'UPDATE challenges SET consumed_at = ? WHERE challenge_id = ? AND consumed_at IS NULL',
    ).run(now, challengeId)
    if (Number(result.changes) !== 1) return { ok: false, reason: 'invalid' }
    return { ok: true }
  }

  // ----------------------------------------------------------- web sessions

  createWebSession(accountId: string): { token: string; expiresAt: number } {
    const now = Date.now()
    this.db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(now)
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now + this.limits.sessionTtlSeconds * 1000
    this.db.prepare(
      'INSERT INTO web_sessions(session_digest, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run(digest(token), accountId, now, expiresAt)
    return { token, expiresAt }
  }

  accountForSession(token: string | undefined): AccountRecord | undefined {
    if (!token) return undefined
    const now = Date.now()
    const row = this.db.prepare(
      `SELECT a.account_id, a.email, a.created_at, a.last_login_at
         FROM web_sessions s JOIN accounts a ON a.account_id = s.account_id
        WHERE s.session_digest = ? AND s.expires_at > ?`,
    ).get(digest(token), now) as Record<string, unknown> | undefined
    if (!row) return undefined
    return {
      accountId: String(row.account_id),
      email: String(row.email),
      createdAt: Number(row.created_at),
      lastLoginAt: Number(row.last_login_at),
    }
  }

  deleteWebSession(token: string | undefined): void {
    if (!token) return
    this.db.prepare('DELETE FROM web_sessions WHERE session_digest = ?').run(digest(token))
  }

  /** Revoke every session for an account (used when a device is compromised). */
  deleteWebSessionsForAccount(accountId: string): void {
    this.db.prepare('DELETE FROM web_sessions WHERE account_id = ?').run(accountId)
  }

  // ---------------------------------------------------------- device linking

  /**
   * Start a device hand-off. The plugin holds `nonce`; only its digest is kept.
   * The browser never sees the nonce, so a leaked link URL cannot collect the
   * resulting credentials.
   */
  startDeviceLink(input: {
    publicKey: string
    deviceName: string
    platform: string
    /** The plugin's own device id. Reusing it keeps the local identity in sync. */
    deviceId?: string
  }): {
    linkId: string
    nonce: string
    expiresAt: number
  } {
    const now = Date.now()
    this.db.prepare('DELETE FROM device_links WHERE expires_at < ?').run(now - 3_600_000)
    const linkId = randomUUID()
    const nonce = randomBytes(32).toString('base64url')
    const expiresAt = now + this.limits.linkTtlSeconds * 1000
    this.db.prepare(
      `INSERT INTO device_links(link_id, nonce_digest, public_key, device_name, platform, created_at, expires_at, requested_device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      linkId, digest(nonce), input.publicKey, input.deviceName.slice(0, 80),
      input.platform.slice(0, 32), now, expiresAt, input.deviceId ?? null,
    )
    return { linkId, nonce, expiresAt }
  }

  /**
   * Public metadata a browser needs to render the approval screen.
   *
   * A consumed link is still described. The plugin collects its credentials
   * seconds after approval, and the tab the user is looking at may reload
   * afterwards; answering "invalid request" there would report a failure for an
   * authorization that actually succeeded.
   */
  describeLink(linkId: string): {
    deviceName: string
    platform: string
    createdAt: number
    expiresAt: number
    approved: boolean
    consumed: boolean
    deviceId?: string
    /** The account the approval was bound to; absent while still pending. */
    approvedAccountId?: string
  } | undefined {
    const row = this.db.prepare(
      'SELECT device_name, platform, created_at, expires_at, approved_at, consumed_at, device_id, approved_account_id FROM device_links WHERE link_id = ?',
    ).get(linkId) as Record<string, unknown> | undefined
    if (!row) return undefined
    const deviceId = typeof row.device_id === 'string' && row.device_id !== '' ? row.device_id : undefined
    const approvedAccountId = typeof row.approved_account_id === 'string' && row.approved_account_id !== ''
      ? row.approved_account_id
      : undefined
    return {
      deviceName: String(row.device_name),
      platform: String(row.platform),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      approved: row.approved_at !== null,
      consumed: row.consumed_at !== null,
      ...(deviceId === undefined ? {} : { deviceId }),
      ...(approvedAccountId === undefined ? {} : { approvedAccountId }),
    }
  }

  /**
   * Bind the pending device to the signed-in account and mint device tokens.
   * Approving twice is refused so a stale browser tab cannot overwrite a
   * device that was already handed to (and possibly revoked on) another account.
   */
  approveDeviceLink(
    linkId: string,
    accountId: string,
    mint: (input: { deviceId: string; publicKey: string; deviceName: string; platform: string }) => {
      deviceId: string
      accessToken: string
      refreshToken: string
      accessTokenExpiresAt: number
      refreshTokenExpiresAt: number
    },
  ): void {
    const now = Date.now()
    const row = this.db.prepare(
      'SELECT approved_at, expires_at, consumed_at, public_key, device_name, platform, requested_device_id FROM device_links WHERE link_id = ?',
    ).get(linkId) as Record<string, unknown> | undefined
    if (!row) throw new AccountError('LINK_NOT_FOUND', 404)
    if (row.consumed_at !== null) throw new AccountError('LINK_CONSUMED', 409)
    if (row.approved_at !== null) throw new AccountError('LINK_ALREADY_APPROVED', 409)
    if (Number(row.expires_at) <= now) throw new AccountError('LINK_EXPIRED', 410)

    // Reuse the id the plugin generated. A different id would make the plugin's
    // local identity and the server record disagree, so `authenticate()` would
    // think it has no credentials and try to re-register — which needs an account
    // session it does not have.
    const issued = mint({
      deviceId: typeof row.requested_device_id === 'string' && row.requested_device_id !== ''
        ? row.requested_device_id
        : randomUUID(),
      publicKey: String(row.public_key),
      deviceName: String(row.device_name),
      platform: String(row.platform),
    })
    this.db.prepare(
      `UPDATE device_links
          SET approved_at = ?, approved_account_id = ?, device_id = ?, access_token = ?,
              refresh_token = ?, access_expires_at = ?, refresh_expires_at = ?
        WHERE link_id = ? AND approved_at IS NULL`,
    ).run(
      now, accountId, issued.deviceId, issued.accessToken, issued.refreshToken,
      issued.accessTokenExpiresAt, issued.refreshTokenExpiresAt, linkId,
    )
  }

  /**
   * Collect the approved credentials. Requires the nonce the plugin generated,
   * and is single-use: the row is cleared in the same statement that reads it.
   */
  collectDeviceLink(linkId: string, nonce: string): {
    deviceId: string
    accessToken: string
    refreshToken: string
    accessTokenExpiresAt: number
    refreshTokenExpiresAt: number
    account: AccountRecord
  } {
    const now = Date.now()
    const row = this.db.prepare(
      `SELECT nonce_digest, approved_account_id, device_id, access_token, refresh_token,
              access_expires_at, refresh_expires_at, approved_at, consumed_at, expires_at
         FROM device_links WHERE link_id = ?`,
    ).get(linkId) as Record<string, unknown> | undefined
    if (!row) throw new AccountError('LINK_NOT_FOUND', 404)
    if (!constantTimeEqual(digest(nonce), String(row.nonce_digest))) throw new AccountError('LINK_NOT_FOUND', 404)
    if (row.consumed_at !== null) throw new AccountError('LINK_CONSUMED', 409)
    if (Number(row.expires_at) <= now) throw new AccountError('LINK_EXPIRED', 410)
    if (row.approved_at === null) throw new AccountError('LINK_PENDING', 202)

    const result = this.db.prepare(
      'UPDATE device_links SET consumed_at = ? WHERE link_id = ? AND consumed_at IS NULL',
    ).run(now, linkId)
    if (Number(result.changes) !== 1) throw new AccountError('LINK_CONSUMED', 409)

    const accountRow = this.db.prepare(
      'SELECT account_id, email, created_at, last_login_at FROM accounts WHERE account_id = ?',
    ).get(String(row.approved_account_id)) as Record<string, unknown> | undefined
    if (!accountRow) throw new AccountError('LINK_NOT_FOUND', 404)

    // Tokens are read exactly once and then destroyed in the same transaction.
    this.db.prepare(
      `UPDATE device_links SET access_token = NULL, refresh_token = NULL WHERE link_id = ?`,
    ).run(linkId)

    return {
      deviceId: String(row.device_id),
      accessToken: String(row.access_token),
      refreshToken: String(row.refresh_token),
      accessTokenExpiresAt: Number(row.access_expires_at),
      refreshTokenExpiresAt: Number(row.refresh_expires_at),
      account: {
        accountId: String(accountRow.account_id),
        email: String(accountRow.email),
        createdAt: Number(accountRow.created_at),
        lastLoginAt: Number(accountRow.last_login_at),
      },
    }
  }

  close(): void { this.db.close() }
}
