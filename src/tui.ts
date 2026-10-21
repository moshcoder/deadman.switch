/**
 * `deadman` with no arguments: your switches, and one key to check in.
 *
 * ↑/↓ picks a switch, Enter (or c) checks in on it, a checks in on all,
 * p pauses or resumes, r reloads, q quits.
 */
import { createApp } from '@profullstack/hqtui'
import { DeadmanClient, dueText, type ApiMe } from './client.js'

export type TuiState = { me: ApiMe | null; at: number; busy: boolean; message: string; error: string | null }
export const initialState = (): TuiState => ({ me: null, at: 0, busy: false, message: '', error: null })

/** Pure key handling, testable without a terminal. */
export function onKey(s: TuiState, key: { name: string; key: string; char?: string }): 'quit' | 'checkin' | 'checkin-all' | 'toggle' | 'reload' | null {
  const n = s.me?.switches.length ?? 0
  if (key.key === 'ctrl+c' || key.name === 'escape' || key.char === 'q') return 'quit'
  if (key.name === 'down' || key.char === 'j') return n && (s.at = (s.at + 1) % n), null
  if (key.name === 'up' || key.char === 'k') return n && (s.at = (s.at + n - 1) % n), null
  if (key.name === 'enter' || key.char === 'c') return n ? 'checkin' : null
  if (key.char === 'a') return 'checkin-all'
  if (key.char === 'p') return n ? 'toggle' : null
  if (key.char === 'r') return 'reload'
  return null
}

export async function runTui(client = new DeadmanClient()): Promise<void> {
  const s = initialState()
  const app = await createApp({ title: 'deadman.switch', quitKeys: [] })
  const run = async (label: string, fn: () => Promise<unknown>) => {
    s.busy = true
    s.error = null
    app.invalidate()
    try {
      await fn()
      s.me = await client.me()
      s.message = label
    } catch (e) {
      s.error = e instanceof Error ? e.message : String(e)
    } finally {
      s.busy = false
      app.invalidate()
    }
  }
  void run('', async () => {})
  app.on('key', (event: any) => {
    const action = onKey(s, event)
    const cur = s.me?.switches[s.at]
    if (action === 'quit') app.quit()
    else if (action === 'checkin' && cur) void run(`Checked in on ${cur.name}.`, () => client.checkin('tui', cur.id))
    else if (action === 'checkin-all') void run('Checked in on everything armed.', () => client.checkin('tui'))
    else if (action === 'toggle' && cur) void run(cur.state === 'paused' ? `Resumed ${cur.name}.` : `Paused ${cur.name}.`, () => (cur.state === 'paused' ? client.resume(cur.id) : client.pause(cur.id)))
    else if (action === 'reload') void run('Reloaded.', async () => {})
    app.invalidate()
  })
  app.render(({ ui, theme }: any) => {
    ui.row({ size: 1 }, (h: any) => {
      h.text(' deadman.switch', { fg: theme.accent, bold: true, size: 16 })
      h.text(s.me ? `${s.me.email} · ${s.me.plan}` : 'loading…', { fg: theme.muted })
      h.text(`${client.base.replace(/^https?:\/\//, '')} `, { fg: theme.muted, align: 'right' })
    })
    ui.panel({ title: 'Switches' }, (p: any) => {
      if (s.error) p.text(s.error, { fg: theme.danger ?? theme.accent })
      const list = s.me?.switches ?? []
      if (s.me && !list.length) p.text('No switches yet. Make one at deadman.switch.pit.world/me or: deadman new "My crypto"', { fg: theme.muted })
      list.forEach((sw, i) => {
        const overdue = sw.state === 'armed' && new Date(sw.due_at).getTime() < Date.now()
        p.text(`${i === s.at ? '›' : ' '} ${sw.name.padEnd(24)} ${dueText(sw).padEnd(30)} ${sw.recipients.length} people  ${sw.sealed ? 'sealed' : 'NOT SEALED'}`, {
          fg: i === s.at ? theme.accent : overdue || sw.state === 'fired' ? (theme.danger ?? theme.text) : theme.text,
          bold: i === s.at,
        })
      })
      if (s.message) p.text(s.message, { fg: theme.muted })
    })
    ui.statusBar({ items: [{ key: 'Enter', label: 'check in' }, { key: 'a', label: 'all' }, { key: 'p', label: 'pause/resume' }, { key: 'r', label: 'reload' }, { key: 'q', label: 'quit' }], right: [{ label: s.busy ? 'working…' : 'sealed in your browser' }] })
  })
  await app.start()
}
