import { EmbedBuilder } from "discord.js";
import type { EventRow, IssueRow, LinkRow, RepoRow } from "./types.ts";

export const COLOR = {
  open: 0x2da44e,
  completed: 0x8250df,
  not_planned: 0x6e7781,
  stale: 0xd4a72c,
  race: 0xcf222e,
} as const;

export function issueColor(issue: IssueRow): number {
  if (issue.state === "open") return COLOR.open;
  return issue.state_reason === "not_planned" ? COLOR.not_planned : COLOR.completed;
}

const age = (iso: string) =>
  `${Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)}d`;

/**
 * Is anyone already on this?
 *
 * The question that decides whether an issue is worth picking up, ranked by how
 * strongly it says "taken". A PR beats discussion; discussion beats silence.
 * Bot comments are excluded upstream, so "nobody has replied" means no human
 * replied — a triage bot leaving a template does not make an issue contested.
 */
export function contention(issue: IssueRow, links: LinkRow[]): string {
  const parts: string[] = [];

  const merged = links.find((l) => l.merged);
  const open = links.find((l) => !l.merged && l.pr_state !== "closed");
  if (merged) parts.push(`fixed by PR #${merged.pr_number}`);
  else if (open) {
    parts.push(
      `PR #${open.pr_number} open${open.draft ? " (draft)" : ""} · ${
        open.attribution === "mine" ? "yours" : (open.author ?? "someone")
      }`,
    );
  } else if (links.length) parts.push(`PR #${links[0]!.pr_number} closed unmerged`);

  if (issue.comments === 0) {
    // Zero total comments needs no thread read to be certain about.
    parts.push("no replies");
  } else if (issue.human_comments === null) {
    parts.push(`${issue.comments} comments`); // thread not read yet
  } else if (issue.human_comments > 0) {
    parts.push(`${issue.human_comments} ${issue.human_comments === 1 ? "reply" : "replies"}`);
  } else {
    // Comments exist but every one of them is a bot.
    parts.push("bots only");
  }

  if (issue.claimed_by) parts.push(`claimed by ${issue.claimed_by}`);

  // Nothing attached and nobody talking: the one you want.
  if (!links.length && !issue.claimed_by && !issue.human_comments && !issue.comments) {
    return "untouched";
  }
  return parts.join(" · ");
}

/** One embed per issue. Later events edit this rather than posting again. */
export function issueEmbed(
  repo: RepoRow,
  issue: IssueRow,
  links: LinkRow[],
): EmbedBuilder {
  const slug = `${repo.owner}/${repo.name}`;
  const heading = `#${issue.number} ${issue.title}`;
  const labels = JSON.parse(issue.labels_json) as string[];

  const e = new EmbedBuilder()
    .setColor(issueColor(issue))
    // Struck through once closed, so a glance down the channel reads correctly.
    .setTitle(issue.state === "closed" ? `~~${heading}~~` : heading)
    .setURL(issue.html_url)
    .setAuthor({ name: slug })
    .addFields(
      {
        name: "State",
        value:
          issue.state === "open"
            ? "open"
            : `closed (${issue.state_reason ?? "completed"})`,
        inline: true,
      },
      { name: "Age", value: age(issue.created_at), inline: true },
      { name: "Status", value: contention(issue, links), inline: true },
    );

  if (labels.length) {
    e.addFields({ name: "Labels", value: labels.join(", "), inline: false });
  }

  if (links.length) {
    e.addFields({
      name: "Pull requests",
      value: links.map(prLine).join("\n"),
      inline: false,
    });
  }

  return e.setFooter({ text: `updated ${issue.updated_at}` });
}

export function prLine(l: LinkRow): string {
  const status = l.merged
    ? "merged"
    : l.pr_state === "closed"
      ? "closed unmerged"
      : l.draft
        ? "draft"
        : "open";
  const who = l.attribution === "mine" ? "you" : (l.author ?? "?");
  return `#${l.pr_number} — ${status} · ${who}`;
}

/** More than `digestThreshold` events in one cycle collapse into this. */
export function digestEmbed(
  lines: string[],
  cycleCount: number,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLOR.open)
    .setTitle(`${cycleCount} updates this cycle`)
    .setDescription(lines.join("\n").slice(0, 4000));
}

