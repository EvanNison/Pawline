"use client";

/**
 * "Several readings together" cards: Vitals check, Readiness, Itch & comfort,
 * Long-term heart & breathing, and journal context.
 *
 * Shown IN ADDITION to the single-metric alerts and charts, never instead of
 * them. All numbers are computed server-side in page.tsx from
 * src/lib/composites.ts; this component only draws them.
 *
 * Hover (mouse) or tap / drag (touch) over any strip to see that day. The three
 * daily cards share one selection, so pointing at a day in one shows the same
 * day in all of them.
 */
import { useState } from "react";
import Link from "next/link";
import { SUMMARY_RANGES } from "@/lib/composites";
import type { CompositeDay, Readiness, LongTrend, MonthPoint, JournalEntry, Reading } from "@/lib/composites";

export interface HealthSummaryProps {
  petId: string;
  summaryRange: number;
  days: string[];
  vitals: CompositeDay[];
  vitalsStreak: number;
  readiness: (Readiness | null)[];
  comfort: CompositeDay[];
  /** Per day: does a journal entry cover it (or end within 3 days before)? */
  hasContext: boolean[];
  longTerm: {
    label: string;
    unit: string;
    trend: LongTrend | null;
    months: MonthPoint[];
  }[];
  context: JournalEntry[];
}

const LEVEL_STYLE: Record<string, string> = {
  unknown: "bg-zinc-100 dark:bg-zinc-800",
  normal: "bg-emerald-300 dark:bg-emerald-700",
  one: "bg-yellow-300 dark:bg-yellow-600",
  watch: "bg-orange-400 dark:bg-orange-600",
  alert: "bg-red-500",
};

const BADGE_STYLE: Record<string, string> = {
  unknown: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800",
  normal: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100",
  one: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-100",
  watch: "bg-orange-200 text-orange-900 dark:bg-orange-800 dark:text-orange-50",
  alert: "bg-red-500 text-white",
};

const LEVEL_TEXT: Record<string, string> = {
  unknown: "not enough data",
  normal: "all within their usual range",
  one: "one reading off on its own",
  watch: "two readings off together",
  alert: "several readings off together",
};

function dayLabel(date: string, withYear = false) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: withYear ? undefined : "short",
    month: "short",
    day: "numeric",
    year: withYear ? "numeric" : undefined,
    timeZone: "UTC",
  });
}

function monthLabel(month: string) {
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function fmt(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function offText(o: Reading) {
  return `${o.label.toLowerCase()} ${o.side === "high" ? "up" : "down"} (${fmt(o.value)} vs usual ${fmt(o.median)})`;
}

/**
 * A row of cells you can scrub across. Works out which cell is under the
 * pointer from its x position, so even a 365-cell strip a pixel per day wide is
 * easy to explore with a finger.
 */
function Scrub({
  count,
  active,
  onActive,
  className,
  children,
}: {
  count: number;
  active: number | null;
  onActive: (i: number | null) => void;
  className: string;
  children: React.ReactNode;
}) {
  const pick = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * count);
    onActive(Math.max(0, Math.min(count - 1, i)));
  };
  return (
    <div
      className={`relative cursor-crosshair touch-none select-none ${className}`}
      onPointerMove={pick}
      onPointerDown={pick}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") onActive(null);
      }}
    >
      {children}
      {active !== null && (
        <div
          className="pointer-events-none absolute inset-y-0 border-x-2 border-zinc-900 dark:border-white"
          style={{ left: `${(active / count) * 100}%`, width: `max(${100 / count}%, 3px)` }}
        />
      )}
    </div>
  );
}

function Axis({ days }: { days: string[] }) {
  if (days.length === 0) return null;
  const long = days.length > 60;
  return (
    <div className="mt-0.5 flex justify-between text-[10px] text-zinc-400">
      <span>{dayLabel(days[0], long)}</span>
      <span>{long ? "hover or tap and drag" : "hover or tap a day"}</span>
      <span>{dayLabel(days[days.length - 1], long)}</span>
    </div>
  );
}

const card = "rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900";

