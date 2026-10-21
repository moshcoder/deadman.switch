/**
 * Server-rendered pages. One script (public/app.js) seals and opens bundles in
 * the browser and turns on push; everything except those works without it.
 * Sealing cannot work without it, on purpose: the plaintext never leaves the page.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Checkin, Payment, Recipient, Switch, User } from './db.js'
import { describeDays, fireAt, GRACES, INTERVALS } from './engine.js'
import { pitFooter } from './pit-footer.js'
import { CHAIN_LABELS, dollars, PRODUCTS, type Limits } from './plans.js'
import { ringFooter } from './ring-footer.js'
import { RING_PLACEHOLDER } from './ring.js'

export const SITE = 'https://deadman.switch.pit.world'
export const REPO = 'https://github.com/moshcoder/deadman.switch'

/** crawlproof analytics, on public pages only (never on a dashboard or a release). */
const TRACKER = process.env.CRAWLPROOF_SITE ? `<script data-site="${process.env.CRAWLPROOF_SITE}" src="https://crawlproof.com/stats.js" async></script>` : ''

const asset = (name: string) => {
  const body = readFileSync(new URL(`../public/${name}`, import.meta.url))
  return `/${name}?v=${createHash('sha256').update(body).digest('hex').slice(0, 10)}`
}
const STYLE_URL = asset('style.css')
const SCRIPT_URL = asset('app.js')

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)
/** JSON inside <script type="application/json">: not entity-decoded, so only `<` needs guarding. */
const jsonScript = (value: unknown) => JSON.stringify(value ?? null).replace(/</g, '\\u003c')
const day = (d: Date | number | null) => (d ? new Date(d).toISOString().slice(0, 10) : '-')
const stamp = (d: Date | number) => new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

export function inWords(ms: number): string {
  const a = Math.abs(ms)
  const n = (x: number, unit: string) => `${x} ${unit}${x === 1 ? '' : 's'}`
  const text = a < 3_600_000 ? n(Math.max(1, Math.round(a / 60_000)), 'minute') : a < 2 * 86_400_000 ? n(Math.round(a / 3_600_000), 'hour') : n(Math.round(a / 86_400_000), 'day')
  return ms >= 0 ? `in ${text}` : `${text} ago`
}

const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="7" y="13" width="18" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M11 13V9.5a5 5 0 0 1 10 0V13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><circle cx="16" cy="19.5" r="2.2" fill="currentColor"/></svg>`

export type Ctx = { user: User | null; csrf: string; origin: string }
type LayoutOptions = { title: string; description: string; path: string; body: string; ctx: Ctx; noindex?: boolean; script?: boolean; track?: boolean }

function layout(o: LayoutOptions): string {
  const signedIn = Boolean(o.ctx.user)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#07090c">
${o.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(SITE + o.path)}">`}
<meta property="og:type" content="website">
<meta property="og:site_name" content="deadman.switch">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="${STYLE_URL}">
${o.script ? `<script src="${SCRIPT_URL}" defer></script>` : ''}
${o.track ? TRACKER : ''}
</head>
<body>
${RING_PLACEHOLDER}
<header class="top">
  <a class="brand" href="/">${LOGO}<span>deadman<b>.</b>switch</span></a>
  <nav aria-label="Site">
    <a href="/help">How it works</a>
    <a href="/plans">Plans</a>
    ${signedIn ? `<a href="/me">My switches</a><form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${esc(o.ctx.csrf)}"><button class="linkish">Sign out</button></form>` : '<a href="/signin">Sign in</a>'}
  </nav>
</header>
<main>
${o.body}
</main>
${ringFooter()}
${pitFooter()}
</body>
</html>`
}

const csrfField = (ctx: Ctx) => `<input type="hidden" name="csrf" value="${esc(ctx.csrf)}">`

export function homePage(ctx: Ctx): string {
  return layout({
    ctx,
    track: true,
    title: "deadman.switch: a dead man's switch for your crypto",
    description: 'If something happens to you, your crypto should not die with you. Seal where the keys are, check in now and then, and if you stop, the people you chose get it.',
    path: '/',
    body: `<section class="hero">
  <h1>If something happens to you,<br>your crypto shouldn't die with you.</h1>
  <p class="tag">Write down where the wallets, seeds and logins are. Seal it with a passphrase only your family knows. We check in with you now and then. If you stop answering, they get it.</p>
  <a class="btn big" href="${ctx.user ? '/me' : '/signin'}">${ctx.user ? 'My switches' : 'Set one up, free'}</a>
  <p class="muted small">Sign in with just your email. One switch is free, forever.</p>
