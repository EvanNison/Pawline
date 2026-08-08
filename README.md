# 🐾 Pawline

**Long-term health trends and baseline alerts for pet activity trackers.**

Most pet trackers show you the last 7 days. That answers "how was yesterday?"
and is useless for "has anything been slowly changing since spring?"

Pawline keeps your pet's data **forever**, learns what's normal *for your pet*,
and tells you when something drifts away from it.

> It spots changes in numbers — it can't diagnose anything, and a calm dashboard
> isn't proof your pet is well. Treat an alert as a reason to look closer, and
> talk to your vet.

## Deploy it

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FEvanNison%2FPawline&env=APP_PASSWORD,ENCRYPTION_KEY,CRON_SECRET&envDescription=Three%20secrets%20you%20generate%20yourself%20—%20see%20the%20setup%20guide&envLink=https%3A%2F%2Fgithub.com%2FEvanNison%2FPawline%2Fblob%2Fmain%2Fdocs%2FSETUP.md)

This copies the repo, asks for three values you generate yourself, and deploys.
You then add a free Postgres database from the Vercel dashboard — two clicks,
and the app tells you exactly when and how.

[**The setup guide**](docs/SETUP.md) walks through all of it, and is written to
be pasted to an AI assistant if you're not a developer. Everything after
deploying happens in the browser; there's no terminal step.

## What it does

- **Personal baselines, not population averages.** A resting heart rate of 62
  means nothing in isolation; 62 when your dog has run 55 for a year is the
  signal. Baselines use the median and a scaled MAD over a trailing 60 days, so
  they don't get dragged around by the outliers you're trying to catch.
- **Alerts that require persistence.** A measurement must sit outside the usual
  range on at least 2 of the last 3 *calendar days* before anything fires. One
  weird Tuesday is not an alert.
- **Honest silence.** Nothing is judged until 21 days of history exist, and a
  green tick needs current readings, not just deep history. If collection stops,
  the dashboard says so rather than going quiet and green.
- **A printable vet report.** Year-over-year averages with the day count behind
  each one, and shifts of 15%+ in the concerning direction called out.
- **An alert history** for the conversation with your vet: not "flagged today"
  but "flagged three times since June, here are the dates."
- **A status page** answering "is this actually still working?" — including what
  it *can't* check, rather than assuming those parts are fine.
- **Metric or imperial**, dog or cat, and only the measurements your tracker
  really produces, because an always-empty chart reads as "your pet didn't do
  that."

## Where the data comes from

Pawline isn't built around one vendor. Data arrives through a *source adapter*:

| Source | Risk | Notes |
|---|---|---|
| **CSV import** | None | Any tracker that exports a spreadsheet, or a file you keep by hand. |
| **Tractive API** | ⚠️ Vendor terms | Reads your own account. See below. |
| **EU Data Act export** | None | The vendor's own official export. *(not built yet)* |

If a vendor changes or blocks its API, one adapter breaks. Your stored history,
your baselines and your alert record don't.

### Before you enable the Tractive adapter

Tractive's [terms §5.8](https://assets.tractive.com/static/legal/en/terms-of-service.html)
let them cancel your subscription, immediately and without a refund, for gaining
"automated access to the Tractive software" — which is what this adapter does.

That's a real trade on a device you might rely on to find your pet, so it's off
by default, the setup page makes you tick an acknowledgement, and you can
disconnect it again at any time. Your stored history stays either way.

Not affiliated with Tractive GmbH. Other open-source Tractive clients exist,
which shows the API is *reachable*, not that this use is *permitted*.

**The CSV import has none of this attached**, and gets you a working dashboard
in about a minute.

## Status

**Experimental.** This is robust-statistics anomaly detection over tracker data.
It hasn't been calibrated against real outcomes — no measured false-alert rate,
no detection-delay figure, no handling of seasonality.

Working, and verified against a real Postgres:

- [x] Baselines, alerting, timezone/DST handling, units, migrations
- [x] Password-protected pages and Server Actions
- [x] Dashboard, status, alerts, trends, vet report, setup
- [x] CSV import, hand-logged weight and dated notes
- [x] Encrypted credentials; the Tractive adapter behind its acknowledgement gate
- [x] Every SQL query prepared against the real schema (`npm run check:sql`),
      plus an end-to-end import check (`npm run check:import`)

Not there yet:

- [ ] **Never run against a real tracker account for a sustained period.** The
      analysis is proven on synthetic data only. This is the big one.
- [ ] Statistical calibration, as above
- [ ] EU Data Act importer, and chunked backfill of a long vendor history —
      `src/lib/importer.ts` is written and tested, but nothing calls it yet
- [ ] Hour-of-day heatmap: needs hourly readings only a vendor API supplies, so
      it would sit permanently blank for import-only setups
- [ ] Species and timezone are one setting per install, not per pet
- [ ] A stored Gmail App Password can't be deleted from the UI — clearing the
      username stops sending, but the row stays until you remove it

## Development

```bash
npm install
npm test              # 223 tests, no database needed
npm run typecheck
npm run dev
```

Two checks need a real Postgres in `DATABASE_URL` (TLS required — a free Neon
database is the easy answer). Both build a throwaway schema and drop it after:

```bash
npm run check:sql     # PREPAREs every query in src/ against the real schema
npm run check:import  # runs the CSV import path for real, end to end
```

They exist because the unit suite provably can't catch what they catch: a query
can be fully "tested" against a fake runner and still name a column that doesn't
exist, and a `jsonb` column read through a TypeScript cast silently produced a
string — which made every dashboard render zero charts while every test passed.

The interesting logic lives in `src/lib/` and is tested without a database.
`docs/DECISIONS.md` records why each rule is the way it is; most were bugs
first. Worth reading before changing anything in the alert lifecycle.

## License

MIT — see [LICENSE](LICENSE). The licence covers this code. It grants no rights
in relation to any third-party service, and doesn't alter whatever agreement you
have with your tracker's vendor.