export default function HealthSummary(p: HealthSummaryProps) {
  const { days, vitals, readiness, comfort, hasContext } = p;
  const [sel, setSel] = useState<number | null>(null);
  const n = days.length;

  // With nothing selected, each card shows its most recent judgeable day.
  const lastIdx = (ok: (i: number) => boolean) => {
    for (let i = n - 1; i >= 0; i--) if (ok(i)) return i;
    return null;
  };
  const vi = sel ?? lastIdx((i) => vitals[i].level !== "unknown");
  const ri = sel ?? lastIdx((i) => readiness[i] !== null);
  const ci = sel ?? lastIdx((i) => comfort[i].level !== "unknown");

  const scored = readiness.filter((r): r is Readiness => r !== null);
  const avgScore = scored.length ? Math.round(scored.reduce((a, r) => a + r.score, 0) / scored.length) : null;
  const flagged = vitals.filter((d) => d.level === "watch" || d.level === "alert").length;
  const judged = vitals.filter((d) => d.level !== "unknown").length;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Readings judged together</h2>
        <nav className="flex gap-1 text-xs">
          {SUMMARY_RANGES.map(([r, lbl]) => (
            <Link
              key={r}
              scroll={false}
              href={`/?pet=${encodeURIComponent(p.petId)}&sr=${r}`}
              className={`rounded-md px-2 py-1 ${r === p.summaryRange ? "bg-indigo-600 text-white" : "bg-zinc-100 dark:bg-zinc-800"}`}
            >
              {lbl}
            </Link>
          ))}
        </nav>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Vitals check */}
        <div className={card}>
          <h3 className="text-sm font-semibold">Vitals check</h3>
          <p className="text-xs text-zinc-500">
            Heart rate, breathing, night wake-ups and activity, judged together. Two or more off on the same
            day is the pattern worth taking more seriously.
          </p>
          <p className="mt-2 min-h-[2.5rem] text-sm">
            {vi !== null ? (
              <>
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${BADGE_STYLE[vitals[vi].level]}`}>
                  {dayLabel(days[vi])}
                </span>{" "}
                {LEVEL_TEXT[vitals[vi].level]}
                {vitals[vi].off.length > 0 && <>: {vitals[vi].off.map(offText).join(", ")}</>}
                {sel === null && p.vitalsStreak >= 2 && (
                  <span className="font-medium"> · {p.vitalsStreak} days running</span>
                )}
              </>
            ) : (
              <span className="text-zinc-500">Not enough recent data yet.</span>
            )}
          </p>
          <Scrub count={n} active={sel} onActive={setSel} className="mt-2 flex h-7 gap-px">
            {vitals.map((d) => (
              <div key={d.date} className={`flex-1 ${n <= 31 ? "rounded-sm" : ""} ${LEVEL_STYLE[d.level]}`} />
            ))}
          </Scrub>
          <ContextDots hasContext={hasContext} />
          <Axis days={days} />
          <p className="mt-1 text-[10px] text-zinc-400">
            green = normal · yellow = one off · orange = two off · red = heart + breathing up together, or 3+ off
            {hasContext.some(Boolean) && " · amber dots = journal entry"}
            {judged > 0 && ` · flagged ${flagged} of ${judged} days in this view`}
          </p>
        </div>

        {/* Readiness */}
        <div className={card}>
          <h3 className="text-sm font-semibold">Readiness</h3>
          <p className="text-xs text-zinc-500">
            0–100: how normal their body looks compared with their own usual. Most days score 90+.
          </p>
          <div className="mt-2 flex min-h-[2.5rem] items-baseline gap-3">
            {ri !== null && readiness[ri] ? (
              <>
                <span
                  className={`text-3xl font-bold ${readiness[ri]!.band === "good" ? "text-emerald-600" : readiness[ri]!.band === "fair" ? "text-amber-600" : "text-red-600"}`}
                >
                  {readiness[ri]!.score}
                </span>
                <span className="text-xs text-zinc-500">
                  {dayLabel(days[ri])} · {readiness[ri]!.parts.map((x) => `${x.label.toLowerCase()} ${x.score}`).join(" · ")}
                </span>
              </>
            ) : (
              <span className="text-sm text-zinc-500">
                {sel !== null ? `${dayLabel(days[sel])}: no score (not enough data that day)` : "Not enough recent data yet."}
              </span>
            )}
          </div>
          <Scrub count={n} active={sel} onActive={setSel} className="mt-2 flex h-14 items-end gap-px">
            {readiness.map((r, i) => (
              <div
                key={i}
                style={{ height: `${r ? Math.max(4, r.score) : 4}%` }}
                className={`flex-1 ${n <= 31 ? "rounded-sm" : ""} ${!r ? "bg-zinc-100 dark:bg-zinc-800" : r.band === "good" ? "bg-emerald-400" : r.band === "fair" ? "bg-amber-400" : "bg-red-500"}`}
              />
            ))}
          </Scrub>
          <ContextDots hasContext={hasContext} />
          <Axis days={days} />
          {avgScore !== null && (
            <p className="mt-1 text-[10px] text-zinc-400">
              average {avgScore} over this view · lowest {Math.min(...scored.map((r) => r.score))}
            </p>
          )}
        </div>

        {/* Itch & comfort */}
        <div className={card}>
          <h3 className="text-sm font-semibold">Itch &amp; comfort</h3>
          <p className="text-xs text-zinc-500">
            Scratching and restless nights together. Both up at once is a common sign of skin or allergy flare-ups.
          </p>
          <p className="mt-2 min-h-[2.5rem] text-sm">
            {ci !== null && comfort[ci].level !== "unknown" ? (
              <>
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${BADGE_STYLE[comfort[ci].level]}`}>
                  {dayLabel(days[ci])}
                </span>{" "}
                {comfort[ci].level === "normal"
                  ? "scratching and sleep within their usual range"
                  : comfort[ci].level === "one"
                    ? `${offText(comfort[ci].off[0])} on its own`
                    : `up together: ${comfort[ci].off.map(offText).join(", ")}`}
              </>
            ) : (
              <span className="text-zinc-500">
                {sel !== null ? `${dayLabel(days[sel])}: not enough scratching data that day` : "Not enough scratching data yet."}
              </span>
            )}
          </p>
          <Scrub count={n} active={sel} onActive={setSel} className="mt-2 flex h-7 gap-px">
            {comfort.map((d) => (
              <div key={d.date} className={`flex-1 ${n <= 31 ? "rounded-sm" : ""} ${LEVEL_STYLE[d.level]}`} />
            ))}
          </Scrub>
          <Axis days={days} />
        </div>

        {/* Long-term */}
        <div className={card}>
          <h3 className="text-sm font-semibold">Long-term heart &amp; breathing</h3>
          <p className="text-xs text-zinc-500">
            Slow drift that the day-to-day alerts are built not to see: their typical level over the last 3
            months (leaving out the most recent 3 weeks) vs a year earlier.
          </p>
          <ul className="mt-2 space-y-3 text-sm">
            {p.longTerm.map((m) => (
              <LongTermRow key={m.label} {...m} />
            ))}
          </ul>
          <p className="mt-1 text-[10px] text-zinc-400">
            Monthly medians, all history. A slow rise in resting breathing is worth mentioning at a routine vet visit.
          </p>
        </div>

        {/* Context */}
        {p.context.length > 0 && (
          <div className={`${card} md:col-span-2`}>
            <h3 className="text-sm font-semibold">Context in this view</h3>
            <p className="text-xs text-zinc-500">From the journal: things that may explain the readings above.</p>
            <ul className="mt-2 space-y-1 text-sm">
              {p.context.map((e, i) => (
                <li key={i} className="flex flex-wrap gap-2">
                  <span className="text-zinc-400">
                    {dayLabel(e.date)}
                    {e.end_date ? ` – ${dayLabel(e.end_date)}` : ""}
                  </span>
                  <span className="rounded bg-amber-100 px-1.5 text-xs leading-5 text-amber-800 dark:bg-amber-900 dark:text-amber-100">
                    {e.category}
                  </span>
                  <span>{e.note}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function ContextDots({ hasContext }: { hasContext: boolean[] }) {
  if (!hasContext.some(Boolean)) return null;
  return (
    <div className="mt-0.5 flex h-1.5 gap-px">
      {hasContext.map((c, i) => (
        <div key={i} className={`flex-1 ${c ? "bg-amber-400" : ""}`} />
      ))}
    </div>
  );
}

function LongTermRow({
  label,
  unit,
  trend,
  months,
}: {
  label: string;
  unit: string;
  trend: LongTrend | null;
  months: MonthPoint[];
}) {
  const [sel, setSel] = useState<number | null>(null);
  const vals = months.map((m) => m.median);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  return (
    <li>
      <div className="min-h-[1.25rem]">
        <b>{label}</b>:{" "}
        {sel !== null ? (
          <>
            {monthLabel(months[sel].month)}: typical {fmt(months[sel].median)} {unit}{" "}
            <span className="text-zinc-500">({months[sel].days} days of data)</span>
          </>
        ) : trend ? (
          <>
            {fmt(trend.recent)} {unit} now vs {fmt(trend.earlier)} {unit} {trend.earlierLabel}{" "}
            <span className={trend.direction === "flat" ? "text-zinc-500" : "font-medium text-amber-700 dark:text-amber-400"}>
              ({trend.direction === "flat" ? "steady" : `${trend.change > 0 ? "+" : ""}${fmt(trend.change)} ${trend.direction}`})
            </span>
          </>
        ) : (
          <span className="text-zinc-500">needs a few more months of data</span>
        )}
      </div>
      {months.length > 1 && (
        <>
          <Scrub count={months.length} active={sel} onActive={setSel} className="mt-1 flex h-12 items-end gap-0.5">
            {months.map((m) => (
              <div
                key={m.month}
                style={{ height: `${20 + ((m.median - lo) / span) * 80}%` }}
                className="flex-1 rounded-sm bg-indigo-300 dark:bg-indigo-700"
              />
            ))}
          </Scrub>
          <div className="mt-0.5 flex justify-between text-[10px] text-zinc-400">
            <span>{monthLabel(months[0].month)}</span>
            <span>
              range {fmt(lo)}–{fmt(hi)} {unit}
            </span>
            <span>{monthLabel(months[months.length - 1].month)}</span>
          </div>
        </>
      )}
    </li>
  );
}
