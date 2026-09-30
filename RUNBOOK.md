# RUNBOOK — Durable Job Queue & Normalizer (v1.2)

This runbook covers day-to-day operation of the v1.2 durable job queue and
its interaction with the v1.1 LLM normalizer. It assumes you're already
familiar with `doc/prd.md` / `doc/trd.md` §9 / `doc/architecture.md` §9 for
the *design*; this document is the *operational* companion — what to do
when something goes wrong, at 2am, without re-reading the design docs.

Everything here only applies when `QUEUE_ENABLED=true`. With it `false`
(the default), there is no queue to check — the bot behaves exactly as
v1.0/v1.1, and none of the commands or alerts below exist.

---

## 1. Quick reference

| I want to... | Do this |
|---|---|
| See how many expenses are waiting | Send `/queue` in the group, as an admin |
| Retry everything that gave up | Send `/queue retry`, as an admin |
| Check queue health from outside WhatsApp | `GET /health` on the bot's HTTP port |
| Turn the whole queue off | Set `QUEUE_ENABLED=false`, restart |
| Fix a blocked OpenRouter key | Fix the key in your host's env vars, restart (or wait — see §4) |
| Fix a blocked Google Sheets credential | Fix the credential/sharing, restart (or wait — see §4) |
| See what actually happened to a specific job | `redis-cli` inspection (§6) |

---

## 2. `/queue` — reading the output

Send `/queue` in the group (you must be a current group admin). Example
reply:

```
Queue status:
queued: 3
inflight: 1
dead: 0
oldest ready job age: 2m
oldest inflight job age: 0m
```

- **queued** — jobs waiting for their turn (either brand new, or waiting
  out a backoff/blocked-retry delay). Normal to see a small number
  briefly after a burst of messages.
- **inflight** — jobs currently being processed (claimed, lease active).
  Should track `QUEUE_CONCURRENCY` (default 2) or less.
- **dead** — jobs that gave up permanently (bad payload/code bug) or
  exceeded `QUEUE_MAX_AGE_HOURS` (default 72h) of transient retries.
  **Never auto-deleted** — see §5 for what to do about them.
- **oldest ready/inflight job age** — how long the single oldest job in
  each state has been waiting. If this keeps climbing past a few
  minutes under normal load, something downstream is stuck — see §4.

`/queue` never shows message text, phone numbers, or any payload
contents — only these five numbers. This is intentional (Rule 5 —
sensitive data stays out of anywhere it might be casually screenshotted
or logged).

If you send `/queue` and you're not a current admin, you'll get a
"not authorized" notice instead — the same check `/undo` and `/edit` use.

---

## 3. `/queue retry` — clearing the dead-letter pile

Send `/queue retry` (admin only). This requeues **every** currently dead
job — resets each one's attempt count to 0 and makes it immediately
ready to be claimed again. It does not delete anything or change what's
in the sheet; it only gives previously-given-up jobs another chance.

Use this after you've fixed whatever caused jobs to dead-letter in the
first place (see §5 for how to tell what that was). Retrying before
fixing the underlying problem just burns through the same failure again.

---

## 4. Alerts — what each one means and what to do

Alerts go to `BOT_ADMIN_FALLBACK_NUMBER` (the same WhatsApp number used
for the existing "bot has been offline" alert), rate-limited to once per
hour per distinct condition — you will not get spammed by repeated
identical alerts, and the throttle resets automatically the moment that
condition clears (so a real *new* problem always alerts promptly, even
if an unrelated old one was recently silenced).

### "Queue: `<type>` jobs are blocked: ..."
**Meaning:** every job of that type (`inbound_message`, `sheet_write`, or
`wa_reply`) is failing with a "blocked" condition — bad/expired
credentials, no quota, or a permissions problem. Specifically:
- `sheet_write` blocked → almost always a Google Sheets problem: wrong
  `GOOGLE_SHEET_ID`, the service account's access to the sheet was
  revoked, or the service account key itself is bad/expired.
