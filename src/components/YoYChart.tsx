"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import type { YoYRow } from "@/lib/trends";

export default function YoYChart({
  title,
  unit,
  rows,
}: {
  title: string;
  unit: string;
  rows: YoYRow[];
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">
        {title} <span className="font-normal text-zinc-400">({unit}) — this year vs last</span>
      </h3>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
          <XAxis dataKey="md" tick={{ fontSize: 10 }} minTickGap={40} />
          <YAxis tick={{ fontSize: 10 }} domain={["auto", "auto"]} />
          <Tooltip
            formatter={(v, name) => [`${Number(v).toFixed(1)} ${unit}`, name === "thisYear" ? "this year" : "last year"]}
            labelStyle={{ fontSize: 11 }}
            contentStyle={{ fontSize: 11 }}
          />
          <Legend formatter={(v) => (v === "thisYear" ? "this year" : "last year")} wrapperStyle={{ fontSize: 11 }} />
          <Line dataKey="lastYear" stroke="#a1a1aa" strokeDasharray="4 3" dot={false} strokeWidth={1.5} connectNulls isAnimationActive={false} />
          <Line dataKey="thisYear" stroke="#4f46e5" dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
