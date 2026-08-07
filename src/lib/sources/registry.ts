/**
 * Which sources are enabled, and the gate in front of the risky one.
 *
 * A source whose `risk` is not "none" cannot be enabled by configuration alone.
 * It requires a recorded acknowledgement naming what the user accepted, so that
 * turning on vendor API access is a deliberate act with a date attached rather
 * than a side effect of filling in a form.
 */

import { sql } from "../db";
import { CSV_SOURCE_INFO } from "./csv";
import type { Source, SourceInfo } from "./types";

export const TRACTIVE_SOURCE_INFO: SourceInfo = {
  id: "tractive",
  label: "Tractive account",
  description: "Reads your own account through the same private API the vendor's web app uses.",
  risk: "vendor-terms",
  advisory: `Tractive's Terms of Service, section 5.8, say:

"In case a user interferes with the operation of the services through manipulation of the software, proprietary software or gains automated access to the Tractive software … Tractive is entitled to cancel the services immediately and terminate the subscription plan or contractual relationship without notice. A claim for reimbursement for already paid service fees cannot be made in this case."

The same section covers accessing device data "via means other than those made available to the user".

Plainly: enabling this may get your subscription terminated with no refund, on a device you may rely on to find your pet. That is your decision to make. This project is not affiliated with Tractive.

If you are in the EU, the Data Act export is the vendor's own supported route and carries none of this risk.`,
};

export const KNOWN_SOURCES: SourceInfo[] = [CSV_SOURCE_INFO, TRACTIVE_SOURCE_INFO];

export function sourceInfo(id: string): SourceInfo | undefined {
  return KNOWN_SOURCES.find((s) => s.id === id);
}

export interface Acknowledgement {
  sourceId: string;
  acceptedAt: string;
  /** The exact text that was shown, so what was agreed to is recoverable. */
  advisoryShown: string;
}

/**
 * Record that the user accepted a source's advisory.
 *
 * The advisory text is stored alongside the timestamp: if the terms are later
 * reworded, what was actually agreed to is still on file.
 */
export async function recordAcknowledgement(sourceId: string): Promise<void> {
  const info = sourceInfo(sourceId);
  if (!info?.advisory) throw new Error(`${sourceId} has no advisory to acknowledge`);
  const ack: Acknowledgement = {
    sourceId,
    acceptedAt: new Date().toISOString(),
    advisoryShown: info.advisory,
  };
  await sql()`insert into app_config (key, value) values (${`ack:${sourceId}`}, ${JSON.stringify(ack)})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

export async function acknowledgementFor(sourceId: string): Promise<Acknowledgement | null> {
  const [row] = await sql()`select value from app_config where key = ${`ack:${sourceId}`}`;
  if (!row) return null;
  try {
    return JSON.parse(String(row.value)) as Acknowledgement;
  } catch {
    return null;
  }
}

/**
 * Whether a source may run.
 *
 * Risky sources need both the enable flag AND a recorded acknowledgement.
 * Requiring only the flag would let the gate be bypassed by anything that
 * writes config — including a future settings page written without this in
 * mind.
 */
export async function isEnabled(sourceId: string): Promise<boolean> {
  const info = sourceInfo(sourceId);
  if (!info) return false;
  const [row] = await sql()`select value from app_config where key = ${`source:${sourceId}:enabled`}`;
  if (row?.value !== "true") return false;
  if (info.risk === "none") return true;
  return (await acknowledgementFor(sourceId)) !== null;
}

export async function setEnabled(sourceId: string, enabled: boolean): Promise<void> {
  await sql()`insert into app_config (key, value) values (${`source:${sourceId}:enabled`}, ${enabled ? "true" : "false"})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/**
 * Build the sources that are enabled and can run unattended.
 *
 * CSV is deliberately excluded: it is a file the user uploads, not something a
 * scheduled job can go and fetch.
 */
export async function scheduledSources(): Promise<Source[]> {
  const out: Source[] = [];
  if (await isEnabled("tractive")) {
    const { TractiveSource } = await import("./tractive");
    const source = await TractiveSource.fromStoredCredentials();
    if (source) out.push(source);
  }
  return out;
}