- `inbound_message` blocked with an OpenRouter-flavored error in the
  alert text → `OPENROUTER_API_KEY` is invalid or out of credit
  (401/402).

**What to do:**
1. Fix the actual problem (rotate/paste the correct key; re-share the
   sheet with the service account's email as Editor; check
   `GOOGLE_SHEET_ID` is the right spreadsheet).
2. You do **not** need to restart the bot or run `/queue retry` —
   blocked jobs retry themselves automatically every ~15 minutes and
   will simply start succeeding once the underlying problem is fixed.
   If you want it to notice immediately rather than waiting up to 15
   minutes, restart the process (a redeploy on Render, or `pm2 restart`
   on a VM) — this doesn't skip any logic, it just makes the next retry
   happen sooner.
3. No jobs were lost while blocked — they're all still sitting in
   `queued` state, not `dead`, the whole time.

### "Queue: job `<id>` (`<type>`) dead-lettered: ..."
**Meaning:** this specific job either hit a genuinely permanent error
(a code/data bug — e.g. a schema violation) or exhausted
`QUEUE_MAX_AGE_HOURS` (default 72h) of transient retries without ever
succeeding.

**What to do:**
1. If this looks like a one-off transient issue that ran for 72 hours
   without resolving (e.g. Google Sheets was down for an extended
   outage, or Redis briefly lost the job's context) — once whatever was
   actually wrong is fixed, send `/queue retry` to give it another
   chance.
2. If the alert text mentions something like "schema violation" or "no
   handler registered", that's a code-level bug, not an environmental
   one — retrying will just fail the same way again. Flag it for a code
   fix; the job is safely preserved (≥ 30 days) for that investigation.

### "Queue: oldest job is `<N>` minute(s) old (threshold `<M>`m)."
**Meaning:** something is queued or inflight and has been waiting longer
than `QUEUE_ALERT_OLDEST_MINUTES` (default 15) minutes. Usually a symptom
of one of the two alerts above (a blocked condition, or a stuck
concurrency slot) rather than a new, separate problem — check `/queue`
and the other recent alerts first.

### "Queue: unusually high depth (`<N>` queued+inflight jobs)."
**Meaning:** more jobs are piled up than expected at wedding-bot volume
(more than 100 combined). Either a genuine burst of activity, or (more
likely) something downstream has been stuck for a while and jobs are
accumulating behind it. Check the other alerts and `/queue`'s
`oldest ready/inflight job age` for the real cause.

### "Queue: Redis unavailable — job `<id>` (`<type>`) buffered to ..."
**Meaning:** Redis itself was unreachable at the moment a message tried
to enqueue. Nothing was lost — the job was written to a local file
(`./data/queue-buffer.jsonl`) instead, and will be automatically replayed
into the real queue the next time Redis is reachable (checked every
`QUEUE_SWEEP_INTERVAL_SECONDS`, default 60s).

**What to do:** check your Upstash dashboard / `REDIS_URL` for an actual
outage or a typo'd connection string. No action is needed for the
buffered job itself — it will resume automatically. If the bot's process
itself restarts while jobs are still sitting in the local buffer file,
they will still be replayed on the next startup (the buffer file persists
on local disk between restarts of the same host, though not across a
Render redeploy with no persistent disk — see §7 for that specific
limitation).

---

## 5. Diagnosing a specific dead job

`/queue` tells you *how many* dead jobs there are, not *which* ones or
*why*. To find out more, you need direct Redis access (`redis-cli`, or
Upstash's web console's CLI/data browser):

```
# List every dead job's id
SMEMBERS wq:dead

# Read one specific job's full record (JSON) — includes last_error,
# attempts, type, and received_at. Does NOT include full message text
# for sheet_write/wa_reply jobs (only the already-resolved entry), but
# DOES include it for inbound_message jobs — treat this output as
# sensitive, same as any other Redis read (Rule 5).
GET wq:job:<id>
```

The `last_error` field (a short, secret-free string) tells you which
failure class dead-lettered it — look for "schema violation" (permanent,
code-level) vs. an HTTP status or timeout mention that outlived
`QUEUE_MAX_AGE_HOURS` (transient, environmental).

---

## 6. Checking queue health without WhatsApp

`GET /health` on the bot's HTTP port (the same port `/keepalive` uses)
returns:

```json
{"queueEnabled": true, "queued": 0, "inflight": 0, "dead": 0, "oldestReadyAgeMs": null, "oldestInflightAgeMs": null}
```

or, with the queue off:

```json
{"queueEnabled": false}
```

Useful for wiring an external uptime monitor (e.g. the same
cron-job.org ping already used for `/keepalive`, or a separate one
pointed at `/health`) if you want an alert channel independent of
WhatsApp itself.

---

## 7. The normalizer hold policy — what you'll observe

With `NORMALIZER_ON_LLM_DOWN=hold` (the default), if OpenRouter is down,
rate-limited, or the key is bad, submitted expenses will simply **not
get a reply for a little while** (up to `NORMALIZER_MAX_HOLD_MINUTES`,
default 10 minutes) rather than getting an immediate "I couldn't quite
catch that" clarification. This is intentional — the system is quietly
waiting to see if the LLM comes back, rather than bothering the sender
with a message that implies *they* did something wrong when the problem
is actually on the system's side.

After that window, if the v1.0 regex parser managed to read the message
on its own (most clearly-phrased messages do), the expense proceeds
using that reading, unnormalized — still recorded, just not cleaned up.
If the parser *also* couldn't make sense of the message, it keeps
quietly waiting (up to `QUEUE_MAX_AGE_HOURS`, default 72h) rather than
ever guessing.

If you'd rather have the old (pre-queue) immediate fail-open behavior —
skip the wait entirely and always fall back to the parser's own reading
right away — set `NORMALIZER_ON_LLM_DOWN=passthrough`.

---

## 8. Turning everything off

Two independent switches, from most to least disruptive:

- **`QUEUE_ENABLED=false`** — turns off the entire durable queue. Every
  message is handled directly and synchronously again, exactly like
  v1.0/v1.1. Jobs already sitting in Redis at the moment you do this are
  not deleted or lost — they're just never claimed again. They age out
  per their existing TTLs (24h for done, ≥ 30 days for dead), or you can
  clear them manually via `redis-cli` (`DEL` the specific `wq:*` keys, or
  `FLUSHDB` if this Redis instance is used *only* for this bot's queue —
  **do not** `FLUSHDB` if the same Redis instance also holds Baileys auth
  state or anything else, since that would wipe those too).
- **`STATE_STORE=file`** (with the queue still on) — moves pending
  approvals back to the local JSON file. Only sensible on a host with a
  persistent disk; on Render's free tier, switching back to `file` means
  a redeploy/restart could lose an in-flight (not-yet-decided) pending
  approval, which is exactly the problem `STATE_STORE=redis` exists to
  solve — leave it on `redis` on Render.
- **`NORMALIZER_MODE=off`** (unrelated to the queue, v1.1's own switch) —
  turns off LLM normalization entirely, independent of the queue.

After changing any of these, restart the process (redeploy on Render,
`pm2 restart` on a VM) for the new value to take effect.

---

## 9. Known limitation: local buffer file on Render

The Redis-unavailable-at-enqueue buffer (§4, last item) spills to a
local file (`./data/queue-buffer.jsonl`). On a host with a persistent
disk (an Oracle VM), this survives a process restart. On Render's free
tier (no persistent disk), a redeploy or platform-side restart that
happens *while* jobs are sitting in that local buffer file (i.e. Redis
was down at the exact moment of both the enqueue attempt and the
restart) would lose those specific buffered jobs — this is a narrow,
rare double-failure window (Redis down AND a restart, both at once), not
the common case, but it's the one gap in the "no persistent disk"
mitigation. Mitigation: keep buffer-outage windows short by monitoring
your Upstash instance's uptime; the far more common case (Redis
reachable, occasional transient blips) is fully covered by the queue's
normal retry logic, which doesn't touch this local file at all.
