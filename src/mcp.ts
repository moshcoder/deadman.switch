/**
 * `deadman mcp`: deadman.switch for an agent, on stdio.
 *
 *   claude mcp add deadman -- bunx @profullstack/deadman mcp
 *
 * Needs DEADMAN_KEY (or `deadman login`). Sealing stays in the CLI and the
 * browser on purpose: an agent never handles the passphrase or the plaintext.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { DeadmanClient } from './client.js'
import { VERSION } from './version.js'

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] })
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try {
    return text(await fn(a))
  } catch (e) {
    return failure(e)
  }
}
const sw = z.string().min(1).describe('A switch id or its exact name')

export function createMcpServer(client = new DeadmanClient()): McpServer {
  const server: any = new McpServer({ name: 'deadman.switch', version: VERSION })
  server.tool('status', 'Your plan and every switch: when each is due, whether it is sealed, who gets it.', {}, wrap(() => client.me()))
  server.tool(
    'check_in',
    "Check in (\"I'm alive\") on every armed switch, or one. Only do this when the person has just told you they are fine: checking in for someone who is not there defeats the switch.",
    { switch: sw.optional() },
    wrap(async ({ switch: s }: { switch?: string }) => client.checkin('mcp', s ? (await client.find(s)).id : undefined)),
  )
  server.tool(
    'create_switch',
    'Make a switch. interval_days: 1, 3, 7, 14, 30, 60, 90, 180 or 365. grace_days: 1, 2, 3, 7, 14 or 30. The owner then seals the bundle in the browser or with `deadman seal`.',
    { name: z.string().min(1).max(80), interval_days: z.number().int().optional(), grace_days: z.number().int().optional(), recipients: z.array(z.object({ email: z.string().email(), name: z.string().max(80).optional() })).optional() },
    wrap((input: any) => client.create(input)),
  )
  server.tool(
    'update_switch',
    'Rename a switch or change how often it asks and how long the grace period is.',
    { switch: sw, name: z.string().min(1).max(80).optional(), interval_days: z.number().int().optional(), grace_days: z.number().int().optional() },
    wrap(async ({ switch: s, ...rest }: any) => client.update((await client.find(s)).id, rest)),
  )
  server.tool('add_recipient', 'Add someone who gets the sealed bundle if the switch fires. They hear nothing until then.', { switch: sw, email: z.string().email(), name: z.string().max(80).optional() }, wrap(async ({ switch: s, email, name }: any) => client.addRecipient((await client.find(s)).id, email, name ?? '')))
  server.tool(
    'remove_recipient',
    'Take someone off a switch.',
    { switch: sw, email: z.string().email() },
    wrap(async ({ switch: s, email }: any) => {
      const found = await client.find(s)
      const r = found.recipients.find((p) => p.email === email.toLowerCase())
      if (!r) throw new Error(`${email} is not on "${found.name}"`)
      return client.removeRecipient(found.id, r.id)
    }),
  )
  server.tool('pause', 'Pause a switch (nothing is sent while paused).', { switch: sw }, wrap(async ({ switch: s }: any) => client.pause((await client.find(s)).id)))
  server.tool('resume', 'Resume a paused switch; a fresh period starts now.', { switch: sw }, wrap(async ({ switch: s }: any) => client.resume((await client.find(s)).id)))
  server.tool('redeem_code', 'Redeem a credit code the person was given (CR-XXXX-XXXX-XXXX-XXXX): days of the Keeper plan, added to their account.', { code: z.string().min(4).max(64) }, wrap(({ code }: { code: string }) => client.redeem(code)))
  server.tool('list_invites', "The person's invite links (three each; when someone new joins through one, both get a week of Keeper) and their open ?ref= link.", {}, wrap(() => client.invites()))
  server.tool('create_invite', 'Make one single-use invite link (shown once). note is a private reminder of who it is for.', { note: z.string().max(80).optional() }, wrap(({ note }: { note?: string }) => client.newInvite(note ?? '')))
  return server
}

export async function runMcp(client = new DeadmanClient()): Promise<void> {
  await createMcpServer(client).connect(new StdioServerTransport())
}
