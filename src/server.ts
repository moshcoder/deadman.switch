/**
 * The deadman.switch web server: pages, the JSON API, the worker, and the
 * CoinPay and Telnyx webhooks.
 *
 * deadman.switch is a Moshpit name. Visitors on Moshpit DNS reach
 * https://deadman.switch directly; everyone else comes through the pit.world
 * relay at https://deadman.switch.pit.world, which says so with an
 * x-moshpit-name header. Pages and cookies follow whichever one the visitor
 * used; anything that leaves the box (email links, webhooks) uses the relay,
 * because nobody outside Moshpit can resolve the name.
 */
import { createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { Store, type Switch, type User } from './db.js'
import { GRACES, INTERVALS } from './engine.js'
import {
  checkedInPage, checkinPage, confirmSigninPage, dashboardPage, helpPage, homePage, messagePage, plansPage, releasePage, signinPage, switchPage, type Ctx,
} from './html.js'
import { createNotifier, notifyConfig, telnyxCommand, type Notifier, type NotifyConfig } from './notify.js'
import { startPitFooterRefresh } from './pit-footer.js'
import { isPaid, limitsFor, planConfig, planLabel, readWebhook, SETTLED, startCheckout, verifyWebhook, type PlanConfig, type Product } from './plans.js'
import { ringDescriptor, startRingFooterRefresh } from './ring-footer.js'
import { RING_PLACEHOLDER, ringBar, startRingRefresh, visitorOnMoshpit } from './ring.js'
import { checkSealed } from './seal.js'
import { VERSION } from './version.js'
import { startWorker, switchForCheckinToken } from './worker.js'

export { VERSION }

const SELF = 'deadman.switch'
const DIRECT_ORIGIN = 'https://deadman.switch'
export const RELAY_ORIGIN = 'https://deadman.switch.pit.world'
const SESSION = 'ds_session'

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' https://crawlproof.com; img-src 'self' data: blob:; connect-src 'self' https://crawlproof.com; worker-src 'self'; manifest-src 'self'; form-action 'self' https://coinpayportal.com; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'interest-cohort=(), browsing-topics=(), camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
}

export type Deps = { store: Store; key: string; plans: PlanConfig; notifier: Notifier; notify: NotifyConfig; fetch?: typeof fetch; secureCookies?: boolean; telnyxPublicKey?: string }

class Limiter {
  private hits = new Map<string, { n: number; reset: number }>()
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    if (!h || h.reset < now) {
      if (this.hits.size > 50_000) this.hits.clear()
      this.hits.set(key, { n: 1, reset: now + this.windowMs })
      return true
    }
    h.n += 1
    return h.n <= this.max
  }
}

const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i
const intIn = (v: unknown, allowed: readonly number[], fallback: number) => (allowed.includes(Number(v)) ? Number(v) : fallback)
const safeNext = (n: unknown) => (typeof n === 'string' && /^\/[a-z0-9/_-]*$/i.test(n) ? n : '/me')

