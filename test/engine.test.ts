import { describe, expect, test } from 'bun:test'
import { DAY, decide, fireAt, reminderAt, type SwitchClock } from '../src/engine.ts'

const due = new Date('2026-01-10T00:00:00Z')
const sw = (o: Partial<SwitchClock> = {}): SwitchClock => ({ state: 'armed', due_at: due, grace_days: 9, reminders_sent: 0, last_reminder_at: null, ...o })

describe('decide', () => {
  test('nothing before the deadline', () => {
    expect(decide(sw(), due.getTime() - 1)).toEqual({ kind: 'none' })
  })
  test('paused and fired switches never act', () => {
    expect(decide(sw({ state: 'paused' }), due.getTime() + 100 * DAY).kind).toBe('none')
    expect(decide(sw({ state: 'fired' }), due.getTime() + 100 * DAY).kind).toBe('none')
  })
  test('three reminders spread across the grace period, the last marked', () => {
    expect(decide(sw(), due.getTime())).toEqual({ kind: 'remind', n: 1, last: false })
    expect(decide(sw({ reminders_sent: 1 }), due.getTime() + 2 * DAY).kind).toBe('none')
    expect(decide(sw({ reminders_sent: 1 }), reminderAt(sw(), 2))).toEqual({ kind: 'remind', n: 2, last: false })
    expect(decide(sw({ reminders_sent: 2 }), reminderAt(sw(), 3))).toEqual({ kind: 'remind', n: 3, last: true })
  })
  test('fires only after the grace period, with three reminders sent', () => {
    const last = new Date(reminderAt(sw(), 3))
    const s = sw({ reminders_sent: 3, last_reminder_at: last })
    expect(decide(s, due.getTime() + 9 * DAY - 1).kind).toBe('none')
    expect(decide(s, due.getTime() + 9 * DAY).kind).toBe('fire')
  })
  test('after an outage: a day of warning after the last reminder, however late', () => {
    const late = due.getTime() + 40 * DAY
    // The server comes back long after the grace period: it reminds first...
    expect(decide(sw(), late)).toEqual({ kind: 'remind', n: 1, last: false })
    // ...and having just sent the last reminder, waits a full day before firing.
    // ...the next one no sooner than 12 hours later...
    const one = sw({ reminders_sent: 1, last_reminder_at: new Date(late) })
    expect(decide(one, late + 60_000).kind).toBe('none')
    expect(decide(one, late + 12 * 3_600_000)).toEqual({ kind: 'remind', n: 2, last: false })
    const s = sw({ reminders_sent: 3, last_reminder_at: new Date(late) })
    expect(fireAt(s)).toBe(late + DAY)
    expect(decide(s, late + DAY - 1).kind).toBe('none')
    expect(decide(s, late + DAY).kind).toBe('fire')
  })
})
