# 🐾 Pawline

**Long-term health trends and baseline alerts for pet activity trackers.**

Most pet trackers show you the last 7 days. That's enough to answer "how was
yesterday?" and useless for "has anything been slowly changing since spring?" —
which is the question that actually finds problems early.

Pawline keeps your pet's data **forever**, learns what's normal *for your pet*,
and tells you when something drifts away from it. It produces a printable report
you can hand to your vet.

> **This is not a veterinary device.** It spots changes in numbers. It cannot
> diagnose anything. A calm dashboard is not evidence your pet is well, and an
> alert is a reason to look closer — not a diagnosis. Always talk to your vet.

---

## What it does

- **Personal baselines, not population averages.** A resting heart rate of 62 is
  meaningless in isolation; 62 when your dog has run 55 for a year is the signal.
  Baselines use the median and a scaled MAD over a trailing 60 days, which don't
  get dragged around by the very outliers you're trying to catch.
- **Alerts that require persistence.** A metric must sit outside the usual range
  on at least 2 of the last 3 *calendar days* before anything fires. One weird
  Tuesday is not an alert.
- **Honest silence.** Nothing is judged until there are 21 days of history. Until
  then the app says it doesn't know, rather than drawing a confident band around
  four data points.
- **A vet report.** Printable, plain, with year-over-year deltas flagged.

## Where the data comes from

Pawline analyses pet health data. It is deliberately **not** built around one
vendor. Data arrives through a *source adapter*, and you choose which to enable:

| Source | Risk | Notes |
|---|---|---|
| **CSV import** | None | Bring data from anywhere. Also the export/backup format. |
| **EU Data Act export** | None | Official vendor export. EU residents only. |
| **Tractive API** | ⚠️ Vendor terms | Reads your own account through the same private API the vendor's web app uses. **Read the warning below.** |

If a vendor changes or blocks its API, one adapter breaks. Your stored history,
your baselines, and your vet report do not.

### ⚠️ Before enabling the Tractive adapter

Tractive's Terms of Service, [§5.8](https://assets.tractive.com/static/legal/en/terms-of-service.html), say:

> "In case a user interferes with the operation of the services through
> manipulation of the software, proprietary software or gains **automated access
> to the Tractive software** … Tractive is entitled to cancel the services
> immediately and terminate the subscription plan or contractual relationship
> without notice. A claim for reimbursement for already paid service fees cannot
> be made in this case."

The same section covers accessing device data "via means other than those made
available to the user". §5.2 additionally requires you to keep your credentials
confidential.

**Plainly: using this adapter may get your subscription terminated with no
refund, on a device you may rely on to find your pet.** That is your call to
make, not ours, and not one to make casually. The adapter is off by default and
requires an explicit acknowledgement.

We are not affiliated with, endorsed by, or connected to Tractive GmbH. Other
open-source Tractive clients exist; their existence is evidence the API is
*reachable*, not that this use is *permitted*.

If you're in the EU, prefer the Data Act export — it's the vendor's own
supported path and carries none of this risk.

## Status

Early. The analysis core is built and tested; the web app is being ported.

- [x] Baseline + deviation detection (calendar-day windows, robust statistics)
- [x] Timezone/DST-correct day boundaries
- [x] Canonical SI storage with metric/imperial display
- [x] Source adapter interface
- [x] Versioned, atomic schema migrations
- [x] Encrypted credential storage (AES-256-GCM)
- [x] Resumable history importer
- [x] CSV source (import + export format)
- [x] Tractive payload mapping (pure, fixture-testable)
- [x] Test suite — 95 tests
- [x] [Setup guide](docs/SETUP.md) for a non-technical installer
- [ ] Tractive network client + the acknowledgement gate
- [ ] EU Data Act importer
- [ ] Web dashboard, trends, vet report
- [ ] One-click deploy button
- [ ] `/status` self-diagnosis page

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT — see [LICENSE](LICENSE). The licence covers this code. It does not grant
you any rights in relation to any third-party service, and it does not alter
whatever agreement you have with your tracker's vendor.
