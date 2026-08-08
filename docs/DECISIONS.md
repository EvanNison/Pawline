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
suggestions: each cost a round of adversarial review in the predecessor, and
most were found only after a previous fix had introduced them. Several were
also *wrong as first written here* — corrected below.

**Identity is the episode, not the day.** Keying an alert by the deviation's
date stops an unchanged *stale* condition being re-raised, but an ongoing one
moves its date forward daily, so a five-day episode produced five alerts and
five emails. An open unacknowledged alert for a metric means the episode is
already running: refresh it in place, keeping the date it started.

**Order: raise, notify, withdraw — and delivery is at-least-once.** Withdrawing
before sending deletes a real alert whose email failed yesterday the moment
today looks normal. But this cannot be made atomic against an external mail
service: a crash after sending and before recording it will re-send. Choose
at-least-once deliberately — a duplicate email is recoverable, a dropped health
alert is not — and say so, rather than implying exactly-once.

**Withdrawal needs positive evidence, specified precisely.** "No deviation
detected" is not evidence: detection also returns nothing when there is too
little history, or when too few readings survive filtering to satisfy the
2-of-3 rule. Require instead that *every* reading in the detection window sits
inside the band, that those readings are wear-valid, and that the data is
current. Note the residual hazard: a rolling baseline slowly absorbs a long
episode, so a condition that never resolves can eventually look in-band. If
that matters, freeze the band at the alert's creation.

**"Delivered" and "resolved" are different facts.** Using one flag for both
means every fix for one breaks the other. A resolved-but-undelivered alert must
leave the dashboard immediately (claiming a recovered metric is trending is a
false alert) while staying eligible for retry (or the deviation is never
reported). Two columns, not one.

**Nothing may be both undeliverable and invisible.** Retries carry no date
ceiling and the dashboard shows anything undelivered at any age. These two do
not conflict with giving up: the grace period ends the *alert*, by withdrawing
it, not the retry — so there is never a row that can neither be sent nor seen.

**Never fake a delivery.** Marking rows notified when no email channel is
configured spends a delivery that never happened, and "configured later" is a
normal path. Make the *requirement* conditional instead.

**Silence is never good news, per metric.** An empty alert list means "nothing
is wrong" only where something could have been detected — which depends on that
metric's own baseline depth, recent valid readings, wear, and source freshness,
not on the pet having data in general.

**The schema must be able to hold all of this.** The `alerts` table here has
`acknowledged` and nothing else; delivered, resolved, days-outside and note
columns are a prerequisite, not a later refinement. The predecessor discovered
that by finding a stop reason it could not persist.

## 10. A green test suite is not evidence — and neither is a green mutation run

Every guarantee above is worth exactly as much as the test that would fail
without it. Mutation testing — re-break the fix, confirm the suite notices — is
how that gets checked, and it has repeatedly found otherwise-invisible problems:

- Tests that could never fail (`a + (b - a) === b`), or that passed when every
  value under test was null.
- Logic living somewhere a test cannot reach (a SQL `WHERE` clause, a function
  body inside a page component). If a rule cannot be mutated, extract it.
- A mutation that *stops* being caught means the code was duplicated and the
  mutation hit a copy no test exercises. That is how tripled window arithmetic
  surfaced before it could drift into a real bug.

But mutation testing only proves the tests notice changes to code that exists.
It cannot detect, and has already failed to detect here:

- **A wrong shared assumption.** Both the code and its test can believe the same
  false thing. The vendor fixtures in `tractive-map.test.ts` are invented from
  memory of the payload shape; mutation proves the mapper matches the fixture,
  not that the fixture matches Tractive.
- **An input class absent from the corpus.** Every timezone test passed while
  `midnightEpoch` was wrong for zones that skip midnight, because no such zone
  was in the tests.
- **Behaviour with no code to mutate.** A missing column, an absent state, a
  rule never written down. `import_jobs` could not persist why an import
  stopped, and no mutation could have revealed it.
- **The real environment.** The fake SQL runner cannot exhibit Postgres's actual
  behaviour.

So: mutation testing raises the floor. Recorded real fixtures, an adversarial
reader, and running the thing against real data raise the ceiling. Do all four
before trusting a release.

## 11. Every query is checked against a real schema, because tests cannot be

§10 predicted this: "the fake SQL runner cannot exhibit Postgres's actual
behaviour." Two bugs then proved it, both invisible to 177 passing tests, a
clean typecheck and a clean lint:

- `/status` selected `runs.trigger`; the column is `kind`. The page you open
  when something looks wrong was the only reader that disagreed with the
  schema, so it failed precisely when it was needed.
- `upgradeStoredSecrets` read `app_credentials`, a table inherited from the
  predecessor that this schema never creates. The error was swallowed by a
  `.catch()`, so credentials silently stayed in plaintext while the status page
  promised they would be encrypted on the next collection.

`npm run check:sql` builds the schema in a throwaway namespace and `PREPARE`s
every tagged template in `src/`. `PREPARE` resolves identifiers, types and
operators without executing, which is exactly the layer these bugs live in —
and the layer that cost the predecessor two days of data to `date >= integer`.

**Run it before any release.** A query that only appears on an error path, or
once a month, is otherwise first executed by a user.

## 12. Two auth layers, because Server Actions are their own front door

`APP_PASSWORD` was documented in `.env.example` and promised in `SETUP.md`
("a private website only you can open") and read nowhere in `src/`. Every page
was public, including the setup form that stores Tractive credentials. The
documentation made the deployment look safer than it was, which is worse than
having said nothing.

The fix is deliberately redundant:

- `proxy.ts` redirects unauthenticated requests. Its matcher is an *exclusion*
  list, so a new page is protected unless someone deliberately exempts it.
- `requireSession()` is the first statement in every page and every Server
  Action.

The second layer is load-bearing rather than belt-and-braces: **Next dispatches
Server Actions by action id, not by route.** The setup actions are therefore
reachable through a POST to `/login`, which Proxy must exempt. Only the
in-action check stops that. Next's own guidance says the same thing — Proxy
"should not be your only line of defense", and Server Actions are to be treated
as public endpoints.

Sessions are an HMAC of the expiry keyed by `APP_PASSWORD`, so changing the
password signs every device out with no revocation list to maintain.

A missing `APP_PASSWORD` in production refuses every request and explains why.
Defaulting open when unconfigured is the bug this section exists to record.

## 13. A cast is a claim, and the database is what settles it

`listPets` read the `capabilities` jsonb column as:

```ts
capabilities: (r.capabilities as string[]) ?? []
```

This driver returns `jsonb` as a **string**. The cast compiled, asserted
something false, and erased itself at runtime. Downstream, `availableMetrics`
built a `Set` from it — a `Set` of single characters — so `cap.has("weight")`
was always false and **every dashboard rendered a pet name, "not enough
history", and no charts at all, from any source, permanently.**

It survived 196 passing tests, a clean typecheck, a clean lint and a successful
production build, because every one of those runs against a fake SQL runner that
hands back genuine arrays. It took ten seconds to find by opening the page.

Two rules follow:

1. **`as` on anything crossing the database boundary is a bug waiting to be
   observed.** Parse and validate instead — `toStringArray` accepts both shapes,
   so a driver that does parse jsonb keeps working.
2. **Open the running page.** §10 said recorded fixtures and real data raise the
   ceiling that mutation testing cannot. This is the third time that has been
   proved: the chart bugs, the raw 500s, and now this. Every one was invisible
   to the suite and obvious on screen.

`npm run check:import` now asserts the round trip — write, read back, and
confirm the value still selects the metrics it names — because the write
succeeding was never the part in doubt.
