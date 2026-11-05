"use client";

import { useActionState } from "react";
import { logNote, logWeight, type LogResult } from "@/app/log-actions";

const input =
  "mt-1 block rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800";
const button =
  "rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50";

/**
 * Hand-entered weight and dated notes.
 *
 * Both fill gaps no tracker can. Weight is what vets ask about and almost no
 * collar measures; a note is what makes a chart interpretable a year later,
 * when "activity dropped in March" is otherwise just a mystery.
 */
export default function QuickLog({ petId, weightUnit }: { petId: string; weightUnit: string }) {
  const [weightResult, weightAction, weightPending] = useActionState<LogResult, FormData>(logWeight, null);
  const [noteResult, noteAction, notePending] = useActionState<LogResult, FormData>(logNote, null);

  const feedback = (r: LogResult) =>
    r && (
      <span className={`text-xs ${r.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
        {r.message}
      </span>
    );

  return (
    <div className="flex flex-wrap items-end gap-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <form action={weightAction} className="flex items-end gap-2">
        <input type="hidden" name="pet_id" value={petId} />
        <label className="text-xs text-zinc-500">
          Log weight ({weightUnit})
          <input name="weight" type="number" step="0.1" min="0" className={`${input} w-24`} />
        </label>
        <button disabled={weightPending} className={button}>
          {weightPending ? "Saving…" : "Save"}
        </button>
        {feedback(weightResult)}
      </form>

      <form action={noteAction} className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
        <input type="hidden" name="pet_id" value={petId} />
        <label className="text-xs text-zinc-500">
          Note
          <select name="category" className={input} defaultValue="note">
            <option value="note">Note</option>
            <option value="symptom">Symptom</option>
            <option value="vet">Vet visit</option>
            <option value="medication">Medication</option>
            <option value="food">Food change</option>
          </select>
        </label>
        <input
          name="note"
          placeholder="e.g. started new food, limping after the park…"
          className={`${input} min-w-0 flex-1 basis-40`}
        />
        <button disabled={notePending} className={button}>
          {notePending ? "Adding…" : "Add"}
        </button>
        {feedback(noteResult)}
      </form>
    </div>
  );
}
