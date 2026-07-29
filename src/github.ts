import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";

const Client = Octokit.plugin(retry, throttling);

/** Returned instead of a payload when GitHub answers 304 to our If-None-Match. */
export const NOT_MODIFIED = Symbol("not-modified");

export interface IssueListResult {
  items: RawIssue[];
  etag: string | null;
}

export interface RawIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason?: string | null;
  labels: Array<string | { name?: string }>;
  user?: { login?: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  /** Present iff this "issue" is really a PR. The list endpoint returns both. */
  pull_request?: unknown;
}

export function makeClient(token: string) {
  return new Client({
    auth: token,
    userAgent: "issue-radar",
    throttle: {
      // Secondary/primary limit hits are retried by the plugin; we still do our
      // own floor check per cycle so the poller can widen its interval.
      onRateLimit: (retryAfter, options, _o, retryCount) =>
        retryCount < 2 && logRetry("rate limit", options, retryAfter),
      onSecondaryRateLimit: (retryAfter, options, _o, retryCount) =>
        retryCount < 2 && logRetry("secondary limit", options, retryAfter),
    },
    retry: { doNotRetry: [400, 401, 403, 404, 422] },
  });
}

function logRetry(kind: string, options: { method?: string; url?: string }, after: number) {
  console.warn(`[github] ${kind} on ${options.method} ${options.url}; retry in ${after}s`);
  return true;
}

export type Client = ReturnType<typeof makeClient>;

export async function repoExists(gh: Client, owner: string, repo: string) {
  try {
    await gh.repos.get({ owner, repo });
    return true;
  } catch (e: unknown) {
    if ((e as { status?: number }).status === 404) return false;
    throw e;
  }
}

/**
 * List issues updated since the cursor, replaying the stored ETag.
 *
 * Returns NOT_MODIFIED on 304 — the caller skips the repo entirely and burns no
 * rate limit. Note GitHub's `since` is inclusive on updated_at, so the boundary
 * issue comes back every cycle; dedupe at the diff, not here.
 *
 * ETags are keyed to the full URL, and `since` moves whenever a cycle actually
 * returns something — so the cycle right after a change can never 304. It is
 * the *second* consecutive quiet cycle onward that goes free. This is why the
 * cursor only advances on real data: pinning it to wall-clock time would change
 * the URL every cycle and defeat conditional requests entirely.
 *
 * The ETag only applies to page 1. When there are more pages we page through
 * without it and return the page-1 ETag, which is what a later 304 would key on.
 */
export async function listIssues(
  gh: Client,
  owner: string,
  repo: string,
  since: string | null,
  etag: string | null,
): Promise<IssueListResult | typeof NOT_MODIFIED> {
  const params: Record<string, unknown> = {
    owner,
    repo,
    state: "all",
    per_page: 100,
    sort: "updated",
    direction: "asc",
    headers: etag ? { "if-none-match": etag } : {},
  };
  if (since) params.since = since;

  let first;
  try {
    first = await gh.issues.listForRepo(params as never);
  } catch (e: unknown) {
    if ((e as { status?: number }).status === 304) return NOT_MODIFIED;
    throw e;
  }

  const freshEtag = (first.headers.etag as string | undefined) ?? null;
  const items = first.data as unknown as RawIssue[];
  if (items.length < 100) return { items, etag: freshEtag };

  // More than one page: fall back to full pagination, minus the conditional header.
  delete (params as { headers?: unknown }).headers;
  const all = (await gh.paginate(
    gh.issues.listForRepo,
    params as never,
  )) as unknown as RawIssue[];
  return { items: all, etag: freshEtag };
}

export const isPullRequest = (i: RawIssue) => i.pull_request != null;

export const labelNames = (i: RawIssue): string[] =>
  i.labels
    .map((l) => (typeof l === "string" ? l : l.name))
    .filter((n): n is string => Boolean(n));

export async function getTimeline(gh: Client, owner: string, repo: string, issue: number) {
  return (await gh.paginate(gh.issues.listEventsForTimeline, {
    owner,
    repo,
    issue_number: issue,
    per_page: 100,
  })) as unknown as Array<Record<string, unknown>>;
}

export async function getPull(gh: Client, owner: string, repo: string, pr: number) {
  const { data } = await gh.pulls.get({ owner, repo, pull_number: pr });
  return data;
}

/**
 * Find PRs whose body mentions this issue number. Used only as a fallback when
 * the timeline yields nothing, because /search has its own much tighter quota
 * (30/min) than the core API and is not worth spending routinely.
 *
 * Search matches the bare number loosely; the caller still regex-confirms that
 * the body actually says "fixes #N" before treating it as a link.
 */
export async function searchPullsMentioning(
  gh: Client,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<Array<{ number: number; body: string | null }>> {
  try {
    const { data } = await gh.search.issuesAndPullRequests({
      q: `repo:${owner}/${repo} is:pr "#${issueNumber}" in:body`,
      per_page: 20,
      advanced_search: "true",
    });
    return data.items.map((i) => ({ number: i.number, body: i.body ?? null }));
  } catch (e) {
    console.warn(`[github] PR body search failed for #${issueNumber}:`, e);
    return [];
  }
}

/**
 * The most recently *opened* issues, newest first.
 *
 * Sorted by creation, not update. `sort=updated` answers "what did people touch
 * lately", which on a busy repo is dominated by old threads getting comments —
 * openclaw returned issues created 13 to 199 hours ago while genuinely new ones
 * sat an hour old and unlisted. "Latest issues" means newly posted.
 */
export async function listRecentIssues(
  gh: Client,
  owner: string,
  repo: string,
  count: number,
): Promise<RawIssue[]> {
  const { data } = await gh.issues.listForRepo({
    owner,
    repo,
    state: "all",
    sort: "created",
    direction: "desc",
    // Always take a full page. The endpoint mixes PRs in, and on a busy repo
    // the recent window is overwhelmingly PRs — openclaw's newest 20 items
    // yielded only 2 issues. A full page costs the same single request.
    per_page: 100,
  });
  return (data as unknown as RawIssue[]).filter((i) => !isPullRequest(i)).slice(0, count);
}

export interface ReleaseInfo {
  tag: string;
  name: string | null;
  url: string;
  author: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  body: string | null;
}

/** Newest published release, or null if the repo has never cut one. */
export async function latestRelease(
  gh: Client,
  owner: string,
  repo: string,
): Promise<ReleaseInfo | null> {
  try {
    const { data } = await gh.repos.listReleases({ owner, repo, per_page: 1 });
    const r = data[0];
    if (!r) return null;
    return {
      tag: r.tag_name,
      name: r.name ?? null,
      url: r.html_url,
      author: r.author?.login ?? null,
      publishedAt: r.published_at ?? null,
      prerelease: r.prerelease,
      body: r.body ?? null,
    };
  } catch {
    return null; // releases disabled, or none published
  }
}

/** Remaining core-API calls, so the poller can decide to widen its interval. */
export async function rateRemaining(gh: Client): Promise<number> {
  const { data } = await gh.rateLimit.get();
  return data.resources.core?.remaining ?? 0;
}