</section>
<div class="grid3">
  <div class="card"><h2><span class="step-n">1</span>Seal it</h2><p class="muted">Where the hardware wallet is, how the seed is split, the exchange logins, a letter. Sealed in your browser with a passphrase you give your heir.</p></div>
  <div class="card"><h2><span class="step-n">2</span>Check in</h2><p class="muted">Every week, month or year, we ask "still here?" by email and on your phone. One tap and the clock starts again.</p></div>
  <div class="card"><h2><span class="step-n">3</span>If you don't</h2><p class="muted">Three reminders across a grace period you choose, a phone call on the last. Then, and only then, the people you picked get the sealed bundle.</p></div>
</div>
<div class="card">
  <h2>We can't read it. Nobody can, until it's time.</h2>
  <p>Your bundle is locked on your device with AES-256 before it is uploaded. We hold the locked box; your heir holds the passphrase. Before the switch fires they have no box. After it fires, we still have no key. There is nothing for us to leak, and nothing for anyone to subpoena but noise.</p>
  <p class="muted small">The code is open source: <a href="${REPO}">${REPO.replace('https://', '')}</a>.</p>
</div>
${plansTable(ctx)}
<div class="card" id="agents">
  <h2>From the terminal, or from your agent</h2>
  <pre>bunx @profullstack/deadman checkin          # I'm alive
bunx @profullstack/deadman                  # the TUI
claude mcp add deadman -- bunx @profullstack/deadman mcp</pre>
  <p class="muted small">Full API, CLI and MCP on the <a href="/help#api">help page</a>.</p>
</div>`,
  })
}

function plansTable(ctx: Ctx): string {
  return `<div class="card" id="plans">
  <h2>Plans</h2>
  <div class="grid2">
    <div class="plan"><h3>Free</h3><p class="price">$0</p><ul><li>1 switch</li><li>2 people to send it to</li><li>64 KB sealed bundle</li><li>Email and push reminders</li></ul></div>
    <div class="plan featured"><h3>Keeper</h3><p class="price">${dollars(PRODUCTS.year.cents)}<span class="muted">/year</span> <span class="muted small">or ${dollars(PRODUCTS.lifetime.cents)} for life</span></p><ul><li>10 switches</li><li>10 people each</li><li>5 MB sealed bundle (photos, PDFs, keys)</li><li>A phone call on the last reminder</li></ul>
    <a class="btn" href="${ctx.user ? '/plans' : '/signin?next=/plans'}">Get Keeper</a></div>
  </div>
  <p class="muted small">Paid in crypto through <a href="https://coinpayportal.com">CoinPay</a>. If a plan lapses your switches keep running: we never switch off protection because a renewal was missed.</p>
</div>`
}

export function helpPage(ctx: Ctx): string {
  return layout({
    ctx,
    track: true,
    title: 'How it works · deadman.switch',
    description: "How deadman.switch works: sealing, check-ins, reminders, what your heir gets, and the API, CLI and MCP.",
    path: '/help',
    body: `<section class="hero"><h1>How it works</h1><p class="tag">Everything about deadman.switch on one page.</p></section>
<div class="card"><h2>What is a dead man's switch?</h2><p>Something that acts when you stop. Trains have one: the driver holds a pedal, and if they let go, the train stops itself. Here, you check in now and then. If you stop, because something happened to you, we send what you left to the people you chose.</p></div>
<div class="card"><h2>The passphrase</h2>
<p>You seal your bundle with a passphrase, in your browser or the CLI. It never reaches us. <b>Give it to the people who should open it</b>: in your will, on paper in the safe, or in person. Leave yourself a hint they will understand ("the name of our first dog, then the year we met"); the hint is the one thing we show them in the clear.</p>
<p>If they lose the passphrase, nobody can open the bundle, us included. That is the point.</p></div>
<div class="card"><h2>Check-ins and reminders</h2>
<ul>
  <li>Pick how often: every day up to every year. Checking in from anywhere (the email link, the push notification, the web, the CLI) restarts the clock.</li>
  <li>Miss one and you get three reminders spread across your grace period (1 to 30 days), by email and push. On Keeper the last one is also a phone call: press 1 to check in.</li>
  <li>We send nothing until the grace period is over <i>and</i> a full day has passed since the last reminder, even if our server was down for a while.</li>
  <li>Going somewhere with no signal? Pause the switch. Resuming starts a fresh period.</li>
