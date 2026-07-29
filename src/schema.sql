-- issue-radar schema. Single Discord channel (configured), so no per-repo channel column.
-- Both the poller and the bot open this file; WAL is set at connection time in db.ts.

CREATE TABLE IF NOT EXISTS repos (
  id        INTEGER PRIMARY KEY,
  owner     TEXT NOT NULL,
  name      TEXT NOT NULL,
  -- Highest issue.updated_at we have durably processed. Sent as ?since=.
  last_sync TEXT,
  -- ETag from the last issues-list response, replayed as If-None-Match.
  etag      TEXT,
  -- Tag of the newest release we have already announced.
  last_release TEXT,
  added_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner, name)
);

CREATE TABLE IF NOT EXISTS issues (
  repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  state        TEXT    NOT NULL,           -- open | closed
  state_reason TEXT,                       -- completed | not_planned | reopened | null
  labels_json  TEXT    NOT NULL DEFAULT '[]',
  author       TEXT,
  html_url     TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  -- Discord message holding this issue's embed. Later events edit it in place.
  -- Cleared on a 404 so delivery reposts instead of wedging the queue.
  message_id   TEXT,
  -- Set by /claim (or, later, an external bug-fix pipeline) before any PR exists.
  claimed_by   TEXT,
  claimed_at   TEXT,
  -- Guard so the stale sweep emits at most one event per quiet period.
  stale_notified_at TEXT,
  PRIMARY KEY (repo_id, number)
);

CREATE INDEX IF NOT EXISTS issues_open_idx ON issues (repo_id, state, updated_at);

CREATE TABLE IF NOT EXISTS links (
  id           INTEGER PRIMARY KEY,
  repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  issue_number INTEGER NOT NULL,
  pr_number    INTEGER NOT NULL,
  -- How the link was asserted; 'connected' outranks the others when they disagree.
  kind         TEXT    NOT NULL,           -- connected | cross_referenced | closing_commit | body_regex
  pr_state     TEXT,                       -- open | closed
  draft        INTEGER,
  merged       INTEGER,
  author       TEXT,
  attribution  TEXT,                       -- mine | external
  -- A `disconnected` timeline event retires a link; we keep the row for /issue history.
  active       INTEGER NOT NULL DEFAULT 1,
  discovered_at TEXT   NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_id, issue_number, pr_number, kind)
);

CREATE INDEX IF NOT EXISTS links_issue_idx ON links (repo_id, issue_number, active);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY,
  repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  issue_number INTEGER NOT NULL,
  type         TEXT    NOT NULL,
  payload_json TEXT    NOT NULL DEFAULT '{}',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  -- NULL means pending. Stamped only after Discord confirms, so a crash re-delivers
  -- rather than silently dropping. This column is the entire crash-safety story.
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS events_pending_idx ON events (delivered_at, id);
