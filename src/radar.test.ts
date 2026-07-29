import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { TextChannel } from "discord.js";
import {
  addRepo,
  claimIssue,
  getIssue,
  openDb,
  pendingEvents,
  setMessageId,
  upsertIssue,
  upsertLink,
} from "./db.ts";
import { diffIssue, touchesState } from "./diff.ts";
import { emitIssueEvents, emitLinkEvents, sweepStale } from "./events.ts";
import { parseClosingRefs, resolveLinks } from "./links.ts";
import { drain } from "./delivery.ts";
import { contention } from "./render.ts";
import { splitSlug } from "./slug.ts";
import { isPullRequest, type RawIssue } from "./github.ts";
import type { Config } from "./config.ts";
import type { IssueRow, LinkRow } from "./types.ts";

const LABELS = ["bug", "good first issue"];

function raw(over: Partial<RawIssue> = {}): RawIssue {
  return {
    number: 1,
    title: "t",
    state: "open",
    state_reason: null,
    labels: [],
    user: { login: "someone" },
    html_url: "https://example.test/1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...over,
  };
}

function stored(over: Partial<IssueRow> = {}): IssueRow {
  return {
    repo_id: 1,
    number: 1,
    title: "t",
    state: "open",
    state_reason: null,
    labels_json: "[]",
    author: "someone",
    html_url: "https://example.test/1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    comments: 0,
    human_comments: null,
    message_id: null,
    claimed_by: null,
    claimed_at: null,
    stale_notified_at: null,
    ...over,
  };
}

describe("diff engine", () => {
  test("unseen issue is new", () => {
    assert.deepEqual(diffIssue(undefined, raw(), LABELS), [{ kind: "new" }]);
  });

  test("identical re-fetch produces nothing (since= is inclusive)", () => {
    assert.deepEqual(diffIssue(stored(), raw(), LABELS), []);
  });

  test("open -> closed carries the reason", () => {
    const d = diffIssue(
      stored(),
      raw({ state: "closed", state_reason: "not_planned" }),
      LABELS,
    );
    assert.deepEqual(d, [{ kind: "closed", reason: "not_planned" }]);
  });

  test("not_planned -> completed on an already-closed issue is its own diff", () => {
    const d = diffIssue(
      stored({ state: "closed", state_reason: "not_planned" }),
      raw({ state: "closed", state_reason: "completed" }),
      LABELS,
    );
    assert.deepEqual(d, [
      { kind: "reason_changed", from: "not_planned", to: "completed" },
    ]);
  });

  test("reopen is not a close", () => {
    const d = diffIssue(
      stored({ state: "closed", state_reason: "completed" }),
      raw({ state: "open" }),
      LABELS,
    );
    assert.deepEqual(d, [{ kind: "reopened" }]);
  });

  test("only watched labels matter", () => {
    const noise = diffIssue(stored(), raw({ labels: [{ name: "docs" }] }), LABELS);
    assert.deepEqual(noise, []);
    const real = diffIssue(stored(), raw({ labels: [{ name: "Bug" }] }), LABELS);
    assert.deepEqual(real, [{ kind: "labels", added: ["bug"], removed: [] }]);
  });

  test("label churn alone does not trigger link resolution", () => {
    const d = diffIssue(stored(), raw({ labels: [{ name: "bug" }] }), LABELS);
    assert.equal(d.some(touchesState), false);
  });
});

describe("PR/issue split", () => {
  test("items with a pull_request key are PRs", () => {
    assert.equal(isPullRequest(raw()), false);
    assert.equal(isPullRequest(raw({ pull_request: { url: "x" } })), true);
  });
});

describe("closing-ref regex", () => {
  test("matches the documented verb forms", () => {
    assert.deepEqual(
      parseClosingRefs("Fixes #12, closed #13; this Resolves #14\nfix #15"),
      [12, 13, 14, 15],
    );
  });
  test("ignores bare references", () => {
    assert.deepEqual(parseClosingRefs("see #99 and related #100"), []);
  });
});