</ul></div>
<div class="card"><h2>What they get</h2><p>Each person gets an email with their own link. The page shows your hint and asks for the passphrase; the bundle opens in their browser. Your note and any files you added (photos of a seed card, a PDF, a key file) are theirs to read and download. You get an email saying it was sent.</p></div>
<div class="card"><h2>What to put in it</h2><ul>
  <li>Which wallets you have and where the hardware is.</li>
  <li>How your seed phrases are stored or split, and where each part is. Putting a full seed in is your call; many people put the <i>location</i> of the seed instead.</li>
  <li>Exchange accounts, and where the 2FA is.</li>
  <li>Who to call: a lawyer, an accountant, a friend who knows crypto.</li>
  <li>Anything else you want them to read.</li>
</ul></div>
<div class="card" id="api"><h2>API, CLI and MCP</h2>
<p>Make an API key on <a href="/me#account">your page</a>. Then:</p>
<pre>export DEADMAN_KEY=ds_…
bunx @profullstack/deadman status                 # your switches and when each is due
bunx @profullstack/deadman checkin                # check in on all of them
bunx @profullstack/deadman seal &lt;switch&gt; note.md  # seal a file locally and upload it
bunx @profullstack/deadman open &lt;release link&gt;    # open what someone left you
bunx @profullstack/deadman mcp                    # MCP server on stdio</pre>
<pre>curl -X POST ${SITE}/api/v1/checkin -H "authorization: Bearer $DEADMAN_KEY"
curl ${SITE}/api/v1/switches -H "authorization: Bearer $DEADMAN_KEY"</pre>
<p class="muted small">Endpoints: <code>GET /api/v1/me</code>, <code>GET|POST /api/v1/switches</code>, <code>GET|PATCH|DELETE /api/v1/switches/:id</code>, <code>PUT /api/v1/switches/:id/bundle</code>, <code>POST /api/v1/switches/:id/(pause|resume|recipients)</code>, <code>DELETE /api/v1/switches/:id/recipients/:rid</code>, <code>POST /api/v1/checkin</code>, <code>GET /api/v1/releases/:token</code>.</p>
<p class="muted small">A warning: an agent or cron job that checks in for you means the switch never fires. Check in yourself, or make sure whatever checks in for you would stop if you did.</p></div>
<div class="card"><h2>Who runs this</h2><p><a href="https://profullstack.com">Profullstack, Inc.</a> Source: <a href="${REPO}">${REPO.replace('https://', '')}</a>. Questions: <a href="mailto:switch@pit.world">switch@pit.world</a>.</p></div>`,
  })
}

export function signinPage(ctx: Ctx, o: { next?: string; error?: string; sent?: string } = {}): string {
  return layout({
    ctx,
    noindex: true,
    title: 'Sign in · deadman.switch',
    description: 'Sign in with your email.',
    path: '/signin',
    body: `<section class="hero"><h1>${o.sent ? 'Check your email' : 'Sign in'}</h1></section>
<div class="card narrow">
${o.sent ? `<p>We sent a sign-in link to <b>${esc(o.sent)}</b>. It works once, for 20 minutes.</p><p class="muted small">Nothing there? Check spam, or <a href="/signin">try again</a>.</p>` : `
${o.error ? `<p class="note error">${esc(o.error)}</p>` : ''}
<form method="post" action="/signin" class="stack">
  ${csrfField(ctx)}
  <input type="hidden" name="next" value="${esc(o.next ?? '')}">
  <label>Your email <input type="email" name="email" required autocomplete="email" autofocus></label>
  <button class="btn">Email me a sign-in link</button>
</form>
<p class="muted small">New here? The link makes your account. No password.</p>`}
</div>`,
  })
}

export function confirmSigninPage(ctx: Ctx, t: string, next: string): string {
  return layout({
    ctx,
    noindex: true,
    title: 'Sign in · deadman.switch',
    description: 'Finish signing in.',
    path: '/auth',
    body: `<section class="hero"><h1>Sign in</h1></section>
