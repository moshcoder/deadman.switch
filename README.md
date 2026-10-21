# deadman.switch

A dead man's switch for your crypto. Write down where the wallets, seeds and
logins are, seal it with a passphrase only your family knows, and check in now
and then. If you stop checking in, the people you chose get the sealed bundle.

- Web: <https://deadman.switch.pit.world> (on Moshpit DNS: <https://deadman.switch>)
- CLI and TUI: `bunx deadmanswitch`
- MCP: `claude mcp add deadman -- bunx deadmanswitch mcp`
- API: `https://deadman.switch.pit.world/api/v1` (`Authorization: Bearer ds_…`)

## How it works

1. **Seal.** The bundle (a note plus files) is encrypted on your device:
   PBKDF2-SHA256 (600,000 rounds) into AES-256-GCM. The server stores only the
   ciphertext. You give the passphrase to your heir yourself.
2. **Check in.** Every 1 to 365 days. The email link, the push notification's
   "I'm OK" button, the web, the CLI, the API or MCP all restart the clock.
3. **Reminders.** A missed check-in gets three reminders across the grace
   period (1 to 30 days), by email and push, and on paid plans a phone call on
   the last one. Reminders are at least 12 hours apart.
4. **Release.** Only after the grace period, and at least a day after the last
   reminder (so an outage can never skip the warnings), each recipient gets
   their own link. The page shows your hint, asks for the passphrase, and opens
   the bundle in their browser.

The server cannot read a bundle, and nobody can open one before it fires.

## Plans

| | Free | Keeper ($49/year or $149 for life) |
| --- | --- | --- |
| Switches | 1 | 10 |
| People per switch | 2 | 10 |
| Sealed bundle | 64 KB | 5 MB |
| Reminders | email, push | email, push, phone call |

Paid in crypto through [CoinPay](https://coinpayportal.com). A lapsed plan never
switches protection off: existing switches keep running on the free channels.

## CLI

```sh
deadman login ds_…                     # key from /me#account
deadman status
deadman checkin
deadman new "My crypto" --every=30 --grace=7 --to=kid@example.com
deadman seal "My crypto" note.md seed-card.png --hint="first dog, then the year"
deadman read "My crypto"
deadman open https://deadman.switch.pit.world/r/r_…
```

## Running it

Bun + Hono + Postgres (`DATABASE_URL`). Tables are made on boot.

```sh
bun install
DATABASE_URL=postgres://… DEADMAN_SECRET=$(openssl rand -hex 32) bun src/server.ts
```

| Variable | |
| --- | --- |
| `DATABASE_URL` | Postgres |
| `DEADMAN_SECRET` | 32+ characters; signs check-in links and CSRF tokens |
| `RESEND_API_KEY`, `MAIL_FROM` | email (without a key, mail goes to the log) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | web push (`bunx web-push generate-vapid-keys`) |
| `COINPAY_API_KEY`, `COINPAY_BUSINESS_ID`, `COINPAY_WEBHOOK_SECRET` | payments |
| `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_FROM`, `TELNYX_PUBLIC_KEY` | phone calls |
| `ADMIN_EMAILS` | accounts that get Keeper free |
| `PORT` (8801), `WORKER=off` | |

Tests: `TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55491/postgres bun test`
(see `test/app.test.ts` for a one-line docker Postgres).

Deploy: `bin/install.sh` on the box (OpenInstall), settings in `bin/install.conf`.

MIT. By [Profullstack, Inc.](https://profullstack.com)
