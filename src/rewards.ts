/**
 * Credit codes and invites.
 *
 * A credit code (@profullstack/redeem-credits, unit `keeper_days`) is days of
 * the Keeper plan. Days land on the person's credit balance and are applied
 * straight away through the same row a payment writes (`users.plan` /
 * `users.plan_until`, read by `isPaid`), so there is one Keeper plan, not two:
 * days added while Keeper runs go on the end, a lapsed plan starts from now.
 * Someone on Keeper for life is refused before a code is spent, so they can
 * pass it on. Days granted out of band (the CLI's `grant`) are applied the next
 * time that person opens /me.
 *
 * Invites (@profullstack/affiliates) are scarce: three links per person, each
 * works once. When someone NEW makes an account through one, both of them get
 * INVITE_BONUS_DAYS days of Keeper. Affiliate links (?ref=) are open and only
 * record who brought whom, first touch.
 */
import { Affiliates, postgresStore as affiliateStore } from '@profullstack/affiliates'
import { Credits, postgresStore } from '@profullstack/redeem-credits'
import type { Store, User } from './db.js'

export const KEEPER_UNIT = 'keeper_days'
/** Invite links each person can hand out. Scarce on purpose: an invite should mean something. */
export const INVITES_PER_PERSON = 3
/** Keeper days both people get when an invite brings someone new in. */
export const INVITE_BONUS_DAYS = 7
export const INVITE_CODE = /^[A-Za-z0-9_-]{6,64}$/
export const REF_CODE = /^[A-Za-z0-9_-]{4,40}$/

const WHY: Record<string, string> = {
  invalid: 'That code is not valid.',
  expired: 'That code has expired.',
  used_up: 'That code has been used.',
  already_redeemed: 'You already redeemed that code.',
  revoked: 'That code was withdrawn.',
}

export class RewardError extends Error {}

/** Bun's SQL client in the `query(sql, params) -> { rows }` shape both modules take. */
export const pgAdapter = (store: Store) => ({
  query: async (sql: string, params: unknown[] = []) => ({ rows: (await store.sql.unsafe(sql, params as never[])) as any[] }),
})

export class Rewards {
  readonly credits: Credits
  readonly affiliates: Affiliates

  constructor(private readonly store: Store) {
    const pg = pgAdapter(store)
    this.credits = new Credits(postgresStore(pg))
    this.affiliates = new Affiliates(affiliateStore(pg), { defaultQuota: INVITES_PER_PERSON })
  }

  /**
   * Move every Keeper day on this person's balance onto their plan. Credits can
   * also arrive outside a redemption, so /me calls this too. The new end date, or null.
   */
  async apply(u: User): Promise<Date | null> {
    if (u.plan === 'lifetime') return null
    const days = await this.credits.balance(u.id, KEEPER_UNIT)
    if (days <= 0) return null
    const spent = await this.credits.spend(u.id, KEEPER_UNIT, days, 'Keeper plan days applied')
    if (!spent.ok) return null
    return this.store.extendKeeper(u.id, days)
  }

  /** Redeem a credit code for a signed-in person; the message to show them. */
  async redeem(u: User, input: unknown): Promise<{ message: string; days: number; until: Date | null }> {
    const code = String(input ?? '').trim()
    if (!code) throw new RewardError('Type the code first.')
    if (u.plan === 'lifetime') throw new RewardError('You have Keeper for life already. Pass the code on to someone who does not.')
    const r = await this.credits.redeem(code, u.id)
    if (!r.ok) throw new RewardError(WHY[r.reason] ?? 'That code did not work.')
    const g = r.grant
    if (g.unit !== KEEPER_UNIT) return { message: `Code redeemed: ${g.amount} ${g.unit}.`, days: 0, until: null }
    const until = await this.apply(u)
    const every = g.every === 'month' ? ` every month${g.months ? ` for ${g.months} months` : ''}` : ''
    const what = `${g.amount} day${g.amount === 1 ? '' : 's'} of Keeper${every}`
    return { message: `Code redeemed: ${what}.${until ? ` Keeper runs until ${until.toISOString().slice(0, 10)}.` : ''}`, days: g.amount, until }
  }

  /** A new account came in through an invite: spend it, and both people get Keeper days. */
  async acceptInvite(code: string, u: User): Promise<{ ok: boolean; reason?: string; inviterId?: string }> {
    const r = await this.affiliates.redeemInvite(code, u.id)
    if (!r.ok) return { ok: false, reason: r.reason }
    const bonus = { unit: KEEPER_UNIT, amount: INVITE_BONUS_DAYS }
    await this.credits.grant(u.id, bonus, `invited by ${r.inviterId}`)
    await this.credits.grant(r.inviterId, bonus, `invited ${u.id}`)
    await this.apply(u)
    const inviter = await this.store.user(r.inviterId)
    if (inviter) await this.apply(inviter)
    return { ok: true, inviterId: r.inviterId }
  }

  async invitesView(u: User, origin: string) {
    const invites = await this.affiliates.invites(u.id)
    return {
      quota: await this.affiliates.quota(u.id),
      invites: invites.map((i) => ({ id: i.id, note: i.note, created_at: i.createdAt, expires_at: i.expiresAt, used_at: i.usedAt, revoked_at: i.revokedAt })),
      affiliate: `${origin}/?ref=${await this.affiliates.affiliateCode(u.id)}`,
      bonus_days: INVITE_BONUS_DAYS,
    }
  }

  /** Make one invite link; throws RewardError when none are left. */
  async createInvite(u: User, origin: string, note = ''): Promise<string> {
    try {
      const inv = await this.affiliates.createInvite(u.id, note.slice(0, 80))
      return `${origin}/i/${inv.code}`
    } catch (e) {
      throw new RewardError(e instanceof Error && /no invites/.test(e.message) ? 'You have used all your invites.' : 'Could not make an invite. Try again.')
    }
  }
}