<div class="card narrow center">
<form method="post" action="/auth/${esc(t)}">
  <input type="hidden" name="next" value="${esc(next)}">
  <button class="btn big">Sign in to deadman.switch</button>
</form>
<p class="muted small">One click, so a mail scanner that opens links can't use yours up.</p>
</div>`,
  })
}

export function messagePage(ctx: Ctx, o: { title: string; message: string; link?: { href: string; label: string } }): string {
  return layout({
    ctx,
    noindex: true,
    title: `${o.title} · deadman.switch`,
    description: o.message,
    path: '/',
    body: `<section class="hero"><h1>${esc(o.title)}</h1><p class="tag">${esc(o.message)}</p>${o.link ? `<a class="btn" href="${esc(o.link.href)}">${esc(o.link.label)}</a>` : ''}</section>`,
  })
}

function stateBadge(sw: Switch, now: number): string {
  if (sw.state === 'fired') return `<span class="status failed">sent ${esc(day(sw.fired_at))}</span>`
  if (sw.state === 'paused') return '<span class="status pending">paused</span>'
  const left = sw.due_at.getTime() - now
  if (left > 0) return `<span class="status paid">due ${esc(inWords(left))}</span>`
  return `<span class="status pending">overdue: reminder ${sw.reminders_sent} of 3, sends ${esc(inWords(fireAt(sw) - now))}</span>`
}

function intervalSelect(name: string, values: readonly number[], current: number, label: (d: number) => string): string {
  return `<select name="${name}">${values.map((d) => `<option value="${d}"${d === current ? ' selected' : ''}>${esc(label(d))}</option>`).join('')}</select>`
}
const graceLabel = (d: number) => (d === 1 ? '1 day' : `${d} days`)

export type DashboardData = {
  switches: (Switch & { recipients: number })[]
  limits: Limits
  plan: string
  paid: boolean
  callsEnabled: boolean
  vapid: string
  apiKey?: string
  flash?: string
  now: number
}

export function dashboardPage(ctx: Ctx, d: DashboardData): string {
  const user = ctx.user!
  const armed = d.switches.filter((s) => s.state === 'armed').length
  const rows = d.switches
    .map((s) => `<li class="switch"><a href="/s/${esc(s.id)}"><b>${esc(s.name)}</b></a> ${stateBadge(s, d.now)}<br><span class="muted small">${esc(describeDays(s.interval_days))}, ${s.grace_days}-day grace · ${s.recipients} ${s.recipients === 1 ? 'person' : 'people'} · ${s.bundle ? `sealed ${esc(day(s.bundle_at))}` : '<b class="bad">nothing sealed yet</b>'}</span></li>`)
    .join('')
  return layout({
    ctx,
    noindex: true,
    script: true,
    title: 'My switches · deadman.switch',
    description: 'Your switches.',
    path: '/me',
    body: `${d.flash ? `<p class="note">${esc(d.flash)}</p>` : ''}
<section class="hero left"><h1>My switches</h1><p class="muted">${esc(user.email)} · ${esc(d.plan)}</p></section>
${armed ? `<form method="post" action="/me/checkin" class="checkin-all">${csrfField(ctx)}<button class="btn big">I'm here: check in${armed > 1 ? ` on all ${armed}` : ''}</button></form>` : ''}
<div class="card">
  ${rows ? `<ul class="switches">${rows}</ul>` : '<p>No switch yet. Make your first one below: it takes a minute.</p>'}
  ${d.switches.length < d.limits.switches ? `<details${rows ? '' : ' open'}><summary>New switch</summary>
  <form method="post" action="/s" class="stack">
    ${csrfField(ctx)}
    <label>Name it <input name="name" required maxlength="80" placeholder="My crypto" value="${rows ? '' : 'My crypto'}"></label>
    <label>Check in ${intervalSelect('interval_days', INTERVALS, 30, describeDays)}</label>
    <label>Grace period after a missed check-in ${intervalSelect('grace_days', GRACES, 7, graceLabel)}</label>
    <button class="btn">Make it</button>
  </form></details>` : `<p class="muted small">Your plan holds ${d.limits.switches} switch${d.limits.switches === 1 ? '' : 'es'}. ${d.paid ? '' : '<a href="/plans">Keeper</a> holds 10.'}</p>`}
