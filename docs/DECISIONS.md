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
