export type IssueState = "open" | "closed";
export type Attribution = "mine" | "external";
export type LinkKind =
  | "connected"
  | "cross_referenced"
  | "closing_commit"
  | "body_regex";

export type EventType =
  | "issue_opened"
  | "issue_closed"
  | "pr_opened_for_issue"
  | "pr_merged"
  | "pr_closed_unmerged"
  | "race_warning"
  | "stale"
  | "release_published";

export interface RepoRow {
  id: number;
  owner: string;
  name: string;
  last_sync: string | null;
  etag: string | null;
  last_release: string | null;
  added_at: string;
}

export interface IssueRow {
  repo_id: number;
  number: number;
  title: string;
  state: IssueState;
  state_reason: string | null;
  labels_json: string;
  author: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  comments: number;
  human_comments: number | null;
  message_id: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  stale_notified_at: string | null;
}

export interface LinkRow {
  id: number;
  repo_id: number;
  issue_number: number;
  pr_number: number;
  kind: LinkKind;
  pr_state: IssueState | null;
  draft: number | null;
  merged: number | null;
  author: string | null;
  attribution: Attribution | null;
  active: number;
  discovered_at: string;
}

export interface EventRow {
  id: number;
  repo_id: number;
  issue_number: number;
  type: EventType;
  payload_json: string;
  created_at: string;
  delivered_at: string | null;
}

/** Shape written by the poller; `id` and timestamps are assigned by SQLite. */
export type IssueUpsert = Omit<
  IssueRow,
  | "message_id"
  | "claimed_by"
  | "claimed_at"
  | "stale_notified_at"
  | "human_comments"
>;

export type LinkUpsert = Pick<
  LinkRow,
  "repo_id" | "issue_number" | "pr_number" | "kind"
> &
  Partial<Pick<LinkRow, "pr_state" | "draft" | "merged" | "author" | "attribution">>;
