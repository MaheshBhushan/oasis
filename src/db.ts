import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EventRow,
  EventType,
  IssueRow,
  IssueUpsert,
  LinkRow,
  LinkUpsert,
  RepoRow,
} from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // Two processes share this file: the poller writes, the bot reads and stamps
  // deliveries. WAL lets them do that concurrently; busy_timeout absorbs the
  // brief writer overlap instead of throwing SQLITE_BUSY at whoever loses.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  return db;
}

/* ---------------------------------------------------------------- repos --- */

export function addRepo(db: DatabaseSync, owner: string, name: string): RepoRow {
  db.prepare(
    "INSERT OR IGNORE INTO repos (owner, name) VALUES (?, ?)",
  ).run(owner, name);
  return getRepo(db, owner, name)!;
}

export function getRepo(
  db: DatabaseSync,
  owner: string,
  name: string,
): RepoRow | undefined {
  return db
    .prepare("SELECT * FROM repos WHERE owner = ? AND name = ?")
    .get(owner, name) as RepoRow | undefined;
}

export function listRepos(db: DatabaseSync): RepoRow[] {
  return db
    .prepare("SELECT * FROM repos ORDER BY owner, name")
    .all() as unknown as RepoRow[];
}

export function removeRepo(db: DatabaseSync, owner: string, name: string): boolean {
  const r = db
    .prepare("DELETE FROM repos WHERE owner = ? AND name = ?")
    .run(owner, name);
  return r.changes > 0;
}

/**
 * Advance the sync cursor. `lastSync` is the max issue.updated_at we actually
 * processed, never `now()` — using wall-clock here would skip any issue updated
 * between the request and the write.
 */
export function setSyncState(
  db: DatabaseSync,
  repoId: number,
  lastSync: string | null,
  etag: string | null,
): void {
  db.prepare(
    "UPDATE repos SET last_sync = COALESCE(?, last_sync), etag = COALESCE(?, etag) WHERE id = ?",
  ).run(lastSync, etag, repoId);
}

/* --------------------------------------------------------------- issues --- */

export function getIssue(
  db: DatabaseSync,
  repoId: number,
  number: number,
): IssueRow | undefined {
  return db
    .prepare("SELECT * FROM issues WHERE repo_id = ? AND number = ?")
    .get(repoId, number) as IssueRow | undefined;
}

/**
 * Insert or update the tracked fields. Deliberately leaves message_id, claim
 * columns and stale_notified_at alone — those are ours, not GitHub's, and a
 * poll must never clobber them.
 */
export function upsertIssue(db: DatabaseSync, row: IssueUpsert): void {
  db.prepare(
    `INSERT INTO issues
       (repo_id, number, title, state, state_reason, labels_json, author,
        html_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, number) DO UPDATE SET
       title        = excluded.title,
       state        = excluded.state,
       state_reason = excluded.state_reason,
       labels_json  = excluded.labels_json,
       author       = excluded.author,
       html_url     = excluded.html_url,
       updated_at   = excluded.updated_at`,
  ).run(
    row.repo_id,
    row.number,
    row.title,
    row.state,
    row.state_reason,
    row.labels_json,
    row.author,
    row.html_url,
    row.created_at,
    row.updated_at,
  );
}

export function listIssues(db: DatabaseSync, repoId?: number): IssueRow[] {
  const sql = repoId
    ? "SELECT * FROM issues WHERE repo_id = ? ORDER BY updated_at DESC"
    : "SELECT * FROM issues ORDER BY updated_at DESC";
  const stmt = db.prepare(sql);
  return (repoId ? stmt.all(repoId) : stmt.all()) as unknown as IssueRow[];
}

export function setMessageId(
  db: DatabaseSync,
  repoId: number,
  number: number,
  messageId: string | null,
): void {
  db.prepare(
    "UPDATE issues SET message_id = ? WHERE repo_id = ? AND number = ?",
  ).run(messageId, repoId, number);
}

export function claimIssue(
  db: DatabaseSync,
  repoId: number,
  number: number,
  who: string | null,
): void {
  db.prepare(
    `UPDATE issues SET claimed_by = ?, claimed_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END
     WHERE repo_id = ? AND number = ?`,
  ).run(who, who, repoId, number);
}

export function markStaleNotified(
  db: DatabaseSync,
  repoId: number,
  number: number,
): void {
  db.prepare(
    "UPDATE issues SET stale_notified_at = datetime('now') WHERE repo_id = ? AND number = ?",
  ).run(repoId, number);
}

/* ---------------------------------------------------------------- links --- */

/** Idempotent on (repo, issue, pr, kind) so re-polling can't duplicate a link. */
export function upsertLink(db: DatabaseSync, row: LinkUpsert): void {
  db.prepare(
    `INSERT INTO links
       (repo_id, issue_number, pr_number, kind, pr_state, draft, merged, author, attribution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo_id, issue_number, pr_number, kind) DO UPDATE SET
       pr_state    = COALESCE(excluded.pr_state, pr_state),
       draft       = COALESCE(excluded.draft, draft),
       merged      = COALESCE(excluded.merged, merged),
       author      = COALESCE(excluded.author, author),
       attribution = COALESCE(excluded.attribution, attribution),
       active      = 1`,
  ).run(
    row.repo_id,
    row.issue_number,
    row.pr_number,
    row.kind,
    row.pr_state ?? null,
    row.draft ?? null,
    row.merged ?? null,
    row.author ?? null,
    row.attribution ?? null,
  );
}

/** A `disconnected` timeline event retires the link but keeps it for history. */
export function deactivateLink(
  db: DatabaseSync,
  repoId: number,
  issueNumber: number,
  prNumber: number,
): void {
  db.prepare(
    "UPDATE links SET active = 0 WHERE repo_id = ? AND issue_number = ? AND pr_number = ?",
  ).run(repoId, issueNumber, prNumber);
}

export function getLinks(
  db: DatabaseSync,
  repoId: number,
  issueNumber: number,
  activeOnly = true,
): LinkRow[] {
  const sql = `SELECT * FROM links WHERE repo_id = ? AND issue_number = ?${
    activeOnly ? " AND active = 1" : ""
  } ORDER BY pr_number`;
  return db.prepare(sql).all(repoId, issueNumber) as unknown as LinkRow[];
}

/* --------------------------------------------------------------- events --- */

export function queueEvent(
  db: DatabaseSync,
  repoId: number,
  issueNumber: number,
  type: EventType,
  payload: Record<string, unknown> = {},
): void {
  db.prepare(
    "INSERT INTO events (repo_id, issue_number, type, payload_json) VALUES (?, ?, ?, ?)",
  ).run(repoId, issueNumber, type, JSON.stringify(payload));
}

export function pendingEvents(db: DatabaseSync, limit = 100): EventRow[] {
  return db
    .prepare(
      "SELECT * FROM events WHERE delivered_at IS NULL ORDER BY id LIMIT ?",
    )
    .all(limit) as unknown as EventRow[];
}

/** Stamped only after Discord confirms — see the note on events.delivered_at. */
export function markDelivered(db: DatabaseSync, ids: number[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(
    "UPDATE events SET delivered_at = datetime('now') WHERE id = ?",
  );
  for (const id of ids) stmt.run(id);
}
