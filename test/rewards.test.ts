/**
 * Credit codes (Keeper days) and invites, against a real Postgres (TEST_DATABASE_URL, see app.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { Store } from '../src/db.ts'
import type { Mail, Notifier } from '../src/notify.ts'
import { planConfig } from '../src/plans.ts'
import { INVITE_BONUS_DAYS, KEEPER_UNIT, Rewards } from '../src/rewards.ts'
import { createApp } from '../src/server.ts'

const BASE = process.env.TEST_DATABASE_URL
const KEY = 'k'.repeat(40)
const db = `dms_rw_${process.pid}_${Date.now()}`
const DAY = 86_400_000

let store: Store
let app: ReturnType<typeof createApp>
let rewards: Rewards
const mails: Mail[] = []
const notifier: Notifier = { callsEnabled: false, vapidPublic: '', mail: async (m) => (mails.push(m), true), push: async () => 0, call: async () => false }
const plans = planConfig({})

const run = BASE ? describe : describe.skip

type Browser = { cookies: Map<string, string> }
const browser = (): Browser => ({ cookies: new Map() })

const req = async (b: Browser, path: string, init: RequestInit = {}) => {
  const cookie = [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  const res = await app.request(path, { ...init, headers: { 'x-forwarded-proto': 'https', host: 'deadman.switch.pit.world', 'x-moshpit-name': 'deadman.switch', ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) } })
  for (const sc of res.headers.getSetCookie()) {
    const [kv, ...attrs] = sc.split(';')
    const [k, v] = kv!.split('=') as [string, string]
    if (attrs.some((a) => /max-age=0\b/i.test(a.trim())) || v === '') b.cookies.delete(k)
    else b.cookies.set(k, v)
  }
  return res
}
const form = (fields: Record<string, string>): RequestInit => ({ method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
const csrfOf = async (b: Browser) => (await (await req(b, '/me')).text()).match(/name="csrf" value="([a-f0-9]{32})"/)![1]!

/** The whole email sign-in in one browser (optionally clicking the link in another). */
async function signIn(b: Browser, email: string, clickIn: Browser = b): Promise<void> {
  await req(b, '/signin', form({ csrf: 'anon', email, next: '/me' }))
  const t = [...mails].reverse().map((m) => m.text.match(/\/auth\/([A-Za-z0-9_-]+)/)).find(Boolean)![1]!
  const res = await req(clickIn, `/auth/${t}`, form({ next: '/me' }))
  expect(res.status).toBe(302)
}

