import type { DatabaseSync } from "node:sqlite";
import { deactivateLink, getLinks, upsertLink } from "./db.ts";
import {
  getPull,
  getTimeline,
  searchPullsMentioning,
  type Client,
} from "./github.ts";
import type { LinkKind, LinkRow } from "./types.ts";

const CLOSES_RE = /\b(?:fix|close|resolve)(?:s|d|es|ed)?\s+#(\d+)/gi;

/** Scan a PR body for "fixes #123" style references. Fallback when the timeline is silent. */
export function parseClosingRefs(body: string | null | undefined): number[] {
  if (!body) return [];
  return [...body.matchAll(CLOSES_RE)].map((m) => Number(m[1]));
}

interface Candidate {
  pr: number;
  kind: LinkKind;
}

/**
 * Read the timeline for one issue and work out which PRs are attached to it.
 *
 * Three signals, in descending trustworthiness:
 *   connected / disconnected  — explicit, user-asserted issue<->PR link
 *   cross-referenced          — a PR mentioned this issue (source.issue is a PR)
 *   closed w/ commit_id       — what actually closed it; we resolve the commit
 *                               back to its PR
 * `disconnected` retires a link rather than adding one, so it is applied last.
 */
export async function resolveLinks(
  gh: Client,
  db: DatabaseSync,
  repoId: number,
  owner: string,
  repo: string,
  issueNumber: number,
  handle: string,
  /** Numbers cited in the issue's comments; see CommentSummary.mentions. */
  mentions: number[] = [],
): Promise<LinkRow[]> {
  const timeline = await getTimeline(gh, owner, repo, issueNumber);
  const candidates = new Map<number, Candidate>();
  const disconnected = new Set<number>();
  const slug = `${owner}/${repo}`.toLowerCase();

  /**
   * Cross-references routinely arrive from *other* repos — a popular library
   * gets referenced by every downstream project. Those PR numbers are
   * meaningless in our namespace and 404 when fetched, so drop them.
   */
  const sameRepo = (src: { repository?: { full_name?: string } } | undefined) =>
    !src?.repository?.full_name ||
    src.repository.full_name.toLowerCase() === slug;

  const remember = (pr: number, kind: LinkKind) => {
    if (!pr || pr === issueNumber) return;
    const prev = candidates.get(pr);
    if (!prev || rank(kind) > rank(prev.kind)) candidates.set(pr, { pr, kind });
  };

  for (const ev of timeline) {
    const event = ev.event as string;

    if (event === "cross-referenced") {
      const src = (
        ev.source as {
          issue?: {
            number?: number;
            pull_request?: unknown;
            repository?: { full_name?: string };
          };
        }
      )?.issue;
      // Only PRs matter here; a plain issue mentioning this one is noise.
      if (src?.pull_request && src.number && sameRepo(src)) {
        remember(src.number, "cross_referenced");
      }
    } else if (event === "connected") {
      const n = subjectNumber(ev);
      if (n) remember(n, "connected");
    } else if (event === "disconnected") {
      const n = subjectNumber(ev);
      if (n) disconnected.add(n);
    } else if (event === "closed" && typeof ev.commit_id === "string") {
      const pr = await prForCommit(gh, owner, repo, ev.commit_id);
      if (pr) remember(pr, "closing_commit");
    }
  }

  // Numbers people cited in the thread. Each is only a candidate -- getPull
  // below 404s on anything that is not a PR in this repo, which filters out
  // references to sibling issues without costing us a separate check.
  for (const n of mentions) remember(n, "comment_ref");

  // Fallback: some repos close issues from PRs that were never formally linked
  // and whose cross-reference never fired. Only pay for the search when the
  // timeline gave us nothing at all.
  if (candidates.size === 0) {
    for (const cand of await searchPullsMentioning(gh, owner, repo, issueNumber)) {
      if (parseClosingRefs(cand.body).includes(issueNumber)) {
        remember(cand.number, "body_regex");
      }
    }
  }

  for (const { pr, kind } of candidates.values()) {
    if (disconnected.has(pr)) continue;
    const detail = await getPull(gh, owner, repo, pr).catch(() => null);
    // Unfetchable means it isn't a PR in this repo (deleted, or a stray
    // reference). Storing a link we know nothing about only creates noise.
    if (!detail) continue;
    const author = detail.user?.login ?? null;
    upsertLink(db, {
      repo_id: repoId,
      issue_number: issueNumber,
      pr_number: pr,
      kind,
      pr_state: (detail.state as "open" | "closed") ?? null,
      draft: detail.draft ? 1 : 0,
      merged: detail.merged_at ? 1 : 0,
      author,
      attribution: author
        ? author.toLowerCase() === handle.toLowerCase()
          ? "mine"
          : "external"
        : null,
    });
  }

  for (const pr of disconnected) deactivateLink(db, repoId, issueNumber, pr);

  return getLinks(db, repoId, issueNumber);
}

const RANKS: Record<LinkKind, number> = {
  connected: 3,
  closing_commit: 2,
  cross_referenced: 1,
  body_regex: 0,
  comment_ref: 0,
};
const rank = (k: LinkKind) => RANKS[k];

/**
 * `connected`/`disconnected` payloads are inconsistent across API versions —
 * the PR number turns up under a few different keys. Try each.
 */
function subjectNumber(ev: Record<string, unknown>): number | undefined {
  const src = ev.source as { issue?: { number?: number } } | undefined;
  const subj = ev.subject as { number?: number } | undefined;
  return (
    subj?.number ??
    src?.issue?.number ??
    (ev.issue as { number?: number } | undefined)?.number
  );
}

/** A commit that closed an issue usually belongs to a PR; ask which. */
async function prForCommit(
  gh: Client,
  owner: string,
  repo: string,
  sha: string,
): Promise<number | undefined> {
  try {
    const { data } = await gh.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: sha,
    });
    return data[0]?.number;
  } catch {
    return undefined; // direct push, or the commit is gone — not a link
  }
}