export function createApp(deps: Deps) {
  const { store, plans, notifier } = deps
  const app = new Hono()
  const signinLimit = new Limiter(10, 60 * 60_000)
  const apiLimit = new Limiter(120, 60_000)

  const direct = (c: Context) => visitorOnMoshpit(SELF, c.req.header('host'), c.req.header('x-moshpit-name'))
  const https = (c: Context) => (c.req.header('x-forwarded-proto') ?? 'https') === 'https'
  const origin = (c: Context) => (direct(c) && https(c) ? DIRECT_ORIGIN : RELAY_ORIGIN)
  const ip = (c: Context) => c.req.header('x-real-ip') ?? 'local'
  const sessionId = (c: Context) => getCookie(c, SESSION)
  const csrfFor = (sid: string | undefined) => (sid ? createHmac('sha256', deps.key).update(`csrf:${sid}`).digest('hex').slice(0, 32) : 'anon')
  const csrfOk = (c: Context, given: unknown) => {
    const g = Buffer.from(String(given ?? ''))
    const e = Buffer.from(csrfFor(sessionId(c)))
    return g.length === e.length && timingSafeEqual(g, e)
  }
  const ctxOf = async (c: Context): Promise<Ctx> => ({ user: await store.session(sessionId(c)), csrf: csrfFor(sessionId(c)), origin: origin(c) })
  const page = (c: Context, html: string, status = 200) => c.html(html.replace(RING_PLACEHOLDER, ringBar(SELF, direct(c))), status as 200)
  const form = async (c: Context) => (await c.req.parseBody()) as Record<string, string>

  app.use('*', async (c, next) => {
    // Forms only from our own pages: a cross-site POST is refused before it reaches a handler.
    if (c.req.method === 'POST' && !c.req.path.startsWith('/api/') && !c.req.path.startsWith('/hooks/') && c.req.header('sec-fetch-site') === 'cross-site') {
      return c.text('cross-site request refused', 403)
    }
    await next()
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v)
  })

  app.get('/health', (c) => c.json({ ok: true, version: VERSION }))
  app.get('/.well-known/openwebring.json', (c) => c.json(ringDescriptor(), 200, { 'access-control-allow-origin': '*' }))

  const TYPES: Record<string, string> = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json', html: 'text/html; charset=utf-8', crt: 'application/x-x509-ca-cert' }
  app.get('/:file{(style\\.css|app\\.js|sw\\.js|favicon\\.svg|icon-192\\.png|icon-512\\.png|manifest\\.webmanifest|offline\\.html|moshpit-root-ca\\.crt)}', async (c) => {
    const name = c.req.param('file')
    const file = Bun.file(new URL(`../public/${name}`, import.meta.url))
    const cache = name === 'sw.js' ? 'no-cache' : 'public, max-age=86400'
    return c.body(await file.arrayBuffer(), 200, { 'content-type': TYPES[name.split('.').pop()!]!, 'cache-control': cache })
  })

  app.get('/', async (c) => page(c, homePage(await ctxOf(c))))
  app.get('/help', async (c) => page(c, helpPage(await ctxOf(c))))

  // ---- signing in -------------------------------------------------------------

  app.get('/signin', async (c) => {
    const ctx = await ctxOf(c)
    if (ctx.user) return c.redirect(safeNext(c.req.query('next')))
    return page(c, signinPage(ctx, { next: safeNext(c.req.query('next')) }))
  })

  app.post('/signin', async (c) => {
    const ctx = await ctxOf(c)
    const f = await form(c)
    const email = String(f.email ?? '').trim().toLowerCase()
    if (!csrfOk(c, f.csrf)) return page(c, signinPage(ctx, { error: 'That form went stale. Try again.' }), 400)
    if (!EMAIL.test(email)) return page(c, signinPage(ctx, { error: 'That does not look like an email address.' }), 400)
    if (!signinLimit.allow(`ip:${ip(c)}`) || (await store.recentLoginLinks(email, 60 * 60_000)) >= 5) {
      return page(c, signinPage(ctx, { error: 'Too many sign-in emails. Try again in an hour.' }), 429)
    }
    const t = await store.newLoginLink(email)
    const next = safeNext(f.next)
    await notifier.mail({
      to: email,
      subject: 'Your deadman.switch sign-in link',
      text: `Sign in to deadman.switch:\n\n${origin(c)}/auth/${t}?next=${encodeURIComponent(next)}\n\nIt works once, for 20 minutes. If you didn't ask for this, ignore it.\n`,
    })
    return page(c, signinPage(ctx, { sent: email }))
  })

  app.get('/auth/:token', async (c) => page(c, confirmSigninPage(await ctxOf(c), c.req.param('token'), safeNext(c.req.query('next')))))

  app.post('/auth/:token', async (c) => {
    const f = await form(c)
    const email = await store.takeLoginLink(c.req.param('token'))
    if (!email) return page(c, messagePage(await ctxOf(c), { title: 'That link is used up', message: 'Sign-in links work once, for 20 minutes.', link: { href: '/signin', label: 'Send a new one' } }), 400)
    const user = await store.ensureUser(email)
    const sid = await store.newSession(user.id)
    setCookie(c, SESSION, sid, { httpOnly: true, secure: deps.secureCookies ?? https(c), sameSite: 'Lax', path: '/', maxAge: 60 * 86400 })
    return c.redirect(safeNext(f.next))
  })

  app.post('/auth/logout', async (c) => {
    const f = await form(c)
    if (csrfOk(c, f.csrf)) await store.endSession(sessionId(c))
    deleteCookie(c, SESSION, { path: '/' })
    return c.redirect('/')
  })

  // ---- the owner's pages ------------------------------------------------------

  const signedIn = async (c: Context): Promise<{ ctx: Ctx; user: User } | null> => {
    const ctx = await ctxOf(c)
    return ctx.user ? { ctx, user: ctx.user } : null
  }

  const dashboard = async (c: Context, ctx: Ctx, extra: { apiKey?: string; flash?: string } = {}) => {
    const user = ctx.user!
    const switches = await Promise.all((await store.switches(user.id)).map(async (s) => ({ ...s, recipients: (await store.recipients(s.id)).length })))
    return page(c, dashboardPage(ctx, { switches, limits: limitsFor(plans, user), plan: planLabel(plans, user), paid: isPaid(plans, user), callsEnabled: notifier.callsEnabled, vapid: notifier.vapidPublic, now: Date.now(), ...extra }))
  }

  app.get('/me', async (c) => {
    const s = await signedIn(c)
    if (!s) return c.redirect('/signin?next=/me')
    return dashboard(c, s.ctx, c.req.query('flash') ? { flash: c.req.query('flash')! } : {})
  })

  app.post('/me/:action{(checkin|phone|name|key|delete)}', async (c) => {
    const s = await signedIn(c)
    if (!s) return c.redirect('/signin?next=/me')
    const f = await form(c)
    if (!csrfOk(c, f.csrf)) return dashboard(c, s.ctx, { flash: 'That form went stale. Try again.' })
    switch (c.req.param('action')) {
      case 'checkin': {
        let n = 0
        for (const sw of await store.switches(s.user.id)) if (sw.state === 'armed' && (await store.checkIn(sw.id, 'web'))) n += 1
        return c.redirect(`/me?flash=${encodeURIComponent(n ? `Checked in on ${n} switch${n === 1 ? '' : 'es'}. Thanks.` : 'Nothing armed to check in on.')}`)
      }
      case 'phone': {
        const phone = String(f.phone ?? '').replace(/[\s().-]/g, '')
        if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) return dashboard(c, s.ctx, { flash: 'Use international format, like +15551234567.' })
        await store.updateUser(s.user.id, { phone })
        return c.redirect(`/me?flash=${encodeURIComponent(phone ? 'Number saved.' : 'Number removed.')}#phone`)
      }
      case 'name':
        await store.updateUser(s.user.id, { name: String(f.name ?? '').trim() })
        return c.redirect('/me?flash=Saved.#account')
      case 'key':
        return dashboard(c, s.ctx, { apiKey: await store.newApiKey(s.user.id) })
      case 'delete':
        if (f.sure !== '1') return dashboard(c, s.ctx, { flash: 'Tick the box to delete.' })
        await store.deleteUser(s.user.id)
        deleteCookie(c, SESSION, { path: '/' })
        return page(c, messagePage(await ctxOf(c), { title: 'Deleted', message: 'Your account, switches and sealed bundles are gone.' }))
    }
    return c.redirect('/me')
  })

  app.post('/push', async (c) => {
    const s = await signedIn(c)
    if (!s) return c.json({ error: 'sign in first' }, 401)
    if (!csrfOk(c, c.req.header('x-csrf'))) return c.json({ error: 'stale page, reload' }, 403)
    const body = (await c.req.json().catch(() => null)) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | null
    const endpoint = body?.endpoint
    if (!endpoint || !/^https:\/\//.test(endpoint) || !body?.keys?.p256dh || !body.keys.auth) return c.json({ error: 'not a push subscription' }, 400)
    await store.addPush(s.user.id, { endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth })
    return c.json({ ok: true })
  })

  const ownSwitch = async (c: Context): Promise<{ ctx: Ctx; user: User; sw: Switch } | Response> => {
    const s = await signedIn(c)
    if (!s) return c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`)
    const sw = await store.switchOf(s.user.id, c.req.param('id')!)
    if (!sw) return page(c, messagePage(s.ctx, { title: 'Not found', message: 'No switch of yours has that address.', link: { href: '/me', label: 'My switches' } }), 404)
    return { ...s, sw }
  }

  const showSwitch = async (c: Context, ctx: Ctx, sw: Switch, extra: { flash?: string; error?: string } = {}, status = 200) =>
    page(c, switchPage(ctx, { sw, recipients: await store.recipients(sw.id), checkins: await store.checkins(sw.id), limits: limitsFor(plans, ctx.user!), now: Date.now(), ...extra }), status)

  app.post('/s', async (c) => {
    const s = await signedIn(c)
    if (!s) return c.redirect('/signin?next=/me')
    const f = await form(c)
    if (!csrfOk(c, f.csrf)) return dashboard(c, s.ctx, { flash: 'That form went stale. Try again.' })
    const limits = limitsFor(plans, s.user)
    if ((await store.switches(s.user.id)).length >= limits.switches) return dashboard(c, s.ctx, { flash: `Your plan holds ${limits.switches} switch${limits.switches === 1 ? '' : 'es'}.` })
    const sw = await store.createSwitch(s.user.id, {
      name: String(f.name ?? '').trim().slice(0, 80) || 'My crypto',
      interval_days: intIn(f.interval_days, INTERVALS, 30),
      grace_days: intIn(f.grace_days, GRACES, 7),
    })
    return c.redirect(`/s/${sw.id}?flash=${encodeURIComponent('Made. Now write and seal your bundle, then add who gets it.')}#bundle`)
  })

  app.get('/s/:id', async (c) => {
    const r = await ownSwitch(c)
    if (r instanceof Response) return r
    return showSwitch(c, r.ctx, r.sw, c.req.query('flash') ? { flash: c.req.query('flash')! } : {})
  })

  app.post('/s/:id/bundle', async (c) => {
    const r = await ownSwitch(c)
    if (r instanceof Response) return c.json({ error: 'not found' }, 404)
    if (!csrfOk(c, c.req.header('x-csrf'))) return c.json({ error: 'stale page, reload' }, 403)
    if (r.sw.state === 'fired') return c.json({ error: 'this switch was already sent; re-arm it first' }, 409)
    const body = (await c.req.json().catch(() => null)) as { bundle?: unknown; hint?: string } | null
    try {
      const { sealed, bytes } = checkSealed(body?.bundle, limitsFor(plans, r.user).bundleBytes)
      await store.setBundle(r.sw.id, sealed, bytes, String(body?.hint ?? ''))
      return c.json({ ok: true, bytes })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
    }
  })

  const switchAction = async (c: Context, action: string | undefined) => {
    const r = await ownSwitch(c)
    if (r instanceof Response) return r
    const f = await form(c)
    if (!csrfOk(c, f.csrf)) return showSwitch(c, r.ctx, r.sw, { error: 'That form went stale. Try again.' }, 400)
    const back = (flash: string) => c.redirect(`/s/${r.sw.id}?flash=${encodeURIComponent(flash)}`)
    switch (action) {
      case undefined: {
        await store.updateSwitch(r.sw, { name: String(f.name ?? '').trim().slice(0, 80) || r.sw.name, interval_days: intIn(f.interval_days, INTERVALS, r.sw.interval_days), grace_days: intIn(f.grace_days, GRACES, r.sw.grace_days) })
        return back('Saved.')
      }
      case 'checkin':
        await store.checkIn(r.sw.id, 'web', r.sw.state === 'paused')
        return back('Checked in. Thanks.')
      case 'pause':
        await store.setState(r.sw.id, 'paused')
        return back('Paused. Nothing is sent while it is paused; check in to resume.')
      case 'rearm':
        await store.checkIn(r.sw.id, 'rearm', true)
        return back('Re-armed. A fresh period starts now.')
      case 'delete':
        await store.deleteSwitch(r.sw.id)
        return c.redirect('/me?flash=Deleted.')
      case 'recipients': {
        const email = String(f.email ?? '').trim().toLowerCase()
        if (!EMAIL.test(email)) return showSwitch(c, r.ctx, r.sw, { error: 'That does not look like an email address.' }, 400)
        const have = await store.recipients(r.sw.id)
        const max = limitsFor(plans, r.user).recipients
        if (have.length >= max) return showSwitch(c, r.ctx, r.sw, { error: `Your plan sends to ${max} people per switch.` }, 400)
        if (have.some((p) => p.email === email)) return back('Already on the list.')
        await store.addRecipient(r.sw.id, String(f.name ?? '').trim(), email)
        return back(`Added. ${email} hears nothing from us unless this fires.`)
      }
    }
    return back('')
  }
  app.post('/s/:id', (c) => switchAction(c, undefined))
  app.post('/s/:id/:action{(checkin|pause|rearm|delete|recipients)}', (c) => switchAction(c, c.req.param('action')))

  app.post('/s/:id/recipients/:rid/delete', async (c) => {
    const r = await ownSwitch(c)
    if (r instanceof Response) return r
    const f = await form(c)
    if (csrfOk(c, f.csrf) && r.sw.state !== 'fired') await store.removeRecipient(r.sw.id, c.req.param('rid'))
    return c.redirect(`/s/${r.sw.id}#people`)
  })

  // ---- one-tap check-in (email link, push button) ------------------------------

  app.get('/c/:token', async (c) => {
    const ctx = await ctxOf(c)
    const sw = await switchForCheckinToken(store, deps.key, c.req.param('token'))
    if (!sw) return page(c, messagePage(ctx, { title: 'Already checked in', message: 'That check-in link is from an earlier period, so you are fine. Sign in to see your switches.', link: { href: '/me', label: 'My switches' } }))
    return page(c, checkinPage(ctx, c.req.param('token'), sw))
  })

  app.post('/c/:token', async (c) => {
    const ctx = await ctxOf(c)
    const sw = await switchForCheckinToken(store, deps.key, c.req.param('token'))
    const done = sw ? await store.checkIn(sw.id, c.req.header('x-via') === 'push' ? 'push' : 'link') : null
    if (c.req.header('accept')?.includes('application/json')) return c.json({ ok: Boolean(done), due_at: done?.due_at ?? null })
    if (!done) return page(c, messagePage(ctx, { title: 'Already checked in', message: 'That link is from an earlier period, so you are fine.', link: { href: '/me', label: 'My switches' } }))
    return page(c, checkedInPage(ctx, done))
  })

  // ---- what an heir opens ------------------------------------------------------

  app.get('/r/:token', async (c) => {
    const ctx = await ctxOf(c)
    const found = await store.byReleaseToken(c.req.param('token'))
    if (!found) return page(c, messagePage(ctx, { title: 'Nothing here', message: 'This link does not open anything. If someone sent it to you, check you copied all of it.' }), 404)
    await store.markOpened(found.recipient.id)
    return page(c, releasePage(ctx, found))
  })

  // ---- plans -------------------------------------------------------------------

  const plansView = async (c: Context, ctx: Ctx, error?: string, status = 200) =>
    page(c, plansPage(ctx, { chains: plans.chains, plan: ctx.user ? planLabel(plans, ctx.user) : 'Free', paid: ctx.user ? isPaid(plans, ctx.user) : false, payments: ctx.user ? await store.payments(ctx.user.id) : [], enabled: Boolean(plans.coinpay), ...(error ? { error } : {}) }), status)

  app.get('/plans', async (c) => plansView(c, await ctxOf(c)))

  app.post('/plans/checkout', async (c) => {
    const s = await signedIn(c)
    if (!s) return c.redirect('/signin?next=/plans')
    const f = await form(c)
    if (!csrfOk(c, f.csrf)) return plansView(c, s.ctx, 'That form went stale. Try again.', 400)
    try {
      const out = await startCheckout(plans, store, { user: s.user, product: (f.product === 'lifetime' ? 'lifetime' : 'year') as Product, chain: String(f.chain ?? ''), successUrl: `${origin(c)}/me?flash=${encodeURIComponent('Payment sent. Your plan starts as soon as CoinPay confirms it.')}`, cancelUrl: `${origin(c)}/plans` }, deps.fetch)
      return c.redirect(out.checkoutUrl)
    } catch (e) {
      return plansView(c, s.ctx, e instanceof Error ? e.message : String(e), 502)
    }
  })

  app.post('/hooks/coinpay', async (c) => {
    const raw = await c.req.text()
    if (!plans.coinpay || !verifyWebhook(plans.coinpay.webhookSecret, raw, c.req.header('x-coinpay-signature') ?? c.req.header('coinpay-signature'))) return c.json({ error: 'bad signature' }, 401)
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return c.json({ error: 'bad json' }, 400)
    }
    const { ref, status } = readWebhook(payload)
    // Only payments we started count; the account comes from our row, never from the payload.
    const known = ref ? await store.payment(String(ref)) : null
    if (!known) return c.json({ ok: true, ignored: 'unknown payment' })
    const r = await store.settlePayment(known.ref, status, payload, SETTLED.has(status))
    if (r.granted) {
      const u = await store.user(known.user_id)
      if (u) await notifier.mail({ to: u.email, subject: 'Keeper is on', text: `Thanks for paying. Your plan: ${planLabel(plans, u)}.\n\n${RELAY_ORIGIN}/me\n` })
    }
    return c.json({ ok: true, status, granted: r.granted })
  })

  // Telnyx Call Control: answered -> ask for 1 -> 1 checks in.
  app.post('/hooks/telnyx', async (c) => {
    const raw = await c.req.text()
    if (!telnyxSignatureOk(deps.telnyxPublicKey, raw, c.req.header('telnyx-signature-ed25519'), c.req.header('telnyx-timestamp'))) return c.json({ error: 'bad signature' }, 401)
    const event = JSON.parse(raw)?.data
    const callId = event?.payload?.call_control_id
    const switchId = callId ? await store.callSwitch(callId) : null
    if (!switchId) return c.json({ ok: true })
    const sw = await store.switchById(switchId)
    const doFetch = deps.fetch ?? fetch
    switch (event.event_type) {
      case 'call.answered':
        await telnyxCommand(deps.notify, callId, 'gather_using_speak', {
          payload: `This is deadman switch. Your switch, ${sw?.name ?? 'your switch'}, will be sent to the people you chose unless you check in. Press 1 to check in now.`,
          voice: 'female', language: 'en-US', minimum_digits: 1, maximum_digits: 1, valid_digits: '1', timeout_millis: 15000,
        }, doFetch)
        break
      case 'call.gather.ended':
        if (event.payload?.digits === '1' && sw) {
          await store.checkIn(sw.id, 'phone')
          await telnyxCommand(deps.notify, callId, 'speak', { payload: 'Thank you. You are checked in. Goodbye.', voice: 'female', language: 'en-US' }, doFetch)
        } else await telnyxCommand(deps.notify, callId, 'speak', { payload: 'We did not get a 1. Check in from the email we sent you. Goodbye.', voice: 'female', language: 'en-US' }, doFetch)
        break
      case 'call.speak.ended':
        await telnyxCommand(deps.notify, callId, 'hangup', {}, doFetch)
        break
    }
    return c.json({ ok: true })
  })

  // ---- the JSON API (Bearer ds_…) ----------------------------------------------

  const api = new Hono<{ Variables: { user: User } }>()
  api.use('*', async (c, next) => {
    if (!apiLimit.allow(`api:${ip(c)}`)) return c.json({ error: 'slow down: 120 requests a minute' }, 429)
    if (c.req.path.includes('/releases/')) return next()
    const key = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const user = key ? await store.userByApiKey(key) : null
    if (!user) return c.json({ error: 'send Authorization: Bearer ds_… (make a key at /me)' }, 401)
    c.set('user', user)
    await next()
  })

  const view = async (sw: Switch) => ({
    id: sw.id, name: sw.name, state: sw.state, interval_days: sw.interval_days, grace_days: sw.grace_days,
    last_checkin_at: sw.last_checkin_at, due_at: sw.due_at, reminders_sent: sw.reminders_sent, fired_at: sw.fired_at,
    hint: sw.hint, sealed: Boolean(sw.bundle), bundle_bytes: sw.bundle_bytes, bundle_at: sw.bundle_at,
    recipients: (await store.recipients(sw.id)).map((r) => ({ id: r.id, name: r.name, email: r.email, released_at: r.released_at, opened_at: r.opened_at })),
    url: `${RELAY_ORIGIN}/s/${sw.id}`,
  })

  api.get('/me', async (c) => {
    const u = c.get('user')
    return c.json({ email: u.email, name: u.name, plan: planLabel(plans, u), paid: isPaid(plans, u), limits: limitsFor(plans, u), switches: await Promise.all((await store.switches(u.id)).map(view)) })
  })
  api.get('/switches', async (c) => c.json({ switches: await Promise.all((await store.switches(c.get('user').id)).map(view)) }))
  api.post('/switches', async (c) => {
    const u = c.get('user')
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: string; interval_days?: number; grace_days?: number; recipients?: { name?: string; email: string }[] }
    const limits = limitsFor(plans, u)
    if ((await store.switches(u.id)).length >= limits.switches) return c.json({ error: `your plan holds ${limits.switches} switches` }, 402)
    const recipients = (b.recipients ?? []).filter((r) => r && EMAIL.test(String(r.email ?? '')))
    if (recipients.length > limits.recipients) return c.json({ error: `your plan sends to ${limits.recipients} people per switch` }, 402)
    const sw = await store.createSwitch(u.id, { name: String(b.name ?? '').trim().slice(0, 80) || 'My crypto', interval_days: intIn(b.interval_days, INTERVALS, 30), grace_days: intIn(b.grace_days, GRACES, 7) })
    for (const r of recipients) await store.addRecipient(sw.id, String(r.name ?? ''), r.email)
    return c.json(await view(sw), 201)
  })
  const apiSwitch = async (c: Context<{ Variables: { user: User } }>) => store.switchOf(c.get('user').id, c.req.param('id')!)
  api.get('/switches/:id', async (c) => {
    const sw = await apiSwitch(c)
    return sw ? c.json({ ...(await view(sw)), bundle: sw.bundle }) : c.json({ error: 'not found' }, 404)
  })
  api.patch('/switches/:id', async (c) => {
    const sw = await apiSwitch(c)
    if (!sw) return c.json({ error: 'not found' }, 404)
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: string; interval_days?: number; grace_days?: number }
    const next = await store.updateSwitch(sw, {
      ...(b.name ? { name: String(b.name).trim().slice(0, 80) } : {}),
      ...(b.interval_days !== undefined ? { interval_days: intIn(b.interval_days, INTERVALS, sw.interval_days) } : {}),
      ...(b.grace_days !== undefined ? { grace_days: intIn(b.grace_days, GRACES, sw.grace_days) } : {}),
    })
    return c.json(await view(next))
  })
  api.delete('/switches/:id', async (c) => {
    const sw = await apiSwitch(c)
    if (!sw) return c.json({ error: 'not found' }, 404)
    await store.deleteSwitch(sw.id)
    return c.json({ ok: true })
  })
  api.put('/switches/:id/bundle', async (c) => {
    const sw = await apiSwitch(c)
    if (!sw) return c.json({ error: 'not found' }, 404)
    if (sw.state === 'fired') return c.json({ error: 'this switch was already sent; re-arm it first' }, 409)
    const b = (await c.req.json().catch(() => null)) as { bundle?: unknown; hint?: string } | null
    try {
      const { sealed, bytes } = checkSealed(b?.bundle, limitsFor(plans, c.get('user')).bundleBytes)
      await store.setBundle(sw.id, sealed, bytes, String(b?.hint ?? sw.hint))
      return c.json({ ok: true, bytes })
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
    }
  })
  api.post('/switches/:id/:action{(pause|resume)}', async (c) => {
    const sw = await apiSwitch(c)
    if (!sw) return c.json({ error: 'not found' }, 404)
    if (sw.state === 'fired') return c.json({ error: 'this switch was already sent' }, 409)
    await store.setState(sw.id, c.req.param('action') === 'pause' ? 'paused' : 'armed')
    return c.json(await view((await store.switchById(sw.id))!))
  })
  api.post('/switches/:id/recipients', async (c) => {
    const sw = await apiSwitch(c)
    if (!sw) return c.json({ error: 'not found' }, 404)
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { name?: string; email?: string }
    const email = String(b.email ?? '').trim().toLowerCase()
    if (!EMAIL.test(email)) return c.json({ error: 'email required' }, 400)
    const have = await store.recipients(sw.id)
    const max = limitsFor(plans, c.get('user')).recipients
    if (have.length >= max) return c.json({ error: `your plan sends to ${max} people per switch` }, 402)
    if (!have.some((p) => p.email === email)) await store.addRecipient(sw.id, String(b.name ?? ''), email)
    return c.json(await view(sw), 201)
  })
  api.delete('/switches/:id/recipients/:rid', async (c) => {
    const sw = await apiSwitch(c)
    if (!sw) return c.json({ error: 'not found' }, 404)
    await store.removeRecipient(sw.id, c.req.param('rid'))
    return c.json(await view(sw))
  })
  api.post('/checkin', async (c) => {
    const u = c.get('user')
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { switch_id?: string; via?: string }
    const via = ['cli', 'mcp', 'tui', 'api'].includes(String(b.via)) ? String(b.via) : 'api'
    const targets = (await store.switches(u.id)).filter((s) => (b.switch_id ? s.id === b.switch_id : s.state === 'armed'))
    if (b.switch_id && !targets.length) return c.json({ error: 'not found' }, 404)
    const done: Switch[] = []
    for (const s of targets) {
      const r = await store.checkIn(s.id, via, s.state === 'paused' && Boolean(b.switch_id))
      if (r) done.push(r)
    }
    return c.json({ checked_in: await Promise.all(done.map(view)) })
  })
  api.get('/releases/:token', async (c) => {
    const found = await store.byReleaseToken(c.req.param('token'))
    if (!found) return c.json({ error: 'not found' }, 404)
    await store.markOpened(found.recipient.id)
    return c.json({ from: found.owner.name || found.owner.email, switch: found.sw.name, last_checkin_at: found.sw.last_checkin_at, hint: found.sw.hint, bundle: found.sw.bundle })
  })
  app.route('/api/v1', api)

  app.notFound(async (c) => page(c, messagePage(await ctxOf(c), { title: 'Not found', message: 'Nothing lives at this address.' }), 404))
  return app
}

