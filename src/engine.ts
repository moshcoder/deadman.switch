/**
 * When a switch reminds and when it fires. Pure: the clock and the switch go
 * in, a decision comes out, so the rules are tested without a database.
 *
 * Missing a check-in never fires a switch at once. Once it is due we remind
 * three times across the grace period (the third by phone too, on paid
 * plans), and we fire only when the grace period is over AND a full day has
 * passed since the last reminder. That second rule matters after an outage:
 * a server that was down for a week sends the reminders it owes, then still
 * waits a day before it gives anything away.
 */
export const DAY = 86_400_000
export const REMINDERS = 3
export const LAST_WORD_MS = DAY

export type SwitchClock = {
  state: 'armed' | 'paused' | 'fired'
  due_at: Date
  grace_days: number
  reminders_sent: number
  last_reminder_at: Date | null
}

export type Decision = { kind: 'none' } | { kind: 'remind'; n: number; last: boolean } | { kind: 'fire' }

/** When reminder n (1-based) is due: at the deadline, then a third and two thirds into the grace period. */
export function reminderAt(sw: Pick<SwitchClock, 'due_at' | 'grace_days'>, n: number): number {
  return sw.due_at.getTime() + Math.floor(((n - 1) * sw.grace_days * DAY) / REMINDERS)
}

/** Reminders never bunch up (after an outage, say): at least this long apart, at most 12 hours. */
export const spacing = (sw: Pick<SwitchClock, 'grace_days'>) => Math.min(12 * 3_600_000, Math.floor((sw.grace_days * DAY) / REMINDERS))

const nextReminderAt = (sw: SwitchClock, n: number) => Math.max(reminderAt(sw, n), sw.last_reminder_at ? sw.last_reminder_at.getTime() + spacing(sw) : 0)

export function fireAt(sw: SwitchClock): number {
  const end = sw.due_at.getTime() + sw.grace_days * DAY
  return sw.last_reminder_at ? Math.max(end, sw.last_reminder_at.getTime() + LAST_WORD_MS) : end
}

export function decide(sw: SwitchClock, now: number): Decision {
  if (sw.state !== 'armed' || now < sw.due_at.getTime()) return { kind: 'none' }
  if (sw.reminders_sent < REMINDERS) {
    const n = sw.reminders_sent + 1
    return now >= nextReminderAt(sw, n) ? { kind: 'remind', n, last: n === REMINDERS } : { kind: 'none' }
  }
  return now >= fireAt(sw) ? { kind: 'fire' } : { kind: 'none' }
}

export const INTERVALS = [1, 3, 7, 14, 30, 60, 90, 180, 365] as const
export const GRACES = [1, 2, 3, 7, 14, 30] as const

export function describeDays(days: number): string {
  if (days === 1) return 'every day'
  if (days === 7) return 'every week'
  if (days === 14) return 'every two weeks'
  if (days === 30) return 'every month'
  if (days === 90) return 'every three months'
  if (days === 180) return 'every six months'
  if (days === 365) return 'every year'
  return `every ${days} days`
}