</div>
<div class="card" id="devices">
  <h2>Reminders on this device</h2>
  <p class="muted">Get the check-in on your phone's lock screen with an "I'm OK" button. Add this site to your home screen first on iPhone.</p>
  <button class="btn ghost" id="push-on" data-vapid="${esc(d.vapid)}"${d.vapid ? '' : ' disabled'}>Turn on notifications here</button>
  <p class="muted small" id="push-status"></p>
</div>
<div class="card" id="phone">
  <h2>Phone call on the last reminder</h2>
  ${d.paid ? (d.callsEnabled ? '' : '<p class="muted small">Calls are being set up; we will start calling once they are live.</p>') : '<p class="muted small">A Keeper feature. Save your number now and it starts working when you upgrade.</p>'}
  <form method="post" action="/me/phone" class="row">
    ${csrfField(ctx)}
    <input name="phone" type="tel" placeholder="+15551234567" value="${esc(user.phone)}" pattern="\\+[1-9][0-9]{7,14}" title="International format, like +15551234567">
    <button class="btn ghost">Save</button>
  </form>
</div>
<div class="card" id="account">
  <h2>Account</h2>
  <form method="post" action="/me/name" class="row">${csrfField(ctx)}<input name="name" maxlength="80" placeholder="Your name, as your family knows it" value="${esc(user.name)}"><button class="btn ghost">Save</button></form>
  <p class="muted small">Your name goes in the email your people get, so they know who it is from.</p>
  ${d.apiKey ? `<p class="note">Your API key (shown once): <code>${esc(d.apiKey)}</code></p>` : ''}
  <form method="post" action="/me/key">${csrfField(ctx)}<button class="btn ghost">${d.apiKey ? 'Make another key' : 'Make an API key'}</button></form>
  <p class="muted small">For the CLI, the API and MCP. A new key replaces the old one.</p>
  <details><summary class="bad">Delete my account</summary>
    <form method="post" action="/me/delete" class="stack">${csrfField(ctx)}<p>This deletes every switch and sealed bundle. Nobody will be sent anything.</p><label><input type="checkbox" name="sure" value="1" required> Yes, delete everything</label><button class="btn danger">Delete my account</button></form>
  </details>
</div>`,
  })
}

export type SwitchData = { sw: Switch; recipients: Recipient[]; checkins: Checkin[]; limits: Limits; flash?: string; error?: string; now: number }

export function switchPage(ctx: Ctx, d: SwitchData): string {
  const { sw } = d
  const people = d.recipients
    .map((r) => `<li>${esc(r.name || r.email)} <span class="muted">&lt;${esc(r.email)}&gt;</span>${r.released_at ? ` <span class="muted small">sent ${esc(day(r.released_at))}${r.opened_at ? `, opened ${esc(day(r.opened_at))}` : ''}</span>` : ''}
      ${sw.state === 'fired' ? '' : `<form method="post" action="/s/${esc(sw.id)}/recipients/${esc(r.id)}/delete" class="inline">${csrfField(ctx)}<button class="linkish bad">remove</button></form>`}</li>`)
    .join('')
  return layout({
    ctx,
    noindex: true,
    script: true,
    title: `${sw.name} · deadman.switch`,
    description: 'One switch.',
    path: `/s/${sw.id}`,
    body: `${d.flash ? `<p class="note">${esc(d.flash)}</p>` : ''}${d.error ? `<p class="note error">${esc(d.error)}</p>` : ''}
<p class="small"><a href="/me">‹ My switches</a></p>
<section class="hero left"><h1>${esc(sw.name)}</h1><p>${stateBadge(sw, d.now)}</p>
<p class="muted small">Last check-in ${esc(stamp(sw.last_checkin_at))}.${sw.state === 'armed' ? ` Next due ${esc(stamp(sw.due_at))}.` : ''}</p></section>
${sw.state === 'fired' ? `<div class="card"><p>This switch was sent on ${esc(stamp(sw.fired_at!))}. If you are reading this, tell the people below you are fine.</p>
<form method="post" action="/s/${esc(sw.id)}/rearm">${csrfField(ctx)}<button class="btn">Re-arm it</button></form><p class="muted small">Re-arming starts a fresh period. The links already sent keep working; seal a new bundle if you want them to stop being useful.</p></div>` : `<form method="post" action="/s/${esc(sw.id)}/checkin">${csrfField(ctx)}<button class="btn big">${sw.state === 'paused' ? 'Resume and check in' : "I'm here: check in"}</button></form>`}

