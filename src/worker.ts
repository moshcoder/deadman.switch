/**
 * The worker: once a minute, every overdue switch gets the next thing the
 * engine says it is owed (a reminder, or the release), and paid plans near
 * their end get one renewal note. It runs inside the web process; a second
 * copy is harmless because every step is a compare-and-set in the store.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Store, Switch, User } from './db.js'
import { decide, fireAt } from './engine.js'
import type { Notifier } from './notify.js'
import { isPaid, type PlanConfig } from './plans.js'

export type WorkerDeps = { store: Store; notifier: Notifier; plans: PlanConfig; key: string; origin: string; log?: (line: string) => void }

/** A one-tap check-in link for the current period. It stops working once you check in (the deadline moves). */
export function checkinToken(key: string, sw: Pick<Switch, 'id' | 'due_at'>): string {
  const mac = createHmac('sha256', key).update(`checkin:${sw.id}:${sw.due_at.getTime()}`).digest('base64url').slice(0, 22)
  return `${sw.id}.${mac}`
}

export async function switchForCheckinToken(store: Store, key: string, t: string): Promise<Switch | null> {
  const [switchId] = t.split('.')
  if (!switchId) return null
  const sw = await store.switchById(switchId)
  if (!sw) return null
  const expected = Buffer.from(checkinToken(key, sw))
  const given = Buffer.from(t)
  return expected.length === given.length && timingSafeEqual(expected, given) ? sw : null
}

const when = (d: Date | number) => new Date(d).toUTCString().replace(/:\d\d GMT$/, ' UTC')
const who = (u: User) => u.name || u.email

export async function tick(deps: WorkerDeps, now = Date.now()): Promise<{ reminded: number; fired: number }> {
  const { store, log = console.log } = deps
  let reminded = 0
  let fired = 0
  for (const sw of await store.overdue()) {
    const d = decide(sw, now)
    try {
      if (d.kind === 'remind' && (await store.claimReminder(sw))) {
        await remind(deps, sw, d.n, d.last, now)
        reminded += 1
      } else if (d.kind === 'fire' && (await store.claimFire(sw))) {
        await fire(deps, sw)
        fired += 1
      }
    } catch (e) {
      log(`[worker] ${sw.id}: ${e instanceof Error ? e.message : e}`)
    }
  }
  await renewals(deps)
  return { reminded, fired }
}

async function remind(deps: WorkerDeps, sw: Switch, n: number, last: boolean, now: number): Promise<void> {
  const owner = await deps.store.user(sw.user_id)
  if (!owner) return
  const link = `${deps.origin}/c/${checkinToken(deps.key, sw)}`
  const recipients = await deps.store.recipients(sw.id)
  const names = recipients.map((r) => r.name || r.email).join(', ') || 'nobody yet'
  // The release can come no sooner than a day after this reminder.
  const deadline = when(fireAt({ ...sw, reminders_sent: n, last_reminder_at: new Date(now) }))
  const subject = last ? `Last reminder: check in or "${sw.name}" is sent on ${deadline}` : `Check in: "${sw.name}" is waiting for you (${n} of 3)`
  const text = `Hi ${who(owner)},

It's time to check in on your switch "${sw.name}".

Check in (one tap): ${link}

${last ? `This is the last reminder. If you do not check in by ${deadline}, we send your sealed bundle to: ${names}.` : `If you don't check in, we remind you again, three times in all, and then send your sealed bundle to: ${names}. The earliest that can happen is ${deadline}.`}

Didn't set this up, or want it gone? Sign in at ${deps.origin}/me and pause or delete it.

deadman.switch`
  await deps.notifier.mail({ to: owner.email, subject, text })
  await deps.notifier.push(owner, { title: last ? 'Last reminder: check in' : 'Time to check in', body: `"${sw.name}" is waiting for you.`, url: `/c/${checkinToken(deps.key, sw)}`, checkin: checkinToken(deps.key, sw) })
  if (last && owner.phone && isPaid(deps.plans, owner)) await deps.notifier.call(owner.phone, sw.id)
}

async function fire(deps: WorkerDeps, sw: Switch): Promise<void> {
  const owner = await deps.store.user(sw.user_id)
  if (!owner) return
  const recipients = await deps.store.recipients(sw.id)
  for (const r of recipients) {
    const t = await deps.store.release(r.id)
    await deps.notifier.mail({
      to: r.email,
      replyTo: owner.email,
      subject: `${who(owner)} left something for you`,
      text: `Hi ${r.name || 'there'},

${who(owner)} (${owner.email}) set up deadman.switch to send you this if they stopped checking in. They last checked in on ${when(sw.last_checkin_at)} and have missed every reminder since.

We hope they are fine. If you can, reach them first.

Open what they left you: ${deps.origin}/r/${t}

It is sealed with a passphrase ${who(owner)} chose. They should have given it to you, or told you where to find it.${sw.hint ? `\nTheir hint: ${sw.hint}` : ''}

We cannot open it and we cannot reset the passphrase: only you can.

deadman.switch`,
    })
  }
  await deps.notifier.mail({
    to: owner.email,
    subject: `Your switch "${sw.name}" was sent`,
    text: `Hi ${who(owner)},

You missed every reminder for "${sw.name}", so we sent it to: ${recipients.map((r) => `${r.name || r.email} <${r.email}>`).join(', ') || 'nobody (no recipients were set)'}.

If this is a mistake, tell them now. Sign in at ${deps.origin}/me to re-arm the switch.

deadman.switch`,
  })
}

async function renewals(deps: WorkerDeps): Promise<void> {
  for (const u of await deps.store.renewalsDue(14 * 86_400_000)) {
    await deps.notifier.mail({
      to: u.email,
      subject: 'Your deadman.switch Keeper plan ends soon',
      text: `Hi ${who(u)},

Your Keeper plan ends on ${when(u.plan_until!)}. Your switches keep running either way, but phone-call reminders stop and you can't add more than the free plan holds.

Renew (crypto, via CoinPay): ${deps.origin}/plans

deadman.switch`,
    })
    await deps.store.markRenewalWarned(u.id)
  }
}

export function startWorker(deps: WorkerDeps, everyMs = 60_000): () => void {
  let busy = false
  const run = async () => {
    if (busy) return
    busy = true
    try {
      const r = await tick(deps)
      if (r.reminded || r.fired) deps.log?.(`[worker] reminded ${r.reminded}, fired ${r.fired}`)
    } catch (e) {
      deps.log?.(`[worker] tick failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(run, everyMs)
  timer.unref?.()
  void run()
  return () => clearInterval(timer)
}
