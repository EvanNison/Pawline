<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# If you are helping someone set this up

Assume the person you are talking to is **not a developer** and opened you in
this folder because someone told them to. That is the expected way to use this
repo. Read [`docs/SETUP.md`](docs/SETUP.md) and follow it — it is the actual
procedure, written for exactly this situation.

Work one step at a time and wait for them to confirm each one. Do not batch five
instructions together. Do not assume they know what a terminal, an environment
variable, or a deployment is; say what to click.

## Never ask them to paste a secret into this chat

Not the database URL, not `APP_PASSWORD`, not `ENCRYPTION_KEY`, not
`CRON_SECRET`, not a Gmail App Password, not their tracker login. Every one of
those is typed **directly into the Vercel dashboard or the app's own Setup
page**, never into a conversation with you.

If they paste one anyway, tell them plainly to rotate it, and carry on without
repeating the value back.

You can help them *generate* a random value (an encryption key, a cron secret)
and tell them where to put it. That is different from receiving one they already
use somewhere.

## Do not enable the Tractive source for them

`src/lib/sources/registry.ts` gates it behind an explicit acknowledgement,
recorded with a date, and that gate exists for a reason: Tractive's terms permit
them to terminate the subscription, with no refund, for automated access. That
is a real cost on a device people rely on to find a lost pet.

**That decision is theirs and must be made knowingly.** Show them the warning on
the Setup page, let them read it, and let them tick the box themselves. Do not
tick it, do not describe the risk as a formality, and do not enable it to "finish
setting things up".

If they would rather not accept that risk, the **Import** page takes a
spreadsheet from any tracker and carries no risk at all. Point them there first —
it also gets them a working dashboard in a minute rather than overnight.

## Do not add health claims

This app deliberately says what changed, never what it means. If you write copy,
docs, or UI text, keep it that way: no diagnosis, no "this indicates", no
reassurance that a quiet dashboard means a healthy animal. `docs/DECISIONS.md`
§6 explains why silence is never reported as good news, and the whole design
depends on it.

# If you are changing the code

Read [`docs/DECISIONS.md`](docs/DECISIONS.md) first. Nearly every rule in it was
a bug before it was a rule, and several look arbitrary until you know the story —
particularly the alert lifecycle (§9), why a green test suite is not evidence
(§10), and why database boundaries are not to be trusted to a cast (§13).

Before you claim something works:

```bash
npm test          # 214 tests, no database needed
npm run typecheck
npm run lint
```

And, if your change touches SQL, storage, or anything that crosses the database
boundary, these need a real Postgres in `DATABASE_URL` (TLS required — a free
Neon database is the easy answer). Both build a throwaway schema and drop it
afterwards:

```bash
npm run check:sql     # PREPAREs every query in src/ against the real schema
npm run check:import  # runs the CSV import path for real, end to end
```

These exist because the unit suite cannot catch what they catch. It runs against
a fake SQL runner, so a query can be fully "tested" and still name a column that
does not exist — and a `jsonb` column read with a TypeScript cast silently
produced a string, which made every dashboard render zero charts while every
test passed.

**Open the running page before believing you are done.** Three separate rounds
of bugs here were invisible to the suite and obvious within seconds on screen.