<div class="card" id="bundle">
  <h2>The sealed bundle</h2>
  <p class="muted">Written and sealed here, in your browser. We store only the locked result.${sw.bundle ? ` Sealed ${esc(stamp(sw.bundle_at!))}, ${Math.ceil(sw.bundle_bytes / 1024)} KB of ${Math.floor(d.limits.bundleBytes / 1024)} KB.` : ''}</p>
  <noscript><p class="note error">Sealing needs JavaScript: it is how your words stay on your device.</p></noscript>
  <div id="sealer" data-switch="${esc(sw.id)}" data-csrf="${esc(ctx.csrf)}" data-max="${d.limits.bundleBytes}" data-has="${sw.bundle ? '1' : ''}" hidden>
    <script type="application/json" id="sealed-json">${jsonScript(sw.bundle)}</script>
    <div id="unlock"${sw.bundle ? '' : ' hidden'} class="stack">
      <label>Passphrase <input type="password" id="unlock-pass" autocomplete="off"></label>
      <button class="btn ghost" id="unlock-btn" type="button">Unlock to read or change it</button>
      <p class="muted small">Forgot it? You can't open this one, but you can replace it: <button class="linkish" id="start-over" type="button">write a new bundle</button>.</p>
    </div>
    <div id="editor"${sw.bundle ? ' hidden' : ''} class="stack">
      <label>Your note <textarea id="note" rows="12" placeholder="Where the wallets are, how the seed is stored, who to call…"></textarea></label>
      <label>Files (optional) <input type="file" id="files" multiple></label>
      <ul id="file-list" class="small"></ul>
      <label>Hint for them, shown in the clear <input id="hint" maxlength="500" value="${esc(sw.hint)}" placeholder="The passphrase is in the envelope in the fire safe"></label>
      <label>Passphrase <input type="password" id="pass1" autocomplete="new-password" minlength="8"></label>
      <label>Same again <input type="password" id="pass2" autocomplete="new-password" minlength="8"></label>
      <button class="btn" id="seal-btn" type="button">Seal and save</button>
      <p class="muted small">Give the passphrase to the people below yourself. We never see it and can't reset it.</p>
    </div>
    <p id="seal-status" class="small" role="status"></p>
  </div>
</div>

<div class="card" id="people">
  <h2>Who gets it</h2>
  ${people ? `<ul class="people">${people}</ul>` : '<p class="bad">Nobody yet. Add at least one person, or nothing happens when it fires.</p>'}
  ${sw.state !== 'fired' && d.recipients.length < d.limits.recipients ? `<form method="post" action="/s/${esc(sw.id)}/recipients" class="row">${csrfField(ctx)}<input name="name" maxlength="80" placeholder="Name"><input name="email" type="email" required placeholder="email@example.com"><button class="btn ghost">Add</button></form>` : ''}
  <p class="muted small">They hear nothing from us until it fires.</p>
</div>

<div class="card" id="settings">
  <h2>Settings</h2>
  <form method="post" action="/s/${esc(sw.id)}" class="stack">
    ${csrfField(ctx)}
    <label>Name <input name="name" required maxlength="80" value="${esc(sw.name)}"></label>
    <label>Check in ${intervalSelect('interval_days', INTERVALS, sw.interval_days, describeDays)}</label>
    <label>Grace period ${intervalSelect('grace_days', GRACES, sw.grace_days, graceLabel)}</label>
    <button class="btn ghost">Save</button>
  </form>
  ${sw.state === 'armed' ? `<form method="post" action="/s/${esc(sw.id)}/pause">${csrfField(ctx)}<button class="btn ghost">Pause it</button></form>` : ''}
  <details><summary class="bad">Delete this switch</summary><form method="post" action="/s/${esc(sw.id)}/delete">${csrfField(ctx)}<button class="btn danger">Delete it and its bundle</button></form></details>
</div>

<div class="card"><h2>Recent check-ins</h2>${d.checkins.length ? `<ul class="small">${d.checkins.map((c) => `<li>${esc(stamp(c.at))} <span class="muted">via ${esc(c.via)}</span></li>`).join('')}</ul>` : '<p class="muted">None yet.</p>'}</div>`,
  })
}

export function checkinPage(ctx: Ctx, t: string, sw: Switch): string {
  return layout({
    ctx,
    noindex: true,
    title: 'Check in · deadman.switch',
    description: 'Check in.',
    path: '/c',
    body: `<section class="hero"><h1>Still here?</h1><p class="tag">Tap to check in on "${esc(sw.name)}".</p>
