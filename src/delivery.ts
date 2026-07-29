import type { DatabaseSync } from "node:sqlite";
import type { TextChannel } from "discord.js";
import type { Config } from "./config.ts";
import {
  getIssue,
  getLinks,
  markDelivered,
  pendingEvents,
  setMessageId,
} from "./db.ts";
import {
  alertEmbed,
  digestEmbed,
  issueEmbed,
  releaseEmbed,
  summarize,
} from "./render.ts";
import type { EventRow, IssueRow, RepoRow } from "./types.ts";

/** Events that always post fresh with a ping instead of editing in place. */
const ALERTS = new Set(["race_warning", "pr_merged"]);

/**
 * Drain the pending queue into the channel.
 *
 * Nothing is marked delivered until Discord confirms, so a gateway drop or a
 * crash mid-drain re-delivers rather than silently losing events. That is why
 * the poller and the bot are separate processes over one DB.
 */
export async function drain(
  db: DatabaseSync,
  channel: TextChannel,
  cfg: Config,
): Promise<number> {
  const events = pendingEvents(db, 200);
  if (events.length === 0) return 0;

  const repos = new Map(
    (
      db.prepare("SELECT * FROM repos").all() as unknown as RepoRow[]
    ).map((r) => [r.id, r]),
  );

  const done: number[] = [];

  // Releases aren't attached to an issue (issue_number is 0), so they bypass
  // the per-issue embed logic entirely and post standalone.
  for (const ev of events.filter((e) => e.type === "release_published")) {
    const repo = repos.get(ev.repo_id);
    if (!repo) {
      done.push(ev.id);
      continue;
    }
    try {
      await channel.send({ embeds: [releaseEmbed(repo, ev)] });
      done.push(ev.id);
    } catch (e) {
      console.error(`[deliver] release ${ev.id} failed:`, e);
    }
  }

  const rest = events.filter((e) => e.type !== "release_published");
  const alerts = rest.filter((e) => ALERTS.has(e.type));
  const quiet = rest.filter((e) => !ALERTS.has(e.type));

  // Alerts first — they are the actionable ones and must not be buried.
  for (const ev of alerts) {
    const repo = repos.get(ev.repo_id);
    const issue = repo && getIssue(db, ev.repo_id, ev.issue_number);
    if (!repo || !issue) {
      done.push(ev.id); // orphaned by an unwatch; drop it
      continue;
    }
    try {
      await channel.send({
        content: cfg.pingTarget,
        embeds: [alertEmbed(repo, issue, ev)],
        allowedMentions: { parse: ["users", "everyone"] },
      });
      done.push(ev.id);
    } catch (e) {
      console.error(`[deliver] alert ${ev.id} failed:`, e);
    }
  }

  if (quiet.length > cfg.digestThreshold) {
    // Too many to read one by one; collapse into a single digest.
    const lines: string[] = [];
    for (const ev of quiet) {
      const repo = repos.get(ev.repo_id);
      const issue = repo && getIssue(db, ev.repo_id, ev.issue_number);
      if (repo && issue) lines.push(summarize(ev, issue, repo));
    }
    try {
      await channel.send({ embeds: [digestEmbed(lines, quiet.length)] });
      done.push(...quiet.map((e) => e.id));
    } catch (e) {
      console.error("[deliver] digest failed:", e);
    }
  } else {
    // One embed per issue; repeat events on the same issue edit that embed.
    const byIssue = new Map<string, EventRow[]>();
    for (const ev of quiet) {
      const key = `${ev.repo_id}:${ev.issue_number}`;
      byIssue.set(key, [...(byIssue.get(key) ?? []), ev]);
    }
    for (const [key, group] of byIssue) {
      const [repoId, number] = key.split(":").map(Number) as [number, number];
      const repo = repos.get(repoId);
      const issue = getIssue(db, repoId, number);
      if (!repo || !issue) {
        done.push(...group.map((e) => e.id));
        continue;
      }
      try {
        await upsertIssueMessage(db, channel, repo, issue);
        done.push(...group.map((e) => e.id));
      } catch (e) {
        console.error(`[deliver] issue ${key} failed:`, e);
      }
    }
  }

  markDelivered(db, done);
  return done.length;
}

/**
 * Post the issue's embed, or edit the existing one. A 404 means the message was
 * deleted — clear message_id and repost rather than wedging the queue forever.
 */
async function upsertIssueMessage(
  db: DatabaseSync,
  channel: TextChannel,
  repo: RepoRow,
  issue: IssueRow,
): Promise<void> {
  const embed = issueEmbed(repo, issue, getLinks(db, repo.id, issue.number));

  if (issue.message_id) {
    try {
      const msg = await channel.messages.fetch(issue.message_id);
      await msg.edit({ embeds: [embed] });
      return;
    } catch (e: unknown) {
      if ((e as { status?: number }).status !== 404) throw e;
      setMessageId(db, repo.id, issue.number, null);
    }
  }

  const sent = await channel.send({ embeds: [embed] });
  setMessageId(db, repo.id, issue.number, sent.id);
}