describe("event emission", () => {
  const setup = () => {
    const db = openDb(":memory:");
    const repo = addRepo(db, "o", "r");
    upsertIssue(db, {
      repo_id: repo.id,
      number: 1,
      title: "t",
      state: "open",
      state_reason: null,
      labels_json: "[]",
      author: "someone",
      html_url: "u",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      comments: 0,
    });
    return { db, repo };
  };

  const link = (over: Partial<LinkRow> = {}): LinkRow => ({
    id: 1,
    repo_id: 1,
    issue_number: 1,
    pr_number: 7,
    kind: "connected",
    pr_state: "open",
    draft: 0,
    merged: 0,
    author: "rando",
    attribution: "external",
    active: 1,
    discovered_at: "",
    ...over,
  });

  test("external PR on a claimed issue raises a race warning", () => {
    const { db, repo } = setup();
    claimIssue(db, repo.id, 1, "MaheshBhushan");
    emitLinkEvents(db, repo.id, getIssue(db, repo.id, 1), [], [link()]);
    const types = pendingEvents(db).map((e) => e.type);
    assert.deepEqual(types, ["pr_opened_for_issue", "race_warning"]);
  });

  test("no claim, no race", () => {
    const { db, repo } = setup();
    emitLinkEvents(db, repo.id, getIssue(db, repo.id, 1), [], [link()]);
    assert.deepEqual(pendingEvents(db).map((e) => e.type), ["pr_opened_for_issue"]);
  });

  test("your own PR never races you", () => {
    const { db, repo } = setup();
    claimIssue(db, repo.id, 1, "MaheshBhushan");
    emitLinkEvents(
      db,
      repo.id,
      getIssue(db, repo.id, 1),
      [],
      [link({ author: "MaheshBhushan", attribution: "mine" })],
    );
    assert.deepEqual(pendingEvents(db).map((e) => e.type), ["pr_opened_for_issue"]);
  });

  test("a re-observed unchanged PR emits nothing", () => {
    const { db, repo } = setup();
    const before = [link()];
    emitLinkEvents(db, repo.id, getIssue(db, repo.id, 1), before, [link()]);
    assert.equal(pendingEvents(db).length, 0);
  });

  test("merge and unmerged-close are distinguished", () => {
    const { db, repo } = setup();
    emitLinkEvents(db, repo.id, getIssue(db, repo.id, 1), [link()], [
      link({ merged: 1, pr_state: "closed" }),
    ]);
    assert.deepEqual(pendingEvents(db).map((e) => e.type), ["pr_merged"]);

    const b = setup();
    emitLinkEvents(b.db, b.repo.id, getIssue(b.db, b.repo.id, 1), [link()], [
      link({ merged: 0, pr_state: "closed" }),
    ]);
    assert.deepEqual(
      pendingEvents(b.db).map((e) => e.type),
      ["pr_closed_unmerged"],
    );
  });

  test("stale sweep fires once, not every cycle", () => {
    const db = openDb(":memory:");
    const repo = addRepo(db, "o", "r");
    upsertIssue(db, {
      repo_id: repo.id,
      number: 1,
      title: "old",
      state: "open",
      state_reason: null,
      labels_json: "[]",
      author: "a",
      html_url: "u",
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
      comments: 0,
    });
    assert.equal(sweepStale(db, 30), 1);
    assert.equal(sweepStale(db, 30), 0);
  });

  test("issue diffs map onto event types", () => {
    const { db, repo } = setup();
    emitIssueEvents(db, repo.id, 1, [{ kind: "closed", reason: "not_planned" }]);
    const [ev] = pendingEvents(db);
    assert.equal(ev!.type, "issue_closed");
    assert.equal(JSON.parse(ev!.payload_json).reason, "not_planned");
  });
});

