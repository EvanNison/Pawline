# 🐾 Pawline

Long-term health trends and baseline alerts for pet activity trackers.

Most pet trackers only show you the last 7 days. Pawline keeps your pet's data
indefinitely, learns what's normal for your pet, and emails you when something
drifts outside that range.

It detects changes in numbers. It can't diagnose anything, and a quiet
dashboard isn't proof your pet is well. Talk to your vet.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FEvanNison%2FPawline&env=APP_PASSWORD,ENCRYPTION_KEY,CRON_SECRET&envDescription=Three%20secrets%20you%20generate%20yourself%20—%20see%20the%20setup%20guide&envLink=https%3A%2F%2Fgithub.com%2FEvanNison%2FPawline%2Fblob%2Fmain%2Fdocs%2FSETUP.md)

This copies the repo, asks for three values you generate, and deploys. You then
add a free Postgres database from the Vercel dashboard, which takes two clicks.

[The setup guide](docs/SETUP.md) covers the whole thing. It's written to be
pasted into Claude or ChatGPT if you're not a developer. There's no terminal
step after deploying.

## How it works

Baselines are per-pet, built from the median and a scaled MAD over a trailing
60 days. A resting heart rate of 62 means nothing on its own; 62 when your dog
has run 55 all year is the signal.

An alert needs a measurement outside the usual range on 2 of the last 3 calendar
days, so a single odd day doesn't fire one.

Nothing is judged until there are 21 days of history. A green status also
requires recent readings, so if collection stops the dashboard says so instead
of staying green.

Other things it does:

- A printable vet report with year-over-year averages, the day count behind each
  one, and shifts of 15% or more flagged
- Alert history, so you can say "flagged three times since June" rather than
  "flagged today"
- A status page covering what's working, and what it can't check
- Hand-logged weight and dated notes, for what trackers don't record
- Metric or imperial, dog or cat, showing only the measurements your tracker
  actually produces

## Data sources

Pawline isn't tied to one vendor. Data comes in through a source adapter:

| Source | Risk | Notes |
|---|---|---|
| **CSV import** | None | Any tracker that exports a spreadsheet, or a file you keep by hand |
| **Tractive API** | ⚠️ Vendor terms | Reads your own account. See below |
| **EU Data Act export** | None | The vendor's own official export. *Not built yet* |

If a vendor blocks or changes its API, one adapter breaks. Your stored history,
baselines and alert record don't.

### Before enabling the Tractive adapter

Tractive's [terms §5.8](https://assets.tractive.com/static/legal/en/terms-of-service.html)
let them cancel your subscription immediately and without a refund for gaining
"automated access to the Tractive software". That's what this adapter does.

It's off by default, the setup page makes you tick an acknowledgement, and you
can disconnect it at any time. Your stored history stays either way.

Not affiliated with Tractive GmbH. Other open-source Tractive clients exist,
which shows the API is reachable, not that this use is permitted.

The CSV import has none of this attached and gets you a working dashboard in
about a minute.

## Status

Experimental. This is robust-statistics anomaly detection over tracker data. It
hasn't been calibrated against real outcomes, so there's no measured false-alert
rate, no detection-delay figure, and no handling of seasonality.

Working, and verified against a real Postgres:

- [x] Baselines, alerting, timezone and DST handling, units, migrations
- [x] Password-protected pages and Server Actions
- [x] Dashboard, status, alerts, trends, vet report, setup
- [x] CSV import, hand-logged weight and dated notes
- [x] Encrypted credentials, and the Tractive adapter behind its gate
- [x] Every SQL query prepared against the real schema (`npm run check:sql`),
      plus an end-to-end import check (`npm run check:import`)

Not there yet:

- [ ] **Not yet run against a real tracker account for a sustained period.**
      The Tractive adapter has been verified once against a live account: 26 of
      26 metrics matched a second, independent implementation across two days.
      But nothing has run for weeks on end, which is what alerting actually
      depends on
- [ ] Statistical calibration, as above
- [ ] EU Data Act importer, and chunked backfill of a long vendor history.
      `src/lib/importer.ts` is written and tested but nothing calls it yet
- [ ] Hour-of-day heatmap, which needs hourly readings only a vendor API
      supplies, so it would sit empty for import-only setups
- [ ] Species and timezone are one setting per install, not per pet
- [ ] A stored Gmail App Password can't be deleted from the UI. Clearing the
      username stops sending, but the row stays until you remove it

## Development

```bash
npm install
npm test              # 223 tests, no database needed
npm run typecheck
npm run dev
```

Two checks need a real Postgres in `DATABASE_URL`. TLS is required, so a free
Neon database is the easy option. Both build a throwaway schema and drop it
afterwards:

```bash
npm run check:sql     # PREPAREs every query in src/ against the real schema
npm run check:import  # runs the CSV import path end to end
```

They exist because the unit tests run against a fake SQL runner, which can't
catch a query naming a column that doesn't exist, or a `jsonb` column read
through a TypeScript cast that silently returns a string.

The logic lives in `src/lib/` and is tested without a database.
`docs/DECISIONS.md` records why each rule is the way it is. Most were bugs
first, so it's worth reading before changing anything in the alert lifecycle.

## License

MIT, see [LICENSE](LICENSE). The licence covers this code. It grants no rights
to any third-party service and doesn't alter whatever agreement you have with
your tracker's vendor.
