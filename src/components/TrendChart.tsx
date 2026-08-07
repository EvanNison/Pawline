"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BandPoint } from "@/lib/chart";

/**
 * One metric over time, with its learned "usual range" behind it.
 *
 * Low-wear days are shaded rather than hidden: the reading happened, it just
 * cannot be compared with days the collar was on. Hiding them would leave an
 * unexplained gap; plotting them unmarked would invite a false conclusion.
 */
export default function TrendChart({
  title,
  unit,
  points,
  help,
}: {
  title: string;
  unit: string;
  points: BandPoint[];
  help?: string;
}) {
  const anyLowWear = points.some((p) => p.lowWear);
  return (
    <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
      <h3 className="text-sm font-semibold">
        {title} {unit && <span className="font-normal text-zinc-500">({unit})</span>}
        {anyLowWear && (
          <span className="ml-2 text-xs font-normal text-zinc-500">
            shaded = tracker worn too little to count
          </span>
        )}
      </h3>
      {help && <p className="mt-0.5 text-xs text-zinc-500">{help}</p>}
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-zinc-200 dark:stroke-zinc-800" />
          <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
          <YAxis tick={{ fontSize: 10 }} width={44} />
          <Tooltip
            contentStyle={{ fontSize: 12 }}
            formatter={(v, name) =>
              v === null || v === undefined
                ? ["—", String(name)]
                : [`${v} ${unit}`.trim(), String(name)]
            }
          />
          {points.map((p) =>
            p.lowWear ? (
              <ReferenceArea key={p.date} x1={p.date} x2={p.date} fill="#a1a1aa" fillOpacity={0.18} />
            ) : null
          )}
          <Area dataKey="baseHigh" stroke="none" fill="#6366f1" fillOpacity={0.12} isAnimationActive={false} connectNulls />
          <Area dataKey="baseLow" stroke="none" fill="var(--background)" fillOpacity={1} isAnimationActive={false} connectNulls />
          <Line dataKey="baseMid" stroke="#6366f1" strokeDasharray="4 4" strokeOpacity={0.5} dot={false} isAnimationActive={false} connectNulls />
          <Line dataKey="value" stroke="#4f46e5" strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