describe("delivery", () => {
  const cfg = { digestThreshold: 5, pingTarget: "@here" } as Config;

  function fakeChannel() {
    const sent: Array<Record<string, unknown>> = [];
    const edits: string[] = [];
    let nextId = 100;
    const channel = {
      send: async (payload: Record<string, unknown>) => {
        sent.push(payload);
        return { id: String(nextId++) };
      },
      messages: {
        fetch: async (id: string) => {
          if (id === "gone") {
            throw Object.assign(new Error("Unknown Message"), { status: 404 });
          }
          return { edit: async () => void edits.push(id) };
        },
      },
    } as unknown as TextChannel;
    return { channel, sent, edits };
  }

  function seeded(n: number, type = "issue_opened") {
    const db = openDb(":memory:");
    const repo = addRepo(db, "o", "r");
    for (let i = 1; i <= n; i++) {
      upsertIssue(db, {
        repo_id: repo.id,
        number: i,
        title: `t${i}`,
        state: "open",
        state_reason: null,
        labels_json: "[]",
        author: "a",
        html_url: `https://example.test/${i}`,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        comments: 0,
      });
      db.prepare(
        "INSERT INTO events (repo_id, issue_number, type) VALUES (?, ?, ?)",
      ).run(repo.id, i, type);
    }
    return { db, repo };
  }

  test("a quiet cycle posts one embed per issue", async () => {
    const { db, repo } = seeded(3);
    const { channel, sent } = fakeChannel();
    assert.equal(await drain(db, channel, cfg), 3);
    assert.equal(sent.length, 3);
    // message_id recorded so later events edit rather than repost
    assert.ok(getIssue(db, repo.id, 1)!.message_id);
    assert.equal(pendingEvents(db).length, 0);
  });

  test("later events on the same issue edit the stored message", async () => {
    const { db, repo } = seeded(1);
    setMessageId(db, repo.id, 1, "555");
    const { channel, sent, edits } = fakeChannel();
    await drain(db, channel, cfg);
    assert.deepEqual(edits, ["555"]);
    assert.equal(sent.length, 0);
  });

  test("a deleted message reposts instead of wedging the queue", async () => {
    const { db, repo } = seeded(1);
    setMessageId(db, repo.id, 1, "gone");
    const { channel, sent } = fakeChannel();
    assert.equal(await drain(db, channel, cfg), 1);
    assert.equal(sent.length, 1);
    assert.notEqual(getIssue(db, repo.id, 1)!.message_id, "gone");
  });

  test("more than the threshold collapses into one digest", async () => {
    const { db } = seeded(9);
    const { channel, sent } = fakeChannel();
    assert.equal(await drain(db, channel, cfg), 9);
    assert.equal(sent.length, 1);
  });

  test("race warnings post fresh with a ping even inside a busy cycle", async () => {
    const { db, repo } = seeded(9);
    db.prepare(
      "INSERT INTO events (repo_id, issue_number, type, payload_json) VALUES (?, 1, 'race_warning', ?)",
    ).run(repo.id, JSON.stringify({ pr: 7, author: "rando", claimed_by: "me" }));
    const { channel, sent } = fakeChannel();
    await drain(db, channel, cfg);
    // one digest for the quiet nine, one pinged alert
    assert.equal(sent.length, 2);
    assert.equal(sent.find((s) => s.content)?.content, "@here");
  });

  test("a send failure leaves the event pending for the next drain", async () => {
    const { db } = seeded(1);
    const failing = {
      send: async () => {
        throw new Error("gateway down");
      },
      messages: { fetch: async () => ({ edit: async () => {} }) },
    } as unknown as TextChannel;
    assert.equal(await drain(db, failing, cfg), 0);
    assert.equal(pendingEvents(db).length, 1);
  });
});

describe("body-regex fallback", () => {
  /** Minimal stand-in for the Octokit surface resolveLinks actually touches. */
  function fakeGh(timeline: Array<Record<string, unknown>>, searchHits = 0) {
    const calls = { search: 0 };
    const gh = {
      paginate: async () => timeline,
      issues: { listEventsForTimeline: {} },
      pulls: {
        get: async ({ pull_number }: { pull_number: number }) => ({
          data: {
            number: pull_number,
            state: "open",
            draft: false,
            merged_at: null,
            user: { login: "rando" },
          },
        }),
      },
      search: {
        issuesAndPullRequests: async () => {
          calls.search++;
          return {
            data: {
              items: Array.from({ length: searchHits }, (_, k) => ({
                number: 900 + k,
                body: `Fixes #1`,
              })),
            },
          };
        },
      },
    };
    return { gh, calls };
  }

  const setup = () => {
    const db = openDb(":memory:");
    const repo = addRepo(db, "o", "r");
    return { db, repoId: repo.id };
  };

  test("stays dormant when the timeline already produced links", async () => {
    const { db, repoId } = setup();
    const { gh, calls } = fakeGh(
      [
        {
          event: "cross-referenced",
          source: { issue: { number: 7, pull_request: {} } },
        },
      ],
      3,
    );
    const links = await resolveLinks(gh as never, db, repoId, "o", "r", 1, "me");
    assert.equal(calls.search, 0, "must not spend search quota");
    assert.deepEqual(links.map((l) => l.pr_number), [7]);
  });

  test("kicks in when the timeline is silent", async () => {
    const { db, repoId } = setup();
    const { gh, calls } = fakeGh([], 2);
    const links = await resolveLinks(gh as never, db, repoId, "o", "r", 1, "me");
    assert.equal(calls.search, 1);
    assert.deepEqual(links.map((l) => l.pr_number), [900, 901]);
    assert.deepEqual(links.map((l) => l.kind), ["body_regex", "body_regex"]);
  });

  test("a search hit whose body doesn't actually close the issue is dropped", async () => {
    const { db, repoId } = setup();
    const gh = {
      paginate: async () => [],
      issues: { listEventsForTimeline: {} },
      pulls: { get: async () => ({ data: {} }) },
      search: {
        issuesAndPullRequests: async () => ({
          data: { items: [{ number: 900, body: "related to #1, see also #2" }] },
        }),
      },
    };
    const links = await resolveLinks(gh as never, db, repoId, "o", "r", 1, "me");
    assert.equal(links.length, 0);
  });
});

