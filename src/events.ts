import type { DatabaseSync } from "node:sqlite";
import { markStaleNotified, queueEvent } from "./db.ts";
import type { Diff } from "./diff.ts";
import type { IssueRow, LinkRow } from "./types.ts";

/** Diffs on the issue itself. */
export function emitIssueEvents(
  db: DatabaseSync,
  repoId: number,
  issueNumber: number,
  diffs: Diff[],
): void {
  for (const d of diffs) {
    switch (d.kind) {
      case "new":
        queueEvent(db, repoId, issueNumber, "issue_opened");
        break;
      case "closed":
        queueEvent(db, repoId, issueNumber, "issue_closed", { reason: d.reason });
        break;
      case "reopened":
        queueEvent(db, repoId, issueNumber, "issue_opened", { reopened: true });
        break;
      case "reason_changed":
        queueEvent(db, repoId, issueNumber, "issue_closed", { reason: d.to, amended: true });
        break;
      case "labels":
        // Label churn updates the embed but is not itself worth a fresh post;
        // delivery folds it into the existing message.
        queueEvent(db, repoId, issueNumber, "issue_opened", {
          labels: true,
          added: d.added,
          removed: d.removed,
        });
        break;
    }
  }
}

/**
 * Diffs on the attached PRs. Compares the link rows from before resolution
 * against the ones after, so a PR that merely got re-observed emits nothing.
 *
 * race_warning is the point of the whole system: an external PR turning up on
 * an issue you had already claimed.
 */
export function emitLinkEvents(
  db: DatabaseSync,
  repoId: number,
  issue: IssueRow | undefined,
  before: LinkRow[],
  after: LinkRow[],
): void {
  const prev = new Map(before.map((l) => [l.pr_number, l]));

  for (const link of after) {
    const was = prev.get(link.pr_number);

    if (!was) {
      queueEvent(db, repoId, link.issue_number, "pr_opened_for_issue", {
        pr: link.pr_number,
        author: link.author,
        attribution: link.attribution,
        draft: Boolean(link.draft),
      });

      if (link.attribution === "external" && issue?.claimed_by) {
        queueEvent(db, repoId, link.issue_number, "race_warning", {
          pr: link.pr_number,
          author: link.author,
          claimed_by: issue.claimed_by,
        });
      }
    }

    if (link.merged && !was?.merged) {
      queueEvent(db, repoId, link.issue_number, "pr_merged", {
        pr: link.pr_number,
        author: link.author,
        attribution: link.attribution,
      });
    } else if (
      link.pr_state === "closed" &&
      !link.merged &&
      was?.pr_state !== "closed"
    ) {
      queueEvent(db, repoId, link.issue_number, "pr_closed_unmerged", {
        pr: link.pr_number,
        author: link.author,
      });
    }
  }
}

/**
 * Sweep for issues open with no activity for `staleDays`. Computed, not diffed —
 * nothing arrives from GitHub to trigger it. stale_notified_at guards against
 * re-emitting every cycle; it is cleared whenever the issue sees real activity.
 */
export function sweepStale(
  db: DatabaseSync,
  staleDays: number,
): number {
  const rows = db
    .prepare(
      `SELECT repo_id, number FROM issues
        WHERE state = 'open'
          AND updated_at < datetime('now', ?)
          AND (stale_notified_at IS NULL OR stale_notified_at < updated_at)`,
    )
    .all(`-${staleDays} days`) as unknown as Array<{ repo_id: number; number: number }>;

  for (const r of rows) {
    queueEvent(db, r.repo_id, r.number, "stale", { days: staleDays });
    markStaleNotified(db, r.repo_id, r.number);
  }
  return rows.length;
}
