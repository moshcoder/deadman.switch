/**
 * How we reach people: email (Resend) for everyone, web push to every device
 * that turned it on, and on paid plans a phone call (Telnyx Call Control) on
 * the last reminder that says "press 1 to check in".
 *
 * Every channel is best effort and independent: one failing never stops the
 * others, and the worker counts a reminder as sent once it has tried them all.
 * Without RESEND_API_KEY mail is written to the log, which is what tests and a
 * local `deadman serve` want.
 */
import webpush from 'web-push'
import type { Store, User } from './db.js'

export type Mail = { to: string; subject: string; text: string; html?: string; replyTo?: string }
export type Notifier = {
  mail(m: Mail): Promise<boolean>
  push(user: User, payload: { title: string; body: string; url: string; checkin?: string }): Promise<number>
  call(phone: string, switchId: string): Promise<boolean>
  readonly callsEnabled: boolean
  readonly vapidPublic: string
}

export type NotifyConfig = {
  resendKey?: string
  mailFrom: string
  vapidPublic?: string
  vapidPrivate?: string
  vapidSubject: string
  telnyxKey?: string
  telnyxConnection?: string
  telnyxFrom?: string
  /** Where Telnyx sends call events: a public URL (the relay, never the Moshpit name). */
  callHook: string
}

export function notifyConfig(env: Record<string, string | undefined> = process.env, publicOrigin: string): NotifyConfig {
  return {
    resendKey: env.RESEND_API_KEY,
    mailFrom: env.MAIL_FROM ?? 'deadman.switch <switch@pit.world>',
    vapidPublic: env.VAPID_PUBLIC_KEY,
    vapidPrivate: env.VAPID_PRIVATE_KEY,
    vapidSubject: env.VAPID_SUBJECT ?? 'mailto:switch@pit.world',
    telnyxKey: env.TELNYX_API_KEY,
    telnyxConnection: env.TELNYX_CONNECTION_ID,
    telnyxFrom: env.TELNYX_FROM,
    callHook: `${publicOrigin}/hooks/telnyx`,
  }
}

export function createNotifier(cfg: NotifyConfig, store: Store, fetcher: typeof fetch = fetch, log: (line: string) => void = console.log): Notifier {
  const pushOn = Boolean(cfg.vapidPublic && cfg.vapidPrivate)
  if (pushOn) webpush.setVapidDetails(cfg.vapidSubject, cfg.vapidPublic!, cfg.vapidPrivate!)
  const callsEnabled = Boolean(cfg.telnyxKey && cfg.telnyxConnection && cfg.telnyxFrom)

  return {
    callsEnabled,
    vapidPublic: cfg.vapidPublic ?? '',

    async mail(m) {
      if (!cfg.resendKey) {
        log(`[mail] to=${m.to} subject=${JSON.stringify(m.subject)}\n${m.text}`)
        return true
      }
      try {
        const res = await fetcher('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.resendKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: cfg.mailFrom, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
          signal: AbortSignal.timeout(15_000),
        })
        if (!res.ok) log(`[mail] resend ${res.status} for ${m.to}: ${(await res.text()).slice(0, 200)}`)
        return res.ok
      } catch (e) {
        log(`[mail] failed for ${m.to}: ${e instanceof Error ? e.message : e}`)
        return false
      }
    },

    async push(user, payload) {
      if (!pushOn) return 0
      let sent = 0
      for (const sub of await store.pushSubs(user.id)) {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 86_400, urgency: 'high' })
          sent += 1
        } catch (e: any) {
          // 404/410: the browser dropped the subscription; forget it.
          if (e?.statusCode === 404 || e?.statusCode === 410) await store.dropPush(sub.endpoint)
          else log(`[push] ${e?.statusCode ?? ''} ${e?.message ?? e}`)
        }
      }
      return sent
    },

    async call(phone, switchId) {
      if (!callsEnabled || !/^\+[1-9]\d{7,14}$/.test(phone)) return false
      try {
        const res = await fetcher('https://api.telnyx.com/v2/calls', {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.telnyxKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ connection_id: cfg.telnyxConnection, to: phone, from: cfg.telnyxFrom, webhook_url: cfg.callHook, timeout_secs: 45 }),
          signal: AbortSignal.timeout(15_000),
        })
        const body = (await res.json().catch(() => ({}))) as any
        const callId = body?.data?.call_control_id
        if (!res.ok || !callId) {
          log(`[call] telnyx ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
          return false
        }
        await store.recordCall(callId, switchId)
        return true
      } catch (e) {
        log(`[call] failed: ${e instanceof Error ? e.message : e}`)
        return false
      }
    },
  }
}

/** Telnyx Call Control: answer -> speak and gather one digit -> 1 checks in. */
export async function telnyxCommand(cfg: NotifyConfig, callId: string, command: 'gather_using_speak' | 'speak' | 'hangup', body: object, fetcher: typeof fetch = fetch): Promise<void> {
  await fetcher(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callId)}/actions/${command}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.telnyxKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {})
}