/** Telnyx signs `${timestamp}|${body}` with Ed25519; the portal shows the bare 32-byte key in base64. */
export function telnyxSignatureOk(publicKey: string | undefined, raw: string, signature: string | undefined, timestamp: string | undefined, nowSeconds = Date.now() / 1000): boolean {
  if (!publicKey || !signature || !timestamp || Math.abs(nowSeconds - Number(timestamp)) > 300) return false
  try {
    const bare = Buffer.from(publicKey, 'base64')
    const der = bare.length === 32 ? Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bare]) : bare
    return verify(null, Buffer.from(`${timestamp}|${raw}`), createPublicKey({ key: der, format: 'der', type: 'spki' }), Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

export async function serve(opts: { port?: number } = {}) {
  const env = process.env
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set (postgres://…)')
  if (!env.DEADMAN_SECRET || env.DEADMAN_SECRET.length < 32) throw new Error('DEADMAN_SECRET must be at least 32 characters')
  const store = new Store(env.DATABASE_URL)
  await store.migrate()
  const plans = planConfig(env)
  const notify = notifyConfig(env, RELAY_ORIGIN)
  const notifier = createNotifier(notify, store)
  const app = createApp({ store, key: env.DEADMAN_SECRET, plans, notifier, notify, ...(env.TELNYX_PUBLIC_KEY ? { telnyxPublicKey: env.TELNYX_PUBLIC_KEY } : {}) })
  startPitFooterRefresh(SELF)
  startRingFooterRefresh()
  startRingRefresh()
  if (env.WORKER !== 'off') startWorker({ store, notifier, plans, key: env.DEADMAN_SECRET, origin: RELAY_ORIGIN, log: console.log })
  const port = opts.port ?? Number(env.PORT ?? 8801)
  return Bun.serve({ port, hostname: env.HOST ?? '127.0.0.1', fetch: app.fetch, idleTimeout: 30 })
}

if (import.meta.main) {
  const s = await serve()
  console.log(`deadman.switch ${VERSION} listening on http://${s.hostname}:${s.port}`)
}
