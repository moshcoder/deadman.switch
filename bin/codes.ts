#!/usr/bin/env bun
/**
 * Credit codes for deadman.switch on its own Postgres (the redeem-credits CLI only speaks SQLite).
 * Run on the box, where app.env has DATABASE_URL:
 *
 *   set -a; . /root/.local/share/deadman-switch/app.env; set +a
 *   bun bin/codes.ts mint --days 30 --label "for Dan" [--max 1] [--expires 30d]
 *   bun bin/codes.ts list
 *   bun bin/codes.ts revoke <codeId>
 *   bun bin/codes.ts grant <email> --days 7        (applied next time they open /me)
 *   bun bin/codes.ts invites <email> --total 10   (set someone's invite allowance)
 */
import { Store } from '../src/db.ts'
import { KEEPER_UNIT, Rewards } from '../src/rewards.ts'

const argv = process.argv.slice(2)
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const [command, arg] = argv
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')
const store = new Store(process.env.DATABASE_URL)
const rewards = new Rewards(store)
const userOf = async (email: string | undefined) => {
  const u = email ? await store.userByEmail(email) : null
  if (!u) throw new Error(`no account for ${email}`)
  return u
}
try {
  switch (command) {
    case 'mint': {
      const days = Number(opt('days') ?? 0)
      if (!(days > 0)) throw new Error('--days N is required')
      const exp = opt('expires')
      const expiresAt = exp ? Date.now() + Number(exp.replace(/d$/, '')) * 86_400_000 : null
      const m = await rewards.credits.mint({ grant: { unit: KEEPER_UNIT, amount: days }, label: opt('label') ?? '', maxRedemptions: Number(opt('max') ?? 1), expiresAt, createdBy: 'bin/codes.ts' })
      console.log(JSON.stringify({ code: m.code, id: m.id, days, label: m.label, max: m.maxRedemptions, expiresAt: m.expiresAt }, null, 2))
      break
    }
    case 'list':
      for (const c of await rewards.credits.list()) console.log(`${c.id}  ${c.grant.amount} ${c.grant.unit}  ${c.redemptions}/${c.maxRedemptions}  ${c.revokedAt ? 'revoked' : ''}  ${c.label}`)
      break
    case 'revoke':
      if (!arg) throw new Error('usage: revoke <codeId>')
      await rewards.credits.revoke(arg)
      console.log('revoked')
      break
    case 'grant': {
      const u = await userOf(arg)
      await rewards.credits.grant(u.id, { unit: KEEPER_UNIT, amount: Number(opt('days') ?? 0) }, 'bin/codes.ts grant')
      console.log(`granted; Keeper until ${(await rewards.apply(u))?.toISOString() ?? '(not applied: lifetime?)'}`)
      break
    }
    case 'invites': {
      const u = await userOf(arg)
      await rewards.affiliates.setQuota(u.id, Number(opt('total') ?? 3))
      console.log(JSON.stringify(await rewards.affiliates.quota(u.id)))
      break
    }
    default:
      console.log('usage: bun bin/codes.ts mint|list|revoke|grant|invites (see the top of this file)')
  }
} finally {
  await store.close()
}
