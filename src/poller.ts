import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { loadConfig, type Config } from "./config.ts";
import {
  getIssue,
  getLinks,
  listRepos,
  openDb,
  setSyncState,
  upsertIssue,
} from "./db.ts";
import { diffIssue, touchesState } from "./diff.ts";
import { emitIssueEvents, emitLinkEvents, sweepStale } from "./events.ts";
import {
  isPullRequest,
  labelNames,
  listIssues,
  makeClient,
  NOT_MODIFIED,
  rateRemaining,
  type Client,
  type RawIssue,
} from "./github.ts";
import { resolveLinks } from "./links.ts";
import type { RepoRow } from "./types.ts";

export interface CycleReport {
  repo: string;
  skipped304: boolean;
  scanned: number;
  changed: number;
}

/**
 * Poll one repo. Silent mode is used by /watch's first backfill: rows are
 * seeded and the cursor advances, but no events are queued — otherwise
 * registering a busy repo would dump hundreds of messages into the channel.
 */
export async function pollRepo(
  gh: Client,
  db: DatabaseSync,
  cfg: Config,
  repo: RepoRow,
  silent = false,
): Promise<CycleReport> {
  const slug = `${repo.owner}/${repo.name}`;
  const result = await listIssues(gh, repo.owner, repo.name, repo.last_sync, repo.etag);

  if (result === NOT_MODIFIED) {
    return { repo: slug, skipped304: true, scanned: 0, changed: 0 };
  }

  // The list endpoint returns PRs too; they are not issues we track.
  const issues = result.items.filter((i: RawIssue) => !isPullRequest(i));
  let changed = 0;
  let maxUpdated = repo.last_sync;

  for (const raw of issues) {
    const stored = getIssue(db, repo.id, raw.number);
    const diffs = diffIssue(stored, raw, cfg.watchedLabels);

    upsertIssue(db, {
      repo_id: repo.id,
      number: raw.number,
      title: raw.title,
      state: raw.state,
      state_reason: raw.state_reason ?? null,
      labels_json: JSON.stringify(labelNames(raw)),
      author: raw.user?.login ?? null,
      html_url: raw.html_url,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
    });

    if (!maxUpdated || raw.updated_at > maxUpdated) maxUpdated = raw.updated_at;
    if (diffs.length === 0) continue;
    changed++;
    if (silent) continue;

    emitIssueEvents(db, repo.id, raw.number, diffs);

    if (diffs.some(touchesState)) {
      const before = getLinks(db, repo.id, raw.number);
      const after = await resolveLinks(
        gh,
        db,
        repo.id,
        repo.owner,
        repo.name,
        raw.number,
        cfg.githubHandle,
      );
      emitLinkEvents(db, repo.id, getIssue(db, repo.id, raw.number), before, after);
    }
  }

  // Cursor comes from the data, never from wall-clock: anything updated between
  // the request and this write would otherwise be skipped forever.
  setSyncState(db, repo.id, maxUpdated, result.etag);
  return { repo: slug, skipped304: false, scanned: issues.length, changed };
}

export async function runCycle(db: DatabaseSync, cfg: Config): Promise<CycleReport[]> {
  const gh = makeClient(cfg.githubToken);
  const reports: CycleReport[] = [];

  for (const repo of listRepos(db)) {
    try {
      reports.push(await pollRepo(gh, db, cfg, repo));
    } catch (e) {
      console.error(`[poll] ${repo.owner}/${repo.name} failed:`, e);
    }
  }

  const staleCount = sweepStale(db, cfg.staleDays);
  if (staleCount) console.log(`[poll] queued ${staleCount} stale events`);

  const remaining = await rateRemaining(gh);
  applyBackoff(cfg, remaining);
  return reports;
}

/* -------------------------------------------------------------- backoff --- */

const backoffFile = (cfg: Config) => `${cfg.dbPath}.backoff`;
const BASE_BACKOFF_MIN = 15;
const MAX_BACKOFF_MIN = 120;

/**
 * The systemd timer fires on a fixed interval; widening it from inside a
 * one-shot process isn't possible, so the poller gates itself instead. When the
 * rate limit is healthy the gate is absent and every firing runs.
 */
export function shouldSkipForBackoff(cfg: Config): number | null {
  try {
    const { until } = JSON.parse(readFileSync(backoffFile(cfg), "utf8")) as {
      until: string;
    };
    const ms = Date.parse(until) - Date.now();
    return ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

function applyBackoff(cfg: Config, remaining: number): void {
  const path = backoffFile(cfg);
  if (remaining >= cfg.rateLimitFloor) {
    rmSync(path, { force: true });
    return;
  }
  let minutes = BASE_BACKOFF_MIN;
  try {
    const prev = JSON.parse(readFileSync(path, "utf8")) as { minutes?: number };
    minutes = Math.min((prev.minutes ?? BASE_BACKOFF_MIN) * 2, MAX_BACKOFF_MIN);
  } catch {
    /* first backoff */
  }
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  writeFileSync(path, JSON.stringify({ minutes, until, remaining }));
  console.warn(
    `[poll] rate limit low (${remaining} < ${cfg.rateLimitFloor}); pausing ${minutes}m`,
  );
}

if (import.meta.filename === process.argv[1]) {
  const cfg = loadConfig();
  const waiting = shouldSkipForBackoff(cfg);
  if (waiting) {
    console.log(`[poll] backing off, ${Math.ceil(waiting / 60_000)}m left`);
    process.exit(0);
  }
  const db = openDb(cfg.dbPath);
  const reports = await runCycle(db, cfg);
  for (const r of reports) {
    console.log(
      r.skipped304
        ? `[poll] ${r.repo}: 304, skipped`
        : `[poll] ${r.repo}: ${r.scanned} scanned, ${r.changed} changed`,
    );
  }
  db.close();
}