<form method="post" action="/c/${esc(t)}"><button class="btn big">I'm here</button></form>
<p class="muted small">One tap, so a mail scanner that opens links can't check in for you.</p></section>`,
  })
}

export function checkedInPage(ctx: Ctx, sw: Switch): string {
  return messagePage(ctx, { title: 'Checked in', message: `Thanks. "${sw.name}" is next due ${stamp(sw.due_at)}.`, link: { href: '/me', label: 'My switches' } })
}

export function releasePage(ctx: Ctx, d: { sw: Switch; owner: User; recipient: Recipient }): string {
  const from = d.owner.name || d.owner.email
  return layout({
    ctx,
    noindex: true,
    script: true,
    title: `From ${from} · deadman.switch`,
    description: 'Something was left for you.',
    path: '/r',
    body: `<section class="hero"><h1>${esc(from)} left this for you</h1>
<p class="tag">They set it up to reach you if they stopped checking in. They last checked in on ${esc(day(d.sw.last_checkin_at))}.</p></section>
<div class="card" id="release">
  <noscript><p class="note error">Opening this needs JavaScript: it opens on your device, never on ours.</p></noscript>
  <script type="application/json" id="sealed-json">${jsonScript(d.sw.bundle)}</script>
  ${d.sw.bundle ? `<div id="opener" class="stack" hidden>
    ${d.sw.hint ? `<p><b>Their hint:</b> ${esc(d.sw.hint)}</p>` : ''}
    <label>The passphrase they gave you <input type="password" id="open-pass" autocomplete="off"></label>
    <button class="btn" id="open-btn" type="button">Open it</button>
    <p id="open-status" class="small" role="status"></p>
  </div>
  <div id="opened" hidden><h2>Their note</h2><pre id="opened-note" class="note-text"></pre><ul id="opened-files"></ul></div>` : '<p>They had not sealed anything yet. We are sorry.</p>'}
  <p class="muted small">We cannot open this and cannot reset the passphrase. Save what is inside somewhere safe: this link is yours alone.</p>
</div>`,
  })
}

export function plansPage(ctx: Ctx, d: { chains: string[]; plan: string; paid: boolean; payments: Payment[]; enabled: boolean; error?: string }): string {
  return layout({
    ctx,
    track: true,
    title: 'Plans · deadman.switch',
    description: 'Free for one switch. Keeper for your whole crypto life.',
    path: '/plans',
    body: `<section class="hero"><h1>Plans</h1>${ctx.user ? `<p class="tag">You are on <b>${esc(d.plan)}</b>.</p>` : ''}</section>
${d.error ? `<p class="note error">${esc(d.error)}</p>` : ''}
${plansTable(ctx)}
${ctx.user ? (d.enabled ? `<div class="card"><h2>Get Keeper</h2>
<form method="post" action="/plans/checkout" class="stack">
  ${csrfField(ctx)}
  <label><input type="radio" name="product" value="year" checked> ${esc(PRODUCTS.year.label)}: ${dollars(PRODUCTS.year.cents)}${d.paid ? ' (adds a year)' : ''}</label>
  <label><input type="radio" name="product" value="lifetime"> ${esc(PRODUCTS.lifetime.label)}: ${dollars(PRODUCTS.lifetime.cents)}</label>
  <label>Pay with <select name="chain">${d.chains.map((c) => `<option value="${esc(c)}">${esc(CHAIN_LABELS[c] ?? c)}</option>`).join('')}</select></label>
  <button class="btn">Pay with CoinPay</button>
</form></div>` : '<p class="note">Payments open soon.</p>') : ''}
${d.payments.length ? `<div class="card"><h2>Your payments</h2><table><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Status</th></tr>${d.payments.map((p) => `<tr><td>${esc(day(p.created_at))}</td><td>${esc(p.product)}</td><td>${dollars(p.amount_cents)} ${esc(p.chain)}</td><td>${esc(p.settled_at ? 'paid' : p.status)}</td></tr>`).join('')}</table></div>` : ''}`,
  })
}
