import type { IssueRow } from "./types.ts";
import { labelNames, type RawIssue } from "./github.ts";

export type Diff =
  | { kind: "new" }
  | { kind: "closed"; reason: string | null }
  | { kind: "reopened" }
  /** completed <-> not_planned on an already-closed issue. Not the same outcome. */
  | { kind: "reason_changed"; from: string | null; to: string | null }
  | { kind: "labels"; added: string[]; removed: string[] };

/**
 * Compare a freshly fetched issue against its stored row.
 *
 * Returns [] when nothing interesting changed — the caller still writes the row,
 * it just emits no events. GitHub's `since` is inclusive, so the boundary issue
 * comes back on every cycle and lands here as a no-op; that is the intended
 * dedupe point.
 */
export function diffIssue(
  stored: IssueRow | undefined,
  fresh: RawIssue,
  watchedLabels: string[],
): Diff[] {
  if (!stored) return [{ kind: "new" }];

  const diffs: Diff[] = [];
  const reason = fresh.state_reason ?? null;

  if (stored.state === "open" && fresh.state === "closed") {
    diffs.push({ kind: "closed", reason });
  } else if (stored.state === "closed" && fresh.state === "open") {
    diffs.push({ kind: "reopened" });
  } else if (fresh.state === "closed" && stored.state_reason !== reason) {
    // Still closed, but "closed as not planned" is not a fix — worth saying so.
    diffs.push({ kind: "reason_changed", from: stored.state_reason, to: reason });
  }

  const before = new Set(
    (JSON.parse(stored.labels_json) as string[]).map((l) => l.toLowerCase()),
  );
  const after = new Set(labelNames(fresh).map((l) => l.toLowerCase()));
  const watched = new Set(watchedLabels);
  const added = [...after].filter((l) => !before.has(l) && watched.has(l));
  const removed = [...before].filter((l) => !after.has(l) && watched.has(l));
  if (added.length || removed.length) diffs.push({ kind: "labels", added, removed });

  return diffs;
}

/** True when this diff warrants re-resolving issue<->PR links. */
export const touchesState = (d: Diff) =>
  d.kind === "new" || d.kind === "closed" || d.kind === "reopened";

/**
 * Drop "this is new" claims about issues that plainly are not.
 *
 * `new` above means *newly seen*, not *newly created* — there is no stored row.
 * Those are not the same thing. The `since` cursor returns any issue whose
 * updated_at moved, so a triage bot commenting on a year-old thread hands us an
 * issue we have never stored, and we announced it as freshly opened. On
 * openclaw that was 332 of 358 announcements in forty minutes: a wall of
 * two-month-old issues, none of them an opportunity.
 *
 * Only the "look at this, it just appeared" diffs are age-gated. Anything
 * describing a *transition* — closed, reopened, closed-reason amended — is
 * still worth hearing on an old issue, because the change genuinely happened
 * just now. PR link events are emitted elsewhere and are untouched by this.
 */
export function announceable(
  diffs: Diff[],
  createdAt: string,
  maxAgeHours: number,
  now = Date.now(),
): Diff[] {
  if (now - Date.parse(createdAt) <= maxAgeHours * 3_600_000) return diffs;
  return diffs.filter((d) => d.kind !== "new" && d.kind !== "labels");
}
