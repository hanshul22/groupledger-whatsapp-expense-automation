# GroupLedger — WhatsApp Wedding Expense Automation

A WhatsApp bot that turns plain-language messages sent in a group chat
("2000 to caterer for flowers") into structured, approved rows in a Google
Sheet — with an admin approval workflow, undo/edit commands, optional LLM
parsing for messy input, and a durable job queue for production reliability.

Built with [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp
Web protocol), Node.js, and the Google Sheets API.

## How it works

1. Someone posts an expense in the WhatsApp group, e.g. `1500 to florist for centerpieces`.
2. The bot parses it (regex first, optional LLM fallback for ambiguous text) into amount, recipient, date, and description.
3. An optional normalization layer (LLM-based) can clean up messy phrasing before approval — off by default.
4. **If the sender is a current group admin**, the entry is auto-approved instantly.
5. **Otherwise**, the bot posts a single approval request to the group with a short Entry ID. Any admin can approve/reject by:
   - Replying `APPROVE <id>` / `REJECT <id>` — or a natural variant like `done <id>`, `ok <id>`, `theek hai <id>` / `no <id>`, `cancel <id>`, `galat <id>`
   - Replying with just the word itself (`approve`, `done`, `ok`, `theek hai`, ... / `reject`, `no`, `cancel`, ...) directly to the request message
   - Reacting 👍 / ✅ (approve) or 👎 / ❌ (reject) on the request message

   The full accepted word/emoji lists live in `src/approvalEngine.js` (`APPROVE_SYNONYMS`/`REJECT_SYNONYMS`/`APPROVE_EMOJI`/`REJECT_EMOJI`) — matching is case- and whitespace-insensitive.
6. Once resolved, the entry is written to the "Entries" or "Rejected" tab of a Google Sheet, and the group gets a confirmation.

Admins can also `/undo` the last written row or `/edit <row> <field> <value>` an existing one.

## Features

- **Natural-language parsing** — regex-based extraction with `chrono-node` for dates, falling back to an LLM (via OpenRouter) only when the regex pass isn't confident.
- **Admin approval workflow** — first-response-wins locking, live (never cached) admin checks, single-message-per-entry notifications (no DM spam).
- **Google Sheets as the ledger** — idempotent writes, undo/edit support, separate Entries/Rejected tabs.
- **Optional LLM normalization layer** (`NORMALIZER_MODE`) — off / shadow (log-only) / on, with deterministic guardrails so the LLM can never silently corrupt an amount or invent a recipient.
- **Optional durable job queue** (`QUEUE_ENABLED`) — Redis-backed queue with retry, backoff, dead-lettering, and crash-safe idempotent processing, for zero message loss on restarts/crashes. See [RUNBOOK.md](./RUNBOOK.md) for full operational details.
- **Resilience** — automatic WhatsApp reconnect with exponential backoff, offline/recovery alerts to a fallback number, `/health` and `/keepalive` HTTP endpoints, pm2 process management with auto-restart.
- **Audit trail** — every decision and command is logged to `data/audit.log`.

## Requirements