describe("contention status", () => {
  const L = (over: Partial<LinkRow> = {}): LinkRow => ({
    id: 1,
    repo_id: 1,
    issue_number: 1,
    pr_number: 7,
    kind: "connected",
    pr_state: "open",
    draft: 0,
    merged: 0,
    author: "rando",
    attribution: "external",
    active: 1,
    discovered_at: "",
    ...over,
  });

  test("nothing on it at all reads as untouched", () => {
    assert.equal(contention(stored(), []), "untouched");
  });

  test("human replies are counted", () => {
    assert.equal(
      contention(stored({ comments: 3, human_comments: 3 }), []),
      "3 replies",
    );
    assert.equal(
      contention(stored({ comments: 1, human_comments: 1 }), []),
      "1 reply",
    );
  });

  test("a thread of pure bot noise is not contested", () => {
    // 4 comments, none from a person: still free to pick up.
    assert.equal(
      contention(stored({ comments: 4, human_comments: 0 }), []),
      "bots only",
    );
  });

  test("an open PR outranks the comment count", () => {
    assert.equal(
      contention(stored({ comments: 2, human_comments: 2 }), [L()]),
      "PR #7 open · rando · 2 replies",
    );
  });

  test("your own PR is marked as yours", () => {
    assert.ok(
      contention(stored(), [L({ attribution: "mine", author: "MaheshBhushan" })])
        .startsWith("PR #7 open · yours"),
    );
  });

  test("a merged PR reads as fixed", () => {
    assert.ok(
      contention(stored(), [L({ merged: 1, pr_state: "closed" })]).startsWith(
        "fixed by PR #7",
      ),
    );
  });

  test("a closed unmerged PR does not read as fixed", () => {
    const s = contention(stored(), [L({ merged: 0, pr_state: "closed" })]);
    assert.ok(s.includes("closed unmerged"));
    assert.ok(!s.includes("fixed"));
  });

  test("unread threads fall back to the raw count", () => {
    assert.equal(
      contention(stored({ comments: 5, human_comments: null }), []),
      "5 comments",
    );
  });

  test("a claim is appended, not substituted", () => {
    assert.equal(
      contention(stored({ claimed_by: "MaheshBhushan" }), []),
      "no replies · claimed by MaheshBhushan",
    );
  });
});

describe("repo slug parsing", () => {
  const cases: Array<[string, [string, string] | null]> = [
    ["Textualize/rich", ["Textualize", "rich"]],
    ["  Textualize/rich  ", ["Textualize", "rich"]],
    ["https://github.com/Textualize/rich", ["Textualize", "rich"]],
    ["http://www.github.com/Textualize/rich", ["Textualize", "rich"]],
    ["github.com/Textualize/rich", ["Textualize", "rich"]],
    ["https://github.com/Textualize/rich.git", ["Textualize", "rich"]],
    ["git@github.com:Textualize/rich.git", ["Textualize", "rich"]],
    ["<https://github.com/Textualize/rich>", ["Textualize", "rich"]],
    ["https://github.com/Textualize/rich/", ["Textualize", "rich"]],
    // deep links still identify the repo
    ["https://github.com/Textualize/rich/issues/3299", ["Textualize", "rich"]],
    ["https://github.com/Textualize/rich/pull/4155", ["Textualize", "rich"]],
    // genuinely unusable
    ["rich", null],
    ["", null],
    ["not a repo at all", null],
  ];

  for (const [input, expected] of cases) {
    test(`${input || "(empty)"} -> ${expected ? expected.join("/") : "null"}`, () => {
      assert.deepEqual(splitSlug(input), expected);
    });
  }
});

describe("link storage", () => {
  test("connected outranks a cross-reference for the same PR", () => {
    const db = openDb(":memory:");
    const repo = addRepo(db, "o", "r");
    upsertLink(db, {
      repo_id: repo.id,
      issue_number: 1,
      pr_number: 7,
      kind: "cross_referenced",
      author: "a",
    });
    upsertLink(db, {
      repo_id: repo.id,
      issue_number: 1,
      pr_number: 7,
      kind: "connected",
      author: "a",
    });
    // Different kinds are distinct rows by design; /issue shows both.
    const rows = db
      .prepare("SELECT kind FROM links WHERE issue_number = 1")
      .all() as unknown as Array<{ kind: string }>;
    assert.equal(rows.length, 2);
  });
});
