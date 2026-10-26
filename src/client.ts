/**
 * The deadman.switch API from anywhere: the CLI, the TUI and the MCP server use this.
 * DEADMAN_URL points it at another instance; DEADMAN_KEY (ds_…) is your key from /me,
 * or the one `deadman login` saved in ~/.config/deadman/key.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Sealed } from './seal.js'

export type ApiRecipient = { id: string; name: string; email: string; released_at: string | null; opened_at: string | null }
export type ApiSwitch = {
  id: string
  name: string
  state: 'armed' | 'paused' | 'fired'
  interval_days: number
  grace_days: number
  last_checkin_at: string
  due_at: string
  reminders_sent: number
  fired_at: string | null
  hint: string
  sealed: boolean
  bundle_bytes: number
  bundle_at: string | null
  recipients: ApiRecipient[]
  url: string
  bundle?: Sealed | null
}
export type ApiMe = { email: string; name: string; plan: string; paid: boolean; limits: { switches: number; recipients: number; bundleBytes: number }; switches: ApiSwitch[] }
export type ApiRedeem = { ok: true; message: string; days: number; plan: string; paid: boolean; plan_until: string | null }
export type ApiInvites = {
  quota: { total: number; used: number; left: number }
  invites: { id: string; note: string; created_at: number; expires_at: number | null; used_at: number | null; revoked_at: number | null }[]
  affiliate: string
  bonus_days: number
}
export type ApiRelease = { from: string; switch: string; last_checkin_at: string; hint: string; bundle: Sealed | null }

export const KEY_FILE = join(homedir(), '.config', 'deadman', 'key')
export const DEFAULT_URL = 'https://deadman.switch.pit.world'

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function savedKey(): string | undefined {
  try {
    return existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() || undefined : undefined
  } catch {
    return undefined
  }
}

export class DeadmanClient {
  readonly base: string
  constructor(base = process.env.DEADMAN_URL ?? DEFAULT_URL, readonly key: string | undefined = process.env.DEADMAN_KEY ?? savedKey(), private readonly doFetch: typeof fetch = fetch) {
    this.base = base.replace(/\/+$/, '')
  }

  async call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    if (auth && !this.key) throw new ApiError(`No key. Make one at ${this.base}/me#account, then: deadman login ds_…`, 401)
    const res = await this.doFetch(this.base + path, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: `Bearer ${this.key}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new ApiError(data.error ?? `deadman.switch answered ${res.status}`, res.status)
    return data as T
  }

  me = () => this.call<ApiMe>('GET', '/api/v1/me')
  switches = () => this.call<{ switches: ApiSwitch[] }>('GET', '/api/v1/switches').then((r) => r.switches)
  get = (id: string) => this.call<ApiSwitch>('GET', `/api/v1/switches/${encodeURIComponent(id)}`)
  create = (input: { name: string; interval_days?: number; grace_days?: number; recipients?: { name?: string; email: string }[] }) => this.call<ApiSwitch>('POST', '/api/v1/switches', input)
  update = (id: string, input: { name?: string; interval_days?: number; grace_days?: number }) => this.call<ApiSwitch>('PATCH', `/api/v1/switches/${encodeURIComponent(id)}`, input)
  remove = (id: string) => this.call<{ ok: true }>('DELETE', `/api/v1/switches/${encodeURIComponent(id)}`)
  pause = (id: string) => this.call<ApiSwitch>('POST', `/api/v1/switches/${encodeURIComponent(id)}/pause`)
  resume = (id: string) => this.call<ApiSwitch>('POST', `/api/v1/switches/${encodeURIComponent(id)}/resume`)
  addRecipient = (id: string, email: string, name = '') => this.call<ApiSwitch>('POST', `/api/v1/switches/${encodeURIComponent(id)}/recipients`, { email, name })
  removeRecipient = (id: string, rid: string) => this.call<ApiSwitch>('DELETE', `/api/v1/switches/${encodeURIComponent(id)}/recipients/${encodeURIComponent(rid)}`)
  putBundle = (id: string, bundle: Sealed, hint?: string) => this.call<{ ok: true; bytes: number }>('PUT', `/api/v1/switches/${encodeURIComponent(id)}/bundle`, { bundle, ...(hint !== undefined ? { hint } : {}) })
  checkin = (via: 'cli' | 'mcp' | 'tui' | 'api', switchId?: string) => this.call<{ checked_in: ApiSwitch[] }>('POST', '/api/v1/checkin', { via, ...(switchId ? { switch_id: switchId } : {}) }).then((r) => r.checked_in)

  redeem = (code: string) => this.call<ApiRedeem>('POST', '/api/v1/redeem', { code })
  invites = () => this.call<ApiInvites>('GET', '/api/v1/invites')
  newInvite = (note = '') => this.call<{ link: string }>('POST', '/api/v1/invites', { note })

  /** A release link (https://…/r/r_…) or bare token; needs no key. */
  release(link: string): Promise<ApiRelease> {
    const t = link.trim().replace(/^.*\/r\//, '').replace(/[?#].*$/, '')
    return this.call<ApiRelease>('GET', `/api/v1/releases/${encodeURIComponent(t)}`, undefined, false)
  }

  /** Resolve a switch by id or (unique) name. */
  async find(idOrName: string): Promise<ApiSwitch> {
    const all = await this.switches()
    const hit = all.find((s) => s.id === idOrName) ?? all.filter((s) => s.name.toLowerCase() === idOrName.toLowerCase())[0]
    if (!hit) throw new ApiError(`no switch "${idOrName}" (you have: ${all.map((s) => s.name).join(', ') || 'none'})`, 404)
    return hit
  }
}

export function dueText(s: Pick<ApiSwitch, 'state' | 'due_at' | 'fired_at' | 'reminders_sent'>, now = Date.now()): string {
  if (s.state === 'fired') return `SENT ${String(s.fired_at).slice(0, 10)}`
  if (s.state === 'paused') return 'paused'
  const ms = new Date(s.due_at).getTime() - now
  const days = Math.round(Math.abs(ms) / 86_400_000)
  const hours = Math.round(Math.abs(ms) / 3_600_000)
  const span = days >= 2 ? `${days} days` : `${hours} hours`
  return ms >= 0 ? `due in ${span}` : `OVERDUE ${span} (reminder ${s.reminders_sent}/3)`
}