- Node.js **>= 20**
- A dedicated WhatsApp number to link as the bot (Baileys uses the WhatsApp Web "linked device" protocol — this number will be logged out of other linked-device sessions if reused elsewhere)
- A Google Cloud project with the Sheets API enabled and a Service Account
- (Optional) An [OpenRouter](https://openrouter.ai/keys) API key, only needed if you want LLM-assisted parsing/normalization
- (Optional) A Redis instance (e.g. [Upstash](https://upstash.com/) free tier), only needed for the durable queue, Redis-backed auth state, or Redis-backed pending-approval storage

## Setup

### 1. Install dependencies

```powershell
npm install
```

`package-lock.json` is committed, so installs are pinned/reproducible — Render's build (`npm ci`, see `render.yaml`) installs exactly what's in the lockfile rather than re-resolving transitive versions on every deploy.

### 2. Create your Google Sheet + Service Account

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Sheets API**.
2. Create a **Service Account**, then generate and download its JSON key.
3. Create a Google Sheet with `Entries` and `Rejected` tabs (headers matching the fields the bot writes: date, description, amount, given_to, party, entry_id, status, approved_by, etc.).
4. Share that Sheet with the service account's email (found in the JSON key's `client_email` field) as **Editor**.
5. Copy the Sheet ID from its URL: `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`.

### 3. Configure environment variables

Copy the example file and fill in the values:

```powershell
Copy-Item .env.example .env
```

Then edit `.env`. Every variable is documented inline in `.env.example`; the essentials to get running are:

| Variable | Required | Purpose |
|---|---|---|
| `WHATSAPP_GROUP_ID` | Yes (leave empty on first run) | Target group's WhatsApp JID. Logged to the console on startup — send a message in the group, copy the ID, paste it in, restart. |
| `PORT` | No (default `3000`) | Port for the `/health` and `/keepalive` HTTP endpoints. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Yes | From the service account JSON key's `client_email`. |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Yes | From the JSON key's `private_key`, with `\n` sequences kept literal. |
| `GOOGLE_SHEET_ID` | Yes | The target spreadsheet's ID. |
| `LLM_API_KEY` | No | OpenRouter key, used only as a fallback when regex parsing isn't confident. |
| `BOT_ADMIN_FALLBACK_NUMBER` | No | WhatsApp JID for critical offline/recovery alerts only. |
| `REDIS_URL` | No | Enables Redis-backed auth state / durable queue / Redis pending-store, depending on other flags below. |
| `NORMALIZER_MODE` | No (default `off`) | `off` \| `shadow` \| `on` — optional LLM cleanup layer. |
| `QUEUE_ENABLED` | No (default `false`) | Enables the durable Redis-backed job queue. |
| `STATE_STORE` | No (default `file`) | `file` \| `redis` — where pending approvals are stored. |

See `.env.example` for the complete list (normalizer tuning, queue tuning, alert thresholds, etc.) — every setting has an inline comment explaining its default and effect.

### 4. Run it

```powershell
npm start
```

On first run, a QR code prints in the terminal. Scan it from the bot's WhatsApp number: **Linked Devices → Link a Device**. Session credentials are then persisted to `./auth` (or Redis, if `REDIS_URL` is set) so you won't need to re-scan on restart — unless you get logged out, in which case delete `./auth` (or clear the Redis keys) and re-scan.

If `WHATSAPP_GROUP_ID` was left empty, incoming chat IDs are logged to the console — send a message in your target group, copy its ID from the logs, paste it into `.env`, and restart.

### 5. Run in production (optional, self-hosted)

A [pm2](https://pm2.keymetrics.io/) config is included for process supervision (auto-restart on crash):

```powershell
npm install -g pm2
pm2 start ecosystem.config.js
```

## Deploying to Render

Render's free-tier web services have no persistent disk and spin down
after ~15 minutes with no inbound HTTP traffic (a "cold start" on the next
request) — see `doc/architecture.md` §2a for the full design rationale.
`render.yaml` in this repo defines a single **`groupledger`** (`type: web`)
service for the bot itself.

**Keeping it awake:** Render's Cron Job service type is not available on
the free workspace plan (confirmed against the dashboard — cron jobs are
billed per-second with a $1/month minimum, with no free option). So the
keepalive ping has to come from an external scheduler instead — any of
these work, all free, no card required:

- [cron-job.org](https://cron-job.org) — a free scheduled HTTP pinger.
- [UptimeRobot](https://uptimerobot.com) — same idea, plus uptime alerting.
- A scheduled GitHub Actions workflow in this (or any) repo that just
  `curl`s the URL.

Point whichever one you pick at `https://<your-service>.onrender.com/keepalive`
on a ~10 minute interval — comfortably under the 15-minute spin-down
window. `/keepalive` tracks and returns how many pings it's received and
when the last one landed (`pingCount`/`lastPingAt`), so you can confirm
from the response body that the external pinger is actually reaching it.

### Steps

1. Push this repo to GitHub/GitLab (`auth/`, `data/`, and `.env` are
   gitignored already — never commit real credentials or session state).
2. In the Render dashboard: **New +** → **Blueprint**, then point it at
   your repo. Render detects `render.yaml` and provisions the service.
3. During Blueprint setup, Render prompts you for every `sync: false`
   variable: `WHATSAPP_GROUP_ID` (can stay empty for now),
   `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`,
   `GOOGLE_SHEET_ID`, and optionally `LLM_API_KEY`,
   `BOT_ADMIN_FALLBACK_NUMBER`, `REDIS_URL`, and the normalizer vars
   (`NORMALIZER_MODE`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`,
   `OPENROUTER_FALLBACK_MODEL`) if you want LLM-based cleanup live in
   production too. Fill these in from your own `.env`.
4. Deploy. Open `https://<your-service>.onrender.com/qr` in a browser and
   scan the QR image shown there from the bot's WhatsApp number (**Linked
   Devices → Link a Device**). Use this instead of the Logs tab — Render's
   web log viewer prefixes every line with a timestamp, which breaks the
   terminal QR code's grid alignment and makes it unscannable even though
   it prints "correctly." The code rotates every ~20s until scanned, so
   refresh the page if it goes stale. Since Render's free web services
   have no persistent disk, set `REDIS_URL` (e.g. an
   [Upstash](https://upstash.com/) free-tier instance) beforehand so the
   session survives restarts/redeploys instead of needing a fresh QR scan
   every time — see `.env.example`'s `REDIS_URL` comment.
5. Once live, copy the service's public URL (e.g.
   `https://groupledger.onrender.com`) and set up your external pinger
   (see above) against `<that URL>/keepalive`.
6. Send a message in your target WhatsApp group, copy the group JID
   Render logs to the console, set it as `WHATSAPP_GROUP_ID` in the
   `groupledger` service's Environment tab, and it'll pick it up on the
   next restart.

### Verifying the keepalive is working

- Visit `https://<your-service>.onrender.com/keepalive` in a browser —
  you should get back `{"status":"OK","pingCount":N,"lastPingAt":"...","uptimeSeconds":...}`.
  `pingCount` going up and `lastPingAt` staying recent (within the last
  ~10 minutes) means the external pinger is reaching the service.
- Most external pinger dashboards (cron-job.org, UptimeRobot) show their
  own run history/response codes too — useful cross-check if `pingCount`
  ever stalls.
- `GET /health` includes the same `keepalive` stats alongside queue
  status, if you've enabled `QUEUE_ENABLED` — see
  [RUNBOOK.md](./RUNBOOK.md) §6.

### Migrating off Render later

The codebase is host-agnostic (env-var driven, no hardcoded Render paths),
so moving to an always-on host (e.g. an Oracle Cloud "Always Free" VM) is
a redeploy, not a rewrite — see `doc/architecture.md` §2a. On a host with
a persistent disk, you can drop `REDIS_URL` entirely and go back to local
`./auth`, and the external keepalive pinger becomes unnecessary (an
always-on host never spins down).

## Project structure

```
src/
  index.js                  Entry point — wiring, HTTP server, startup/shutdown
  waConnector.js             Baileys connection, QR auth, reconnect logic
  authState.js                Redis-backed auth state (alternative to local ./auth)
  messagePipeline.js         Shared message-handling flow (direct + queued paths)
  parser.js                   Regex + LLM-fallback expense parsing
  normalizer.js                Optional LLM cleanup layer (off by default)
  approvalEngine.js            Auto-approval / pending / approve-reject logic
  decisionProcessor.js        APPROVE/REJECT handling, first-response-wins locking
  pendingStore.js              File-backed pending-approval storage
  redisPendingStore.js        Redis-backed pending-approval storage
  commands.js                  /undo, /edit, /queue, /queue retry
  sheetsWriter.js               Google Sheets read/write, idempotent writes
  notifier.js                   Group approval-request notifications
  responder.js                   Outcome/confirmation messages
  connectionMonitor.js         Offline/recovery alerting
  reconnectBackoff.js          Exponential backoff for reconnects
  entryId.js                    Short unique Entry ID generation
  pushNameCache.js              Caches sender display names
  schema.js                     Expense entry validation schema
  queue/                         Durable Redis-backed job queue (opt-in)
tests/                           Unit/integration tests (node:test)
data/                             Runtime state — pending-store.json, audit.log (gitignored)
auth/                             Baileys session credentials (gitignored)
ecosystem.config.js              pm2 process configuration
render.yaml                      Render Blueprint (web service — keepalive needs an external pinger, see "Deploying to Render")
RUNBOOK.md                       Operational guide for the job queue + normalizer
```

## Testing

```powershell
npm test
```

Runs the test suite with Node's built-in `node:test` runner (property-based tests via `fast-check` are included for some modules).

## Operations

For day-to-day operation of the durable queue and LLM normalizer — reading `/queue` output, handling alerts, diagnosing dead-lettered jobs, checking `/health`, turning features off — see **[RUNBOOK.md](./RUNBOOK.md)**.

## Security notes

- `.env`, `auth/`, and `data/` are gitignored — never commit real credentials, session state, or logs.
- The bot only ever sends alerts to `BOT_ADMIN_FALLBACK_NUMBER`, never ledger data, to keep sensitive expense info out of alert channels.
- `/queue` output intentionally never includes message content — only counts.
- Admin checks (`/undo`, `/edit`, approvals) are always live-checked against current WhatsApp group membership, never cached or hardcoded.
