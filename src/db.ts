/**
 * The Postgres store (self-hosted on the box, DATABASE_URL), through Bun's
 * built-in client. Migrations are idempotent CREATE ... IF NOT EXISTS and run
 * on boot, so two processes starting at once are fine.
 *
 * Secrets we hand out (session ids, sign-in links, API keys, release links)
 * are stored as SHA-256 hashes: a copy of the database opens nothing.
 *
 * Every state change the worker makes is a compare-and-set on the row
 * (`WHERE reminders_sent = $seen`), so a reminder or a release happens once
 * even if two workers race.
 */
import { createHash, randomBytes } from 'node:crypto'
import { SQL } from 'bun'
import type { Sealed } from './seal.js'

export const hash = (secret: string) => createHash('sha256').update(secret).digest('hex')
export const token = (prefix = '', bytes = 24) => `${prefix}${randomBytes(bytes).toString('base64url')}`
const id = () => randomBytes(9).toString('base64url')

export type Plan = 'free' | 'pro' | 'lifetime'
export type User = { id: string; email: string; name: string; plan: Plan; plan_until: Date | null; phone: string; created_at: Date }
export type SwitchState = 'armed' | 'paused' | 'fired'
export type Switch = {
  id: string
  user_id: string
  name: string
  interval_days: number
  grace_days: number
  state: SwitchState
  last_checkin_at: Date
  due_at: Date
  reminders_sent: number
  last_reminder_at: Date | null
  fired_at: Date | null
  hint: string
  bundle: Sealed | null
  bundle_bytes: number
  bundle_at: Date | null
  created_at: Date
}
export type Recipient = { id: string; switch_id: string; name: string; email: string; released_at: Date | null; opened_at: Date | null; created_at: Date }
export type Checkin = { at: Date; via: string }
export type PushSub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string }
export type Payment = { ref: string; user_id: string; product: string; amount_cents: number; chain: string; status: string; settled_at: Date | null; created_at: Date }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  plan text NOT NULL DEFAULT 'free',
  plan_until timestamptz,
  phone text NOT NULL DEFAULT '',
  api_key_hash text UNIQUE,
  renewal_warned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS login_links (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_links_email ON login_links(email, created_at);
CREATE TABLE IF NOT EXISTS switches (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  interval_days int NOT NULL,
  grace_days int NOT NULL,
  state text NOT NULL DEFAULT 'armed',
  last_checkin_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  reminders_sent int NOT NULL DEFAULT 0,
  last_reminder_at timestamptz,
  fired_at timestamptz,
  hint text NOT NULL DEFAULT '',
  bundle jsonb,
  bundle_bytes int NOT NULL DEFAULT 0,
  bundle_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS switches_user ON switches(user_id);
CREATE INDEX IF NOT EXISTS switches_due ON switches(due_at) WHERE state = 'armed';
CREATE TABLE IF NOT EXISTS recipients (
  id text PRIMARY KEY,
  switch_id text NOT NULL REFERENCES switches(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  email text NOT NULL,
  token_hash text UNIQUE,
  released_at timestamptz,
  opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recipients_switch ON recipients(switch_id);
CREATE TABLE IF NOT EXISTS checkins (
  id bigserial PRIMARY KEY,
  switch_id text NOT NULL REFERENCES switches(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  via text NOT NULL
);
CREATE INDEX IF NOT EXISTS checkins_switch ON checkins(switch_id, at DESC);
CREATE TABLE IF NOT EXISTS push_subs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id);
CREATE TABLE IF NOT EXISTS payments (
  ref text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product text NOT NULL,
  amount_cents int NOT NULL,
  chain text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  raw jsonb,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id);
CREATE TABLE IF NOT EXISTS calls (
  call_id text PRIMARY KEY,
  switch_id text NOT NULL REFERENCES switches(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
`

const USER_COLS = 'id, email, name, plan, plan_until, phone, created_at'
const SWITCH_COLS = 'id, user_id, name, interval_days, grace_days, state, last_checkin_at, due_at, reminders_sent, last_reminder_at, fired_at, hint, bundle, bundle_bytes, bundle_at, created_at'
const DAY = 86_400_000

export class Store {
  readonly sql: SQL
  constructor(url: string, readonly now: () => Date = () => new Date()) {
    this.sql = new SQL(url)
  }

  async migrate(): Promise<void> {
    await this.sql.unsafe(SCHEMA)
  }

  async close(): Promise<void> {
    await this.sql.close()
  }

  // ---- accounts --------------------------------------------------------------

  async userByEmail(email: string): Promise<User | null> {
    const [u] = await this.sql.unsafe(`SELECT ${USER_COLS} FROM users WHERE email = $1`, [email.toLowerCase()])
    return (u as User) ?? null
  }

  async user(userId: string): Promise<User | null> {
    const [u] = await this.sql.unsafe(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [userId])
    return (u as User) ?? null
  }

  async ensureUser(email: string): Promise<User> {
    const e = email.trim().toLowerCase()
    await this.sql`INSERT INTO users (id, email) VALUES (${id()}, ${e}) ON CONFLICT (email) DO NOTHING`
    return (await this.userByEmail(e))!
  }

  async updateUser(userId: string, fields: { name?: string; phone?: string }): Promise<void> {
    if (fields.name !== undefined) await this.sql`UPDATE users SET name = ${fields.name.slice(0, 80)} WHERE id = ${userId}`
    if (fields.phone !== undefined) await this.sql`UPDATE users SET phone = ${fields.phone} WHERE id = ${userId}`
  }

  async deleteUser(userId: string): Promise<void> {
    await this.sql`DELETE FROM users WHERE id = ${userId}`
  }

  async newLoginLink(email: string, ttlMs = 20 * 60_000): Promise<string> {
    const t = token('', 32)
    await this.sql`INSERT INTO login_links (token_hash, email, expires_at) VALUES (${hash(t)}, ${email.toLowerCase()}, ${new Date(this.now().getTime() + ttlMs)})`
    return t
  }

  async recentLoginLinks(email: string, sinceMs: number): Promise<number> {
    const [r] = await this.sql`SELECT count(*)::int AS n FROM login_links WHERE email = ${email.toLowerCase()} AND created_at > ${new Date(this.now().getTime() - sinceMs)}`
    return r.n
  }

  /** One use, unexpired: the email it was sent to, or null. */
  async takeLoginLink(t: string): Promise<string | null> {
    const [r] = await this.sql`DELETE FROM login_links WHERE token_hash = ${hash(t)} AND expires_at > ${this.now()} RETURNING email`
    return r?.email ?? null
  }

  async newSession(userId: string, ttlMs = 60 * DAY): Promise<string> {
    const sid = token('', 32)
    await this.sql`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (${hash(sid)}, ${userId}, ${new Date(this.now().getTime() + ttlMs)})`
    return sid
  }

  async session(sid: string | undefined): Promise<User | null> {
    if (!sid) return null
    const [u] = await this.sql.unsafe(
      `SELECT ${USER_COLS.split(', ').map((c) => `u.${c}`).join(', ')} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = $1 AND s.expires_at > $2`,
      [hash(sid), this.now()],
    )
    return (u as User) ?? null
  }

  async endSession(sid: string | undefined): Promise<void> {
    if (sid) await this.sql`DELETE FROM sessions WHERE id_hash = ${hash(sid)}`
  }

  async newApiKey(userId: string): Promise<string> {
    const key = token('ds_', 24)
    await this.sql`UPDATE users SET api_key_hash = ${hash(key)} WHERE id = ${userId}`
    return key
  }

  async userByApiKey(key: string): Promise<User | null> {
    if (!key.startsWith('ds_')) return null
    const [u] = await this.sql.unsafe(`SELECT ${USER_COLS} FROM users WHERE api_key_hash = $1`, [hash(key)])
    return (u as User) ?? null
  }

  // ---- switches --------------------------------------------------------------

  async switches(userId: string): Promise<Switch[]> {
    return (await this.sql.unsafe(`SELECT ${SWITCH_COLS} FROM switches WHERE user_id = $1 ORDER BY created_at`, [userId])) as Switch[]
  }

  async switchOf(userId: string, switchId: string): Promise<Switch | null> {
    const [s] = await this.sql.unsafe(`SELECT ${SWITCH_COLS} FROM switches WHERE id = $1 AND user_id = $2`, [switchId, userId])
    return (s as Switch) ?? null
  }

  async switchById(switchId: string): Promise<Switch | null> {
    const [s] = await this.sql.unsafe(`SELECT ${SWITCH_COLS} FROM switches WHERE id = $1`, [switchId])
    return (s as Switch) ?? null
  }

  async createSwitch(userId: string, f: { name: string; interval_days: number; grace_days: number }): Promise<Switch> {
    const now = this.now()
    const sid = id()
    await this.sql`INSERT INTO switches (id, user_id, name, interval_days, grace_days, last_checkin_at, due_at)
      VALUES (${sid}, ${userId}, ${f.name}, ${f.interval_days}, ${f.grace_days}, ${now}, ${new Date(now.getTime() + f.interval_days * DAY)})`
    return (await this.switchById(sid))!
  }

  /** Changing the interval moves the deadline from the last check-in, never into the past. */
  async updateSwitch(sw: Switch, f: { name?: string; interval_days?: number; grace_days?: number }): Promise<Switch> {
    const name = f.name ?? sw.name
    const interval = f.interval_days ?? sw.interval_days
    const grace = f.grace_days ?? sw.grace_days
    const due = new Date(Math.max(sw.last_checkin_at.getTime() + interval * DAY, this.now().getTime() + DAY))
    const moved = interval !== sw.interval_days
    await this.sql`UPDATE switches SET name = ${name}, interval_days = ${interval}, grace_days = ${grace},
      due_at = ${moved ? due : sw.due_at}, reminders_sent = ${moved ? 0 : sw.reminders_sent} WHERE id = ${sw.id}`
    return (await this.switchById(sw.id))!
  }

  async setBundle(switchId: string, sealed: Sealed | null, bytes: number, hint: string): Promise<void> {
    await this.sql`UPDATE switches SET bundle = ${sealed}, bundle_bytes = ${bytes}, hint = ${hint.slice(0, 500)}, bundle_at = ${sealed ? this.now() : null} WHERE id = ${switchId}`
  }

  async setState(switchId: string, state: 'armed' | 'paused'): Promise<void> {
    // Resuming starts a fresh period: a switch that was paused for months does not wake up overdue.
    if (state === 'armed') await this.checkIn(switchId, 'resume', true)
    else await this.sql`UPDATE switches SET state = 'paused' WHERE id = ${switchId} AND state = 'armed'`
  }

  async deleteSwitch(switchId: string): Promise<void> {
    await this.sql`DELETE FROM switches WHERE id = ${switchId}`
  }

  /** I am alive: the clock starts again. A fired switch stays fired unless `rearm`. */
  async checkIn(switchId: string, via: string, rearm = false): Promise<Switch | null> {
    const now = this.now()
    const rows = await this.sql`UPDATE switches SET last_checkin_at = ${now}, due_at = ${now}::timestamptz + make_interval(days => interval_days),
      reminders_sent = 0, last_reminder_at = NULL, state = 'armed'
      WHERE id = ${switchId} AND (state = 'armed' OR ${rearm}) RETURNING id`
    if (!rows.length) return null
    await this.sql`INSERT INTO checkins (switch_id, via) VALUES (${switchId}, ${via.slice(0, 40)})`
    return this.switchById(switchId)
  }

  async checkins(switchId: string, limit = 10): Promise<Checkin[]> {
    return (await this.sql`SELECT at, via FROM checkins WHERE switch_id = ${switchId} ORDER BY at DESC LIMIT ${limit}`) as Checkin[]
  }

  /** Armed switches whose deadline has passed: the worker's queue. */
  async overdue(limit = 500): Promise<Switch[]> {
    return (await this.sql.unsafe(`SELECT ${SWITCH_COLS} FROM switches WHERE state = 'armed' AND due_at <= $1 ORDER BY due_at LIMIT $2`, [this.now(), limit])) as Switch[]
  }

  /** Count one reminder, if nobody else just did. */
  async claimReminder(sw: Switch): Promise<boolean> {
    const rows = await this.sql`UPDATE switches SET reminders_sent = reminders_sent + 1, last_reminder_at = ${this.now()}
      WHERE id = ${sw.id} AND state = 'armed' AND reminders_sent = ${sw.reminders_sent} AND date_trunc('milliseconds', due_at) = ${sw.due_at} RETURNING id`
    return rows.length === 1
  }

  /** Flip to fired, if it is still the overdue switch we looked at. */
  async claimFire(sw: Switch): Promise<boolean> {
    const rows = await this.sql`UPDATE switches SET state = 'fired', fired_at = ${this.now()}
      WHERE id = ${sw.id} AND state = 'armed' AND date_trunc('milliseconds', due_at) = ${sw.due_at} RETURNING id`
    return rows.length === 1
  }

  // ---- recipients ------------------------------------------------------------

  async recipients(switchId: string): Promise<Recipient[]> {
    return (await this.sql`SELECT id, switch_id, name, email, released_at, opened_at, created_at FROM recipients WHERE switch_id = ${switchId} ORDER BY created_at`) as Recipient[]
  }

  async addRecipient(switchId: string, name: string, email: string): Promise<void> {
    await this.sql`INSERT INTO recipients (id, switch_id, name, email) VALUES (${id()}, ${switchId}, ${name.slice(0, 80)}, ${email.trim().toLowerCase()})`
  }

  async removeRecipient(switchId: string, recipientId: string): Promise<void> {
    await this.sql`DELETE FROM recipients WHERE id = ${recipientId} AND switch_id = ${switchId}`
  }

  /** A release link for this recipient; the database keeps only its hash. */
  async release(recipientId: string): Promise<string> {
    const t = token('r_', 24)
    await this.sql`UPDATE recipients SET token_hash = ${hash(t)}, released_at = ${this.now()} WHERE id = ${recipientId}`
    return t
  }

  async byReleaseToken(t: string): Promise<{ recipient: Recipient; sw: Switch; owner: User } | null> {
    const [r] = await this.sql`SELECT id, switch_id, name, email, released_at, opened_at, created_at FROM recipients WHERE token_hash = ${hash(t)}`
    if (!r) return null
    const sw = await this.switchById(r.switch_id)
    if (!sw || sw.state !== 'fired') return null
    const owner = (await this.user(sw.user_id))!
    return { recipient: r as Recipient, sw, owner }
  }

  async markOpened(recipientId: string): Promise<void> {
    await this.sql`UPDATE recipients SET opened_at = coalesce(opened_at, ${this.now()}) WHERE id = ${recipientId}`
  }

  // ---- web push --------------------------------------------------------------

  async addPush(userId: string, sub: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
    await this.sql`INSERT INTO push_subs (id, user_id, endpoint, p256dh, auth) VALUES (${id()}, ${userId}, ${sub.endpoint}, ${sub.p256dh}, ${sub.auth})
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
  }

  async pushSubs(userId: string): Promise<PushSub[]> {
    return (await this.sql`SELECT id, user_id, endpoint, p256dh, auth FROM push_subs WHERE user_id = ${userId}`) as PushSub[]
  }

  async dropPush(endpoint: string): Promise<void> {
    await this.sql`DELETE FROM push_subs WHERE endpoint = ${endpoint}`
  }

  // ---- phone calls -----------------------------------------------------------

  async recordCall(callId: string, switchId: string): Promise<void> {
    await this.sql`INSERT INTO calls (call_id, switch_id) VALUES (${callId}, ${switchId}) ON CONFLICT DO NOTHING`
  }

  async callSwitch(callId: string): Promise<string | null> {
    const [r] = await this.sql`SELECT switch_id FROM calls WHERE call_id = ${callId}`
    return r?.switch_id ?? null
  }

  // ---- payments --------------------------------------------------------------

  async recordPayment(p: { ref: string; user_id: string; product: string; amount_cents: number; chain: string; raw: unknown }): Promise<void> {
    await this.sql`INSERT INTO payments (ref, user_id, product, amount_cents, chain, raw) VALUES (${p.ref}, ${p.user_id}, ${p.product}, ${p.amount_cents}, ${p.chain}, ${p.raw as object})
      ON CONFLICT (ref) DO NOTHING`
  }

  async payment(ref: string): Promise<Payment | null> {
    const [p] = await this.sql`SELECT ref, user_id, product, amount_cents, chain, status, settled_at, created_at FROM payments WHERE ref = ${ref}`
    return (p as Payment) ?? null
  }

  async payments(userId: string): Promise<Payment[]> {
    return (await this.sql`SELECT ref, user_id, product, amount_cents, chain, status, settled_at, created_at FROM payments WHERE user_id = ${userId} ORDER BY created_at DESC`) as Payment[]
  }

  /**
   * Record a webhook status. The first time a payment settles it grants the
   * plan: a year from now (or from the current end, if still paid up), or for good.
   */
  async settlePayment(ref: string, status: string, raw: unknown, settled: boolean): Promise<{ granted: boolean }> {
    return this.sql.begin(async (tx) => {
      const [p] = await tx`SELECT ref, user_id, product, settled_at FROM payments WHERE ref = ${ref} FOR UPDATE`
      if (!p) return { granted: false }
      await tx`UPDATE payments SET status = ${status || 'unknown'}, raw = ${raw as object}, updated_at = ${this.now()} WHERE ref = ${ref}`
      if (!settled || p.settled_at) return { granted: false }
      await tx`UPDATE payments SET settled_at = ${this.now()} WHERE ref = ${ref}`
      if (p.product === 'lifetime') {
        await tx`UPDATE users SET plan = 'lifetime', plan_until = NULL WHERE id = ${p.user_id}`
      } else {
        await tx`UPDATE users SET plan = CASE WHEN plan = 'lifetime' THEN plan ELSE 'pro' END,
          plan_until = greatest(coalesce(plan_until, ${this.now()}), ${this.now()}) + interval '365 days', renewal_warned_at = NULL
          WHERE id = ${p.user_id}`
      }
      return { granted: true }
    })
  }

  /** Paid plans that end within `withinMs` and have not been warned this period. */
  async renewalsDue(withinMs: number): Promise<User[]> {
    return (await this.sql.unsafe(
      `SELECT ${USER_COLS} FROM users WHERE plan = 'pro' AND plan_until BETWEEN $1 AND $2 AND renewal_warned_at IS NULL`,
      [this.now(), new Date(this.now().getTime() + withinMs)],
    )) as User[]
  }

  async markRenewalWarned(userId: string): Promise<void> {
    await this.sql`UPDATE users SET renewal_warned_at = ${this.now()} WHERE id = ${userId}`
  }
}
