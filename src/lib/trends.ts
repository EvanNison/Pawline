import type { DayPoint } from "./baseline";
import { dayNum } from "./time";

/**
 * Trailing rolling average over a window of *calendar days*.
 *
 * Slicing array positions instead meant a "30-day average" spanned 45 calendar
 * days after a 15-day outage, quietly mixing pre-outage readings into a chart
 * labelled 30 days — which delays and dilutes a real decline.
 */
export function rollingAvg(series: DayPoint[], window = 30, min = 7): DayPoint[] {
  const days = series.map((p) => dayNum(p.date));
  const out: DayPoint[] = [];
  for (let i = 0; i < series.length; i++) {
    const from = days[i] - window + 1;
    let sum = 0;
    let n = 0;
    for (let j = i; j >= 0 && days[j] >= from; j--) {
      sum += series[j].value;
      n++;
    }
    if (n < min) continue;
    out.push({ date: series[i].date, value: Math.round((sum / n) * 10) / 10 });
  }
  return out;
}

/**
 * Night + day sleep, only for days where BOTH components exist.
 *
 * Summing whichever parts happen to be present reported a day with 240 minutes
 * of day sleep and no night reading as "240 minutes total sleep" — a badly low
 * number presented as a complete one, which then skewed averages and the
 * year-over-year flags in the vet report.
 */
export function totalSleepSeries(
  night: DayPoint[] | undefined,
  day: DayPoint[] | undefined
): DayPoint[] {
  if (!night?.length || !day?.length) return [];
  const dayByDate = new Map(day.map((p) => [p.date, p.value]));
  const out: DayPoint[] = [];
  for (const n of night) {
    const d = dayByDate.get(n.date);
    if (d === undefined) continue;
    out.push({ date: n.date, value: n.value + d });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface YoYRow {
  md: string; // MM-DD
  thisYear: number | null;
  lastYear: number | null;
}

/** Align the last 365 days against the 365 before, by month-day. */
export function buildYoY(series: DayPoint[], today: string): YoYRow[] {
  const t = new Date(`${today}T12:00:00Z`);
  const oneYearAgo = new Date(t);
  oneYearAgo.setUTCFullYear(t.getUTCFullYear() - 1);
  const cut = oneYearAgo.toISOString().slice(0, 10);

  const thisYear = new Map<string, number>();
  const lastYear = new Map<string, number>();
  for (const p of series) {
    const md = p.date.slice(5);
    if (md === "02-29") continue;
    if (p.date > cut) thisYear.set(md, p.value);
    else if (p.date > `${Number(cut.slice(0, 4)) - 1}${cut.slice(4)}`) lastYear.set(md, p.value);
  }

  const rows: YoYRow[] = [];
  // Walk the last 365 days in order so the x-axis starts a year ago.
  for (let i = 364; i >= 0; i--) {
    const d = new Date(t);
    d.setUTCDate(d.getUTCDate() - i);
    const md = d.toISOString().slice(5, 10);
    if (md === "02-29") continue;
    rows.push({
      md,
      thisYear: thisYear.get(md) ?? null,
      lastYear: lastYear.get(md) ?? null,
    });
  }
  return rows;
}

/** Percent change between two averages; null when either side is missing. */
export function pctChange(recent: number | null, prior: number | null): number | null {
  if (recent === null || prior === null || prior === 0) return null;
  return Math.round(((recent - prior) / prior) * 100);
}
