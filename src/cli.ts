/**
 * deadman: deadman.switch from the terminal.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DeadmanClient, dueText, KEY_FILE, type ApiSwitch } from './client.js'
import { open, seal, type Bundle } from './seal.js'
import { VERSION } from './version.js'

export const HELP = `deadman ${VERSION}: a dead man's switch for your crypto (https://deadman.switch.pit.world)

  deadman                            interactive (TUI)
  deadman login <ds_key>             save your API key (make one at /me#account)
  deadman status                     your switches and when each is due
  deadman checkin [switch]           I'm alive: check in on all (or one)
  deadman new <name> [--every=30] [--grace=7] [--to=email,email]
  deadman add <switch> <email> [name]   someone to send it to
  deadman remove <switch> <email>
  deadman seal <switch> <file…> [--hint="…"]
                                     seal a note (the first file, or stdin with -) and
                                     any other files here, then upload the sealed result
  deadman read <switch>              unseal your own bundle here (asks the passphrase)
  deadman open <release link> [--out=dir]
                                     open what someone left you
  deadman pause|resume <switch>
  deadman mcp                        MCP server: claude mcp add deadman -- bunx deadmanswitch mcp
  deadman serve [--port N]           run your own instance (DATABASE_URL, DEADMAN_SECRET)

  --json                             machine-readable output
  DEADMAN_KEY=ds_…  DEADMAN_URL=https://…   (default ${'https://deadman.switch.pit.world'})
  DEADMAN_PASSPHRASE                 skip the passphrase prompt (scripts only)
`

type Out = { log(text: string): void; error(text: string): void }

async function ask(question: string, hidden = true): Promise<string> {
  if (process.env.DEADMAN_PASSPHRASE) return process.env.DEADMAN_PASSPHRASE
  process.stderr.write(question)
  const stdin = process.stdin
  if (!stdin.isTTY) {
    for await (const line of console) return String(line)
    return ''
  }
  return new Promise((resolve) => {
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stderr.write('\n')
          return resolve(value)
        }
        if (ch === '\u0003') process.exit(130)
        if (ch === '\u007f') value = value.slice(0, -1)
        else value += ch
        if (!hidden) process.stderr.write(ch)
      }
    }
    stdin.on('data', onData)
  })
}

const row = (s: ApiSwitch) => `${s.name.padEnd(24)} ${dueText(s).padEnd(28)} every ${s.interval_days}d  ${s.recipients.length} people  ${s.sealed ? 'sealed' : 'NOT SEALED'}  ${s.id}`

export async function main(argv = process.argv.slice(2), out: Out = console, client = new DeadmanClient()): Promise<number> {
  const json = argv.includes('--json')
  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const args = argv.filter((a) => !a.startsWith('--'))
  const [command, ...rest] = args
  const show = (value: unknown, text: string) => out.log(json ? JSON.stringify(value, null, 2) : text)
  try {
    switch (command) {
      case undefined: {
        if (!process.stdout.isTTY) return out.log(HELP), 0
        const { runTui } = await import('./tui.js')
        await runTui(client)
        return 0
      }
      case 'help':
      case '-h':
        out.log(HELP)
        return 0
      case 'version':
        out.log(VERSION)
        return 0
      case 'mcp': {
        const { runMcp } = await import('./mcp.js')
        await runMcp(client)
        return 0
      }
      case 'serve': {
        const i = argv.indexOf('--port')
        const { serve } = await import('./server.js')
        const s = await serve(i >= 0 ? { port: Number(argv[i + 1]) } : {})
        out.log(`deadman.switch listening on http://${s.hostname}:${s.port}`)
        return await new Promise<number>(() => {})
      }
      case 'login': {
        const key = rest[0] ?? (await ask('API key (ds_…): '))
        if (!key.startsWith('ds_')) throw new Error('that is not a deadman.switch key (they start with ds_)')
        const me = await new DeadmanClient(client.base, key).me()
        mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 })
        writeFileSync(KEY_FILE, `${key}\n`, { mode: 0o600 })
        out.log(`Signed in as ${me.email} (${me.plan}). Key saved to ${KEY_FILE}.`)
        return 0
      }
      case 'status':
      case 'ls': {
        const me = await client.me()
        show(me, `${me.email} · ${me.plan}\n${me.switches.map(row).join('\n') || 'no switches yet: deadman new "My crypto"'}`)
        return 0
      }
      case 'checkin':
      case 'alive': {
        const target = rest[0] ? (await client.find(rest.join(' '))).id : undefined
        const done = await client.checkin('cli', target)
        show(done, done.length ? done.map((s) => `checked in: ${s.name}, next due ${s.due_at.slice(0, 16).replace('T', ' ')} UTC`).join('\n') : 'nothing armed to check in on')
        return 0
      }
      case 'new': {
        const to = (flag('to') ?? '').split(',').map((e) => e.trim()).filter(Boolean)
        const s = await client.create({ name: rest.join(' ') || 'My crypto', ...(flag('every') ? { interval_days: Number(flag('every')) } : {}), ...(flag('grace') ? { grace_days: Number(flag('grace')) } : {}), recipients: to.map((email) => ({ email })) })
        show(s, `made: ${row(s)}\nnext: deadman seal "${s.name}" note.md`)
        return 0
      }
      case 'add': {
        const [sw, email, ...name] = rest
        if (!sw || !email) throw new Error('usage: deadman add <switch> <email> [name]')
        const s = await client.addRecipient((await client.find(sw)).id, email, name.join(' '))
        show(s, `${s.name} goes to: ${s.recipients.map((r) => r.email).join(', ')}`)
        return 0
      }
      case 'remove': {
        const [sw, email] = rest
        const s = await client.find(sw ?? '')
        const r = s.recipients.find((p) => p.email === String(email).toLowerCase())
        if (!r) throw new Error(`${email} is not on "${s.name}"`)
        const next = await client.removeRecipient(s.id, r.id)
        show(next, `${next.name} goes to: ${next.recipients.map((p) => p.email).join(', ') || 'nobody'}`)
        return 0
      }
      case 'pause':
      case 'resume': {
        const s = await client.find(rest.join(' '))
        const next = command === 'pause' ? await client.pause(s.id) : await client.resume(s.id)
        show(next, row(next))
        return 0
      }
      case 'seal': {
        const [sw, first, ...more] = rest
        if (!sw || !first) throw new Error('usage: deadman seal <switch> <note file or -> [more files…] [--hint="…"]')
        const s = await client.find(sw)
        const note = first === '-' ? await new Response(Bun.stdin.stream()).text() : readFileSync(first, 'utf8')
        const files = more.map((p) => ({ name: basename(p), type: Bun.file(p).type || 'application/octet-stream', data: readFileSync(p).toString('base64') }))
        const pass = await ask('Passphrase (give it to the people who should open this): ')
        if (!process.env.DEADMAN_PASSPHRASE && pass !== (await ask('Same again: '))) throw new Error('the two passphrases are different')
        const sealed = await seal({ note, files }, pass)
        const r = await client.putBundle(s.id, sealed, flag('hint'))
        show(r, `sealed and uploaded to "${s.name}" (${Math.ceil(r.bytes / 1024)} KB). We cannot read it; give the passphrase to your people.`)
        return 0
      }
      case 'read': {
        const s = await client.get((await client.find(rest.join(' '))).id)
        if (!s.bundle) throw new Error(`"${s.name}" has nothing sealed yet`)
        const b = await open(s.bundle, await ask('Passphrase: '))
        show(b, printBundle(b))
        return 0
      }
      case 'open': {
        const r = await client.release(rest[0] ?? '')
        if (!r.bundle) throw new Error(`${r.from} had not sealed anything`)
        if (!json) out.error(`From ${r.from}, "${r.switch}"${r.hint ? `\nTheir hint: ${r.hint}` : ''}`)
        const b = await open(r.bundle, await ask('Passphrase: '))
        const dir = flag('out')
        if (dir) {
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'note.txt'), b.note)
          for (const f of b.files) writeFileSync(join(dir, basename(f.name)), Buffer.from(f.data, 'base64'))
        }
        show(b, printBundle(b, dir))
        return 0
      }
    }
    out.error(`deadman: unknown command "${command}"\n\n${HELP}`)
    return 2
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function printBundle(b: Bundle, dir?: string): string {
  const files = b.files.map((f) => `  ${f.name} (${Math.ceil((f.data.length * 3) / 4 / 1024)} KB)`).join('\n')
  return `${b.note}\n${b.files.length ? `\nFiles${dir ? ` (saved to ${dir})` : ' (add --out=dir to save them)'}:\n${files}` : ''}`
}
