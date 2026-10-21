/**
 * The whole flow against a real Postgres: sign in, make a switch, seal, check
 * in, let the clock run out, release, open; and a CoinPay webhook granting a
 * plan. Needs TEST_DATABASE_URL (a server we may create databases on), e.g.
 *
 *   docker run -d --name dms-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55491:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55491/postgres bun test
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { SQL } from 'bun'
import { Store } from '../src/db.ts'
import { DAY } from '../src/engine.ts'
import type { Mail, Notifier } from '../src/notify.ts'
import { planConfig } from '../src/plans.ts'
import { createApp } from '../src/server.ts'
import { open, seal } from '../src/seal.ts'
import { tick } from '../src/worker.ts'

const BASE = process.env.TEST_DATABASE_URL
const KEY = 'k'.repeat(40)
const db = `dms_test_${process.pid}_${Date.now()}`

let clock = Date.now()
let store: Store
let app: ReturnType<typeof createApp>
const mails: Mail[] = []
const notifier: Notifier = {
  callsEnabled: false,
  vapidPublic: '',
  mail: async (m) => (mails.push(m), true),
  push: async () => 0,
  call: async () => false,
}
const plans = planConfig({ COINPAY_API_KEY: 'cp_key', COINPAY_BUSINESS_ID: 'biz', COINPAY_WEBHOOK_SECRET: 'whsec', COINPAY_API_URL: 'https://coinpay.test' })
const fakeFetch = (async (url: string) => {
  if (String(url).endsWith('/api/payments/create')) return Response.json({ success: true, payment: { id: 'pay_1' } })
  return new Response('no', { status: 404 })
}) as unknown as typeof fetch

const lastLink = (re: RegExp) => {
  const m = [...mails].reverse().map((x) => x.text.match(re)).find(Boolean)
  if (!m) throw new Error(`no mail matching ${re}`)
  return m[1]!
}

const run = BASE ? describe : describe.skip

run('deadman.switch end to end', () => {
  let cookie = ''
  let csrf = ''
  let switchId = ''

  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { 'x-forwarded-proto': 'https', host: 'deadman.switch.pit.world', 'x-moshpit-name': 'deadman.switch', ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) } })
  // The test clock runs past the 60-day session; sign in again where needed.
  const resignIn = async () => {
    cookie = `ds_session=${await store.newSession((await store.userByEmail('owner@example.com'))!.id)}`
    csrf = (await (await req('/plans')).text()).match(/name="csrf" value="([a-f0-9]{32})"/)![1]!
  }
  const post = (path: string, fields: Record<string, string>) => req(path, { method: 'POST', body: new URLSearchParams({ csrf, ...fields }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })

  beforeAll(async () => {
    const admin = new SQL(BASE!)
    await admin.unsafe(`CREATE DATABASE ${db}`)
    await admin.close()
    store = new Store(BASE!.replace(/\/[^/]*$/, `/${db}`), () => new Date(clock))
    await store.migrate()
    await store.migrate() // twice: idempotent
    app = createApp({ store, key: KEY, plans, notifier, notify: {} as any, fetch: fakeFetch, secureCookies: false })
  })

  afterAll(async () => {
    await store?.close()
    const admin = new SQL(BASE!)
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`)
    await admin.close()
  })

  test('sign in by email link, one click, one use', async () => {
    let res = await req('/signin', { method: 'POST', body: new URLSearchParams({ csrf: 'anon', email: 'Owner@Example.com', next: '/me' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    expect(res.status).toBe(200)
    const t = lastLink(/\/auth\/([A-Za-z0-9_-]+)/)
    // GET only shows a button, so a mail scanner can't spend the link.
    expect((await req(`/auth/${t}`)).status).toBe(200)
    res = await req(`/auth/${t}`, { method: 'POST', body: new URLSearchParams({ next: '/me' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    expect(res.status).toBe(302)
    cookie = res.headers.get('set-cookie')!.split(';')[0]!
    expect((await req(`/auth/${t}`, { method: 'POST', body: new URLSearchParams({}) })).status).toBe(400)
    const page = await (await req('/me')).text()
    expect(page).toContain('owner@example.com')
    csrf = page.match(/name="csrf" value="([a-f0-9]{32})"/)![1]!
  })

  test('cross-site form posts are refused', async () => {
    const res = await req('/me/name', { method: 'POST', body: new URLSearchParams({ csrf, name: 'x' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' } })
    expect(res.status).toBe(403)
  })

  test('make a switch, name yourself, add a recipient', async () => {
    await post('/me/name', { name: 'Dad' })
    const res = await post('/s', { name: 'My crypto', interval_days: '30', grace_days: '7' })
    expect(res.status).toBe(302)
    switchId = res.headers.get('location')!.match(/\/s\/([^?]+)/)![1]!
    expect((await post(`/s/${switchId}/recipients`, { name: 'Kid', email: 'kid@example.com' })).status).toBe(302)
    expect((await post(`/s/${switchId}/recipients`, { name: 'Kid2', email: 'kid2@example.com' })).status).toBe(302)
    // The free plan sends to two people.
    expect((await post(`/s/${switchId}/recipients`, { email: 'three@example.com' })).status).toBe(400)
    expect(await (await req(`/s/${switchId}`)).text()).toContain('kid@example.com')
  })

  test('the free plan holds one switch', async () => {
    const res = await post('/s', { name: 'Second' })
    expect(await res.text()).toContain('Your plan holds 1 switch')
  })

  test('seal a bundle: the server stores only ciphertext', async () => {
    const sealed = await seal({ note: 'Ledger is in the safe.', files: [] }, 'our first dog 1999', 100_000)
    const res = await req(`/s/${switchId}/bundle`, { method: 'POST', body: JSON.stringify({ bundle: sealed, hint: 'first dog, then the year' }), headers: { 'content-type': 'application/json', 'x-csrf': csrf } })
    expect(res.status).toBe(200)
    const [row] = await store.sql`SELECT bundle::text AS b FROM switches WHERE id = ${switchId}`
    expect(row.b).not.toContain('Ledger')
    // Not without the page's token.
    expect((await req(`/s/${switchId}/bundle`, { method: 'POST', body: JSON.stringify({ bundle: sealed }), headers: { 'content-type': 'application/json' } })).status).toBe(403)
  })

  test('API key: status and check-in', async () => {
    const page = await (await post('/me/key', {})).text()
    const key = page.match(/(ds_[A-Za-z0-9_-]+)/)![1]!
    const auth = { authorization: `Bearer ${key}` }
    const me = await (await req('/api/v1/me', { headers: auth })).json()
    expect(me.switches[0].sealed).toBe(true)
    expect((await req('/api/v1/me')).status).toBe(401)
    clock += 10 * DAY
    const r = await (await req('/api/v1/checkin', { method: 'POST', body: JSON.stringify({ via: 'cli' }), headers: { ...auth, 'content-type': 'application/json' } })).json()
    expect(r.checked_in).toHaveLength(1)
    expect(new Date(r.checked_in[0].due_at).getTime()).toBe(clock + 30 * DAY)
  })

  test('missed check-in: three reminders, the email link checks in', async () => {
    clock += 30 * DAY
    mails.length = 0
    expect(await tick({ store, notifier, plans, key: KEY, origin: 'https://deadman.switch.pit.world' }, clock)).toEqual({ reminded: 1, fired: 0 })
    // A second worker in the same minute does nothing.
    expect((await tick({ store, notifier, plans, key: KEY, origin: 'x' }, clock)).reminded).toBe(0)
    const t = lastLink(/\/c\/([A-Za-z0-9_.-]+)/)
    expect(await (await req(`/c/${t}`)).text()).toContain("I'm here")
    const res = await req(`/c/${t}`, { method: 'POST', headers: { accept: 'application/json' } })
    expect((await res.json()).ok).toBe(true)
    // The link is spent once the deadline moves.
    expect((await (await req(`/c/${t}`, { method: 'POST', headers: { accept: 'application/json' } })).json()).ok).toBe(false)
  })

  test('nobody checks in: it fires, recipients open it with the passphrase', async () => {
    clock += 30 * DAY
    const deps = { store, notifier, plans, key: KEY, origin: 'https://deadman.switch.pit.world' }
    const r1 = await tick(deps, clock)
    expect(r1.reminded).toBe(1)
    // Grace is 7 days: reminders at +0, +2.33, +4.67 days; fire at +7 (a day after the last).
    await tick(deps, (clock += 3 * DAY))
    await tick(deps, (clock += 2 * DAY))
    expect((await tick(deps, (clock += 1 * DAY))).fired).toBe(0)
    mails.length = 0
    expect((await tick(deps, (clock += 1 * DAY))).fired).toBe(1)
    expect(mails.map((m) => m.to).sort()).toEqual(['kid2@example.com', 'kid@example.com', 'owner@example.com'])
    const toKid = mails.find((m) => m.to === 'kid@example.com')!
    expect(toKid.subject).toBe('Dad left something for you')
    expect(toKid.text).toContain('first dog, then the year')
    const t = toKid.text.match(/\/r\/(r_[A-Za-z0-9_-]+)/)![1]!
    const page = await (await req(`/r/${t}`)).text()
    expect(page).toContain('Dad left this for you')
    const rel = await (await req(`/api/v1/releases/${t}`)).json()
    expect((await open(rel.bundle, 'our first dog 1999')).note).toBe('Ledger is in the safe.')
    expect((await req('/r/r_nope')).status).toBe(404)
    // Fired switches don't take a new bundle until re-armed.
    await resignIn()
    expect((await req(`/s/${switchId}/bundle`, { method: 'POST', body: JSON.stringify({ bundle: rel.bundle }), headers: { 'content-type': 'application/json', 'x-csrf': csrf } })).status).toBe(409)
  })

  test('a deadline written by SQL (microseconds) still reminds and fires', async () => {
    const u = (await store.userByEmail('owner@example.com'))!
    const sw = await store.createSwitch(u.id, { name: 'Micro', interval_days: 1, grace_days: 1 })
    await store.sql`UPDATE switches SET due_at = ${new Date(clock - 5 * DAY)}::timestamptz + interval '123 microseconds' WHERE id = ${sw.id}`
    const deps = { store, notifier, plans, key: KEY, origin: 'x' }
    expect((await tick(deps, clock)).reminded).toBeGreaterThanOrEqual(1)
    const after = (await store.switchById(sw.id))!
    expect(after.reminders_sent).toBe(1)
    await store.deleteSwitch(sw.id)
  })

  test('paying: checkout records the payment, a signed webhook grants a year once', async () => {
    await resignIn()
    const res = await post('/plans/checkout', { product: 'year', chain: 'USDC_SOL' })
    expect(res.headers.get('location')).toBe('https://coinpay.test/pay/pay_1')
    const body = JSON.stringify({ id: 'evt_1', type: 'payment.confirmed', data: { payment_id: 'pay_1', status: 'confirmed' } })
    const sign = (raw: string) => {
      const t = Math.floor(Date.now() / 1000)
      return `t=${t},v1=${createHmac('sha256', 'whsec').update(`${t}.${raw}`).digest('hex')}`
    }
    expect((await req('/hooks/coinpay', { method: 'POST', body, headers: { 'x-coinpay-signature': 't=1,v1=00' } })).status).toBe(401)
    const ok = await (await req('/hooks/coinpay', { method: 'POST', body, headers: { 'x-coinpay-signature': sign(body) } })).json()
    expect(ok.granted).toBe(true)
    const again = await (await req('/hooks/coinpay', { method: 'POST', body, headers: { 'x-coinpay-signature': sign(body) } })).json()
    expect(again.granted).toBe(false)
    const u = (await store.userByEmail('owner@example.com'))!
    expect(u.plan).toBe('pro')
    expect(Math.round((u.plan_until!.getTime() - clock) / DAY)).toBe(365)
  })
})