/** race_warning and pr_merged post fresh with a ping — they're actionable. */
export function alertEmbed(
  repo: RepoRow,
  issue: IssueRow,
  ev: EventRow,
): EmbedBuilder {
  const p = JSON.parse(ev.payload_json) as Record<string, unknown>;
  const slug = `${repo.owner}/${repo.name}`;

  if (ev.type === "race_warning") {
    return new EmbedBuilder()
      .setColor(COLOR.race)
      .setTitle(`Race on #${issue.number} — ${issue.title}`)
      .setURL(issue.html_url)
      .setDescription(
        `You claimed this${p.claimed_by ? ` (${p.claimed_by})` : ""}, but **${p.author}** opened PR #${p.pr} against it.`,
      )
      .setAuthor({ name: slug });
  }

  return new EmbedBuilder()
    .setColor(COLOR.completed)
    .setTitle(`PR #${p.pr} merged — closes #${issue.number}`)
    .setURL(issue.html_url)
    .setDescription(
      `${issue.title}\nby ${p.attribution === "mine" ? "you" : p.author}`,
    )
    .setAuthor({ name: slug });
}

/** Releases aren't tied to an issue, so they get their own standalone embed. */
export function releaseEmbed(repo: RepoRow, ev: EventRow): EmbedBuilder {
  const p = JSON.parse(ev.payload_json) as Record<string, unknown>;
  const e = new EmbedBuilder()
    .setColor(p.prerelease ? COLOR.stale : COLOR.open)
    .setTitle(
      `${repo.owner}/${repo.name} ${p.tag}${p.prerelease ? " (pre-release)" : ""}`,
    )
    .setURL(String(p.url))
    .setAuthor({ name: "new release" });
  if (p.name && p.name !== p.tag) e.setDescription(String(p.name));
  if (p.body) {
    e.addFields({ name: "Notes", value: String(p.body).slice(0, 1000) });
  }
  if (p.author) e.setFooter({ text: `released by ${p.author}` });
  return e;
}

/** Compact list of an issue for the /watch summary. */
export function recentIssuesEmbed(
  repo: RepoRow,
  issues: Array<{ number: number; title: string; state: string; html_url: string; updated_at: string }>,
): EmbedBuilder {
  const lines = issues.map((i) => {
    const days = Math.floor((Date.now() - Date.parse(i.updated_at)) / 86_400_000);
    const when = days === 0 ? "today" : `${days}d ago`;
    const mark = i.state === "closed" ? "~~" : "";
    return `${mark}[#${i.number} ${i.title.slice(0, 70)}](${i.html_url})${mark} · ${when}`;
  });
  return new EmbedBuilder()
    .setColor(COLOR.open)
    .setTitle(`${repo.owner}/${repo.name} — latest issues`)
    .setDescription(lines.join("\n") || "No issues found.");
}

export function summarize(ev: EventRow, issue: IssueRow, repo: RepoRow): string {
  const p = JSON.parse(ev.payload_json) as Record<string, unknown>;
  const ref = `${repo.owner}/${repo.name}#${issue.number}`;
  switch (ev.type) {
    case "issue_opened":
      return p.labels
        ? `${ref} labels: ${[
            ...(p.added as string[]).map((l) => `+${l}`),
            ...(p.removed as string[]).map((l) => `-${l}`),
          ].join(" ")}`
        : `${ref} ${p.reopened ? "reopened" : "opened"} — ${issue.title}`;
    case "issue_closed":
      return `${ref} closed as ${p.reason ?? "completed"}`;
    case "pr_opened_for_issue":
      return `${ref} ← PR #${p.pr} by ${p.author}${p.draft ? " (draft)" : ""}`;
    case "pr_merged":
      return `${ref} ← PR #${p.pr} merged`;
    case "pr_closed_unmerged":
      return `${ref} ← PR #${p.pr} closed unmerged`;
    case "race_warning":
      return `${ref} RACE: ${p.author} opened PR #${p.pr}`;
    case "stale":
      return `${ref} stale (${p.days}d quiet)`;
    case "release_published":
      return `${repo.owner}/${repo.name} released ${p.tag}`;
  }
}