run('credit codes and invites', () => {
  beforeAll(async () => {
    const admin = new SQL(BASE!)
    await admin.unsafe(`CREATE DATABASE ${db}`)
    await admin.close()
    store = new Store(BASE!.replace(/\/[^/]*$/, `/${db}`))
    await store.migrate()
    app = createApp({ store, key: KEY, plans, notifier, notify: {} as any, secureCookies: false })
    rewards = new Rewards(store)
  })

  afterAll(async () => {
    await store?.close()
    const admin = new SQL(BASE!)
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
    await admin.close()
  })

  test('redeem: a good code puts Keeper days on the plan; again is refused; nonsense is invalid', async () => {
    const b = browser()
    await signIn(b, 'alice@example.com')
    const { code } = await rewards.credits.mint({ grant: { unit: KEEPER_UNIT, amount: 30 }, label: 'test', maxRedemptions: 5 })
    const csrf = await csrfOf(b)
    let res = await req(b, '/me/redeem', form({ csrf, code: code.toLowerCase() }))
    expect(res.status).toBe(302)
    expect(decodeURIComponent(res.headers.get('location')!)).toContain('30 days of Keeper')
    const u = (await store.userByEmail('alice@example.com'))!
    expect(u.plan).toBe('pro')
    expect(Math.round((u.plan_until!.getTime() - Date.now()) / DAY)).toBe(30)
    expect(await rewards.credits.balance(u.id, KEEPER_UNIT)).toBe(0)
    expect(await (await req(b, '/me')).text()).toContain('Keeper, until')

    res = await req(b, '/me/redeem', form({ csrf, code }))
    expect(await res.text()).toContain('You already redeemed that code.')
    res = await req(b, '/me/redeem', form({ csrf, code: 'CR-NOPE-NOPE-NOPE-NOPE' }))
    expect(await res.text()).toContain('That code is not valid.')

    // A second code goes on the end of the running plan.
    const second = await rewards.credits.mint({ grant: { unit: KEEPER_UNIT, amount: 10 } })
    await req(b, '/me/redeem', form({ csrf, code: second.code }))
    expect(Math.round(((await store.user(u.id))!.plan_until!.getTime() - Date.now()) / DAY)).toBe(40)
  })

  test('redeem over the API, and a lifetime Keeper keeps the code for someone else', async () => {
    const u = await store.ensureUser('bob@example.com')
    const key = await store.newApiKey(u.id)
    const { code } = await rewards.credits.mint({ grant: { unit: KEEPER_UNIT, amount: 14 } })
    const b = browser()
    const res = await req(b, '/api/v1/redeem', { method: 'POST', body: JSON.stringify({ code }), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.paid).toBe(true)
    expect(body.days).toBe(14)

    await store.sql`UPDATE users SET plan = 'lifetime', plan_until = NULL WHERE id = ${u.id}`
    const other = await rewards.credits.mint({ grant: { unit: KEEPER_UNIT, amount: 14 } })
    const refused = await req(b, '/api/v1/redeem', { method: 'POST', body: JSON.stringify({ code: other.code }), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } })
    expect(refused.status).toBe(400)
    expect((await rewards.credits.list()).find((c) => c.id === other.id)!.redemptions).toBe(0)
  })

  test('days granted out of band switch on when /me opens', async () => {
    const b = browser()
    await signIn(b, 'carol@example.com')
    const u = (await store.userByEmail('carol@example.com'))!
    await rewards.credits.grant(u.id, { unit: KEEPER_UNIT, amount: 5 }, 'admin')
    expect(await (await req(b, '/me')).text()).toContain('Keeper, until')
    expect(Math.round(((await store.user(u.id))!.plan_until!.getTime() - Date.now()) / DAY)).toBe(5)
  })

  test('an invite: three each, accepted once, by a new account only; both get Keeper days', async () => {
    const inviter = browser()
    await signIn(inviter, 'dave@example.com')
    const dave = (await store.userByEmail('dave@example.com'))!
    const csrf = await csrfOf(inviter)
    const page = await (await req(inviter, '/invites', form({ csrf, note: 'for Erin' }))).text()
    const link = page.match(/https:\/\/deadman\.switch\.pit\.world\/i\/(INV-[A-Z0-9-]+)/)![1]!
    expect(page).toContain('<b>2</b> of 3')
    await req(inviter, '/invites', form({ csrf }))
    await req(inviter, '/invites', form({ csrf }))
    expect(await (await req(inviter, '/invites', form({ csrf }))).text()).toContain('You have used all your invites.')

    // Erin opens the link on her laptop, clicks the sign-in email on her phone: the invite rides on the link.
    const laptop = browser()
    const phone = browser()
    expect(await (await req(laptop, `/i/${link}`)).text()).toContain(`${INVITE_BONUS_DAYS} days of Keeper`)
    expect(laptop.cookies.get('ds_invite')).toBe(link)
    await signIn(laptop, 'erin@example.com', phone)
    const erin = (await store.userByEmail('erin@example.com'))!
    expect(erin.plan).toBe('pro')
    expect(Math.round((erin.plan_until!.getTime() - Date.now()) / DAY)).toBe(INVITE_BONUS_DAYS)
    expect(await rewards.affiliates.invitedBy(erin.id)).toBe(dave.id)
    // Dave had no plan: now a week of Keeper.
    expect(Math.round(((await store.user(dave.id))!.plan_until!.getTime() - Date.now()) / DAY)).toBe(INVITE_BONUS_DAYS)

    // The same link again, and an existing account through a fresh one: nothing.
    const again = browser()
    await req(again, `/i/${link}`)
    await signIn(again, 'frank@example.com')
    expect((await store.userByEmail('frank@example.com'))!.plan).toBe('free')
    const second = await rewards.affiliates.createInvite(dave.id).catch(() => null)
    expect(second).toBeNull() // quota spent
    const old = browser()
    await rewards.affiliates.setQuota(dave.id, 4)
    const extra = await rewards.affiliates.createInvite(dave.id)
    await req(old, `/i/${extra.code}`)
    await signIn(old, 'alice@example.com') // made in the first test
    expect(await rewards.affiliates.invitedBy((await store.userByEmail('alice@example.com'))!.id)).toBeNull()
  })

  test('?ref= is first touch and credits the affiliate when a new account is made', async () => {
    const owner = await store.ensureUser('gina@example.com')
    const code = await rewards.affiliates.affiliateCode(owner.id)
    const other = await rewards.affiliates.affiliateCode((await store.ensureUser('hal@example.com')).id)
    const b = browser()
    await req(b, `/?ref=${code}`)
    await req(b, `/help?ref=${other}`)
    expect(b.cookies.get('ds_ref')).toBe(code)
    await signIn(b, 'ivy@example.com')
    expect(await rewards.affiliates.affiliateOf((await store.userByEmail('ivy@example.com'))!.id)).toBe(owner.id)
    // An existing account signing in later is not attributed.
    const c = browser()
    await req(c, `/?ref=${code}`)
    await signIn(c, 'hal@example.com')
    expect(await rewards.affiliates.affiliateOf((await store.userByEmail('hal@example.com'))!.id)).toBeNull()
  })
})
