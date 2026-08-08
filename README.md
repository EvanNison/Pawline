# 🐾 Pawline

**Long-term health trends and baseline alerts for pet activity trackers.**

Most pet trackers show you the last 7 days. That's enough to answer "how was
yesterday?" and useless for "has anything been slowly changing since spring?" —
which is the question that actually finds problems early.

Pawline keeps your pet's data **forever**, learns what's normal *for your pet*,
and tells you when something drifts away from it.

> **This is not a veterinary device.** It spots changes in numbers. It cannot
> diagnose anything. A calm dashboard is not evidence your pet is well, and an
> alert is a reason to look closer — not a diagnosis. Always talk to your vet.

---

## Deploy it

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FEvanNison%2FPawline&env=APP_PASSWORD,ENCRYPTION_KEY,CRON_SECRET&envDescription=Three%20secrets%20you%20generate%20yourself%20—%20see%20the%20setup%20guide&envLink=https%3A%2F%2Fgithub.com%2FEvanNison%2FPawline%2Fblob%2Fmain%2Fdocs%2FSETUP.md)

This copies the repository, asks for three values you generate yourself, and
deploys. You then add a free Postgres database from the Vercel dashboard —
two clicks, and the app tells you exactly when and how.

[**The setup guide**](docs/SETUP.md) walks through the whole thing and is
written to be pasted to an AI assistant if you're not a developer. Everything
after deploying is configured in the browser; there is no terminal step.

## What it does

- **Personal baselines, not population averages.** A resting heart rate of 62 is
  meaningless in isolation; 62 when your dog has run 55 for a year is the signal.
  Baselines use the median and a scaled MAD over a trailing 60 days, which don't
  get dragged around by the very outliers you're trying to catch.
- **Alerts that require persistence.** A metric must sit outside the usual range
  on at least 2 of the last 3 *calendar days* before anything fires. One weird
  Tuesday is not an alert.
- **Honest silence.** Nothing is judged until 21 days of history exist. Until
  then it says so, rather than drawing a confident band around four data points.
- **A status page.** Collection can stop while the charts keep showing last
  month, so there's a page that answers "is this actually still working?" — and
  it reports what it *cannot* check rather than assuming those parts are fine.
- **An alert history**, for the conversation with your vet: not "flagged today"
  but "flagged three times since June, here are the dates."
- **Metric or imperial**, dog or cat, and only the measurements your tracker
  actually produces — an always-empty chart reads as "your pet didn't do that".

## Where the data comes from

Pawline analyses pet health data. It is deliberately **not** built around one
vendor. Data arrives through a *source adapter*, and you choose which to enable:

| Source | Risk | Notes |
|---|---|---|
| **CSV import** | None | Bring data from anywhere. Also the export format. |
| **EU Data Act export** | None | Official vendor export. EU residents only. *(not built yet)* |
| **Tractive API** | ⚠️ Vendor terms | Reads your own account. **Read the warning below.** |

If a vendor changes or blocks its API, one adapter breaks. Your stored history,
your baselines and your alert record do not.

### ⚠️ Before enabling the Tractive adapter

Tractive's Terms of Service, [§5.8](https://assets.tractive.com/static/legal/en/terms-of-service.html), say:

> "In case a user interferes with the operation of the services through
> manipulation of the software, proprietary software or gains **automated access
> to the Tractive software** … Tractive is entitled to cancel the services
> immediately and terminate the subscription plan or contractual relationship
> without notice. A claim for reimbursement for already paid service fees cannot
> be made in this case."

**Plainly: using this adapter may get your subscription terminated with no
refund, on a device you may rely on to find your pet.** That is your call to
make, and not one to make casually. It is off by default and the setup page
requires an explicit acknowledgement, which is recorded with a date.

We are not affiliated with, endorsed by, or connected to Tractive GmbH. Other
open-source Tractive clients exist; their existence is evidence the API is
*reachable*, not that this use is *permitted*.

If you're in the EU, prefer the Data Act export — the vendor's own supported
path, with none of this risk.

## Status

**Experimental.** Treat this as statistical anomaly detection over pet tracker
data, not as something shown to find health problems early. The detector is a
robust-statistics heuristic; it has not been calibrated against real outcomes,
and no false-alert rate is published because none has been measured.

Working, and verified against a real Postgres:

- [x] Baselines, alerting, timezone/DST handling, units, migrations
- [x] Password-protected pages and Server Actions
- [x] Encrypted credentials, resumable importer, CSV source
- [x] Collector with gap repair, and the Tractive adapter behind its gate
- [x] Dashboard, status, alerts and setup pages
- [x] Every SQL query checked against the real schema (`npm run check:sql`)

Not done:

- [ ] Never run against a real tracker account for a sustained period. This is
      the big one — the analysis is proven on synthetic data only.
- [ ] EU Data Act importer
- [ ] CSV upload through the browser (the parser exists; the page does not)
- [ ] Statistical calibration: no measured false-alert rate, no detection-delay
      figure, no handling of seasonality or day-to-day autocorrelation

## Development

```bash
npm install
npm test          # 175 tests
npm run typecheck
npm run dev
```

The interesting logic lives in `src/lib/` and is tested without a database.
`docs/DECISIONS.md` records why each rule is the way it is — most were bugs
first. Worth reading before changing anything in the alert lifecycle.

## License

MIT — see [LICENSE](LICENSE). The licence covers this code. It grants you no
rights in relation to any third-party service, and does not alter whatever
agreement you have with your tracker's vendor.
