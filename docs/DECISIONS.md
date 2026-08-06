# Design decisions

Short record of the choices that shaped this codebase, so a future contributor
(or a future assistant) doesn't quietly undo them.

## 1. Ingestion is an adapter, not the product

The original private version was built directly around one vendor's private API.
That made the project *be* "a scraper for Tractive", which has three problems:
the vendor's terms forbid automated access (§5.8), the project dies the day the
API changes, and it can't serve anyone whose data comes from elsewhere.

Sources now implement `src/lib/sources/types.ts`. Vendor API access is one
adapter among several, off by default, behind an explicit acknowledgement that
quotes the actual terms.

This is not a legal fig leaf — it's the same thing good engineering wanted
anyway: a replaceable boundary around the part most likely to break.

## 2. Windows are measured in calendar days, never in readings

The original counted array entries: "the last 3 readings". With a collection gap
— a flat battery, a failed cron, a password change — three readings could span
three weeks and still be treated as "3 days running", producing a confident
health alert from scattered data.

Every window in `baseline.ts` selects by calendar day, anchored to the newest
reading's date. Covered by `baseline.test.ts` ("two spikes 20 days apart").

## 3. Day boundaries resolve a real timezone, never a fixed offset

The original hardcoded `-04:00`. That is US Eastern *daylight* time: wrong for
roughly half the year, wrong for everyone outside that zone, and it assumes
every day is 86400 seconds when DST days are 23 or 25 hours.

`time.ts` resolves the offset actually in force on each date. Covered by
`time.test.ts`, including both DST transitions and a southern-hemisphere zone
where DST runs the other way.

## 4. One canonical unit per dimension, converted only at the edge

The original stored `weight_lb` and `distance_mi` — US units baked into column
names, APIs, emails and CSVs, for an Austrian vendor whose users are mostly
metric. Worse, a regex classifier assigned any field matching `distance` to
miles *without knowing the source unit*.

Storage is SI (grams, meters). `units.ts` converts for display and for
user-entered values. An adapter that emits a number must state the metric, and
the metric declares its unit.

## 5. Metrics are declared, not pattern-matched

Regex over flattened vendor payloads is a fine way to *discover* what a tracker
returns. It is a bad way to decide what a medical-looking chart displays: a
broad pattern can silently bind the wrong field to a line a vet will read.

`metrics.ts` is an explicit registry. Discovery stays a separate, clearly
labelled activity and never auto-promotes a field into alerting.

## 6. Silence means "no opinion", not "healthy"

Nothing is judged until 21 days of history exist — and the *chart band* holds to
the same bar as the *alert*. The original drew a "usual range" from as few as two
readings, which looks authoritative and means nothing.

## 7. Capabilities are per-pet, and unsupported features are hidden

Not every tracker reports heart rate; cats don't get bark detection. An empty
"Barking" chart reads as "no barking", which is a false statement about the pet.
`availableMetrics()` filters by species *and* by what the hardware actually
produces.

## 8. Secrets fail closed

The original authorised *everyone* when `CRON_SECRET` was unset, on both the
collector and a discovery route that returned raw account payloads. Missing
configuration must deny, never allow. Secrets also never travel in query
strings, where they end up in server logs.

## 9. Alert lifecycle invariants — carried over, not re-derived

Pawline has no alerting layer yet. When it gets one, these rules are not
suggestions: each one cost a round of adversarial review in the predecessor,
and most were found only after a previous fix had introduced them.

**Identity.** An alert is keyed by the date of the *deviation*, never by the day
it was noticed. Keying on "today" makes one unchanged stale condition produce a
fresh row, and a fresh email, on every single run.

**Order.** Raise → notify → withdraw, in that order, in one pass. Withdrawing
before sending deletes a real alert whose email failed yesterday the moment
today's data looks normal, so it is never reported at all.

**Withdrawal needs positive evidence.** "No deviation detected" is not evidence
of recovery: detection also returns nothing when there is too little history, or
when too few recent readings survive filtering to satisfy the 2-of-3 rule. After
a gap, a single fresh *and still abnormal* reading produces exactly that. Require
that current readings actually sit inside the band.

**"Delivered" and "resolved" are different facts.** Using one flag for both means
every fix for one breaks the other. A resolved-but-undelivered alert must vanish
from the dashboard immediately (claiming a recovered metric is trending is a
false alert) while staying eligible for retry (or the deviation is never
reported). Two states, not one.

**Nothing may be both undeliverable and invisible.** Any age ceiling on retries
strands alerts: they cannot be sent, cannot be withdrawn if withdrawal requires
delivery, and are hidden for being old. Retry without a date ceiling, display
anything undelivered at any age, and give up only after a bounded grace period.

**Never fake a delivery.** Marking rows notified when no email channel is
configured spends a delivery that never happened — and "configured later" is a
normal path, not a corner case. Make the *requirement* conditional instead.

**Silence is never good news.** An empty alert list means "nothing is wrong" only
when something could have been detected. With three days of history, a green tick
states the opposite of the truth.

## 10. A green test suite is not evidence

Every guarantee above is worth exactly as much as the test that would fail
without it. Mutation testing — re-break the fix, confirm the suite notices — is
how that gets checked, and it has repeatedly found otherwise-invisible problems:

- Tests that could never fail (`a + (b - a) === b`), or that passed when every
  value under test was null.
- Logic living somewhere a test cannot reach (a SQL `WHERE` clause, or a
  function body inside a page component). If a rule cannot be mutated, extract it.
- A mutation that *stops* being caught means the code was duplicated and the
  mutation hit a copy no test exercises. That is how the tripled window
  arithmetic surfaced, before it could drift into a real bug.

Run it against this repo with the same pattern before trusting a release.
