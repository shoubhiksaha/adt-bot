/** One turn's file changes, as the desktop side lists them (electron/rewind.cjs). */
export type TurnChanges = {
  turn: string;
  at: number;
  files: { path: string; change: "created" | "modified" | "deleted"; changedSince: boolean; restorable: boolean }[];
};

/** What undoing a turn did. */
export type RewindResult = { restored: string[]; removed: string[]; conflicts: string[]; refused: string[]; unsaved: string[]; failed?: string[] };

/** "notes.md (modified), draft.txt (created)". */
export function describeChanges(files: TurnChanges["files"]): string {
  return files.map((f) => `${f.path} (${f.change}${f.changedSince ? ", changed since" : ""}${f.restorable ? "" : ", too big to restore"})`).join(", ");
}

/** What an undo did, in a sentence or two. */
export function describeRewind(r: RewindResult): string {
  const parts = [
    r.restored.length ? `Restored ${r.restored.join(", ")}.` : "",
    r.removed.length ? `Deleted ${r.removed.join(", ")} (created by the bot).` : "",
    r.conflicts.length ? `Left alone because they changed after the bot changed them: ${r.conflicts.join(", ")}.` : "",
    r.refused.length ? `Not allowed in Sandbox mode (outside the workspace): ${r.refused.join(", ")}.` : "",
    r.unsaved.length ? `Too big to have been kept: ${r.unsaved.join(", ")}.` : "",
    r.failed?.length ? `Couldn't undo: ${r.failed.join(", ")}.` : "",
  ].filter(Boolean);
  return parts.join(" ") || "There was nothing to undo.";
}
