import {
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type TextChannel,
} from "discord.js";
import { loadConfig, type Config } from "./config.ts";
import {
  addRepo,
  claimIssue,
  getIssue,
  getLinks,
  getRepo,
  listIssues,
  listRepos,
  openDb,
  removeRepo,
  setSyncState,
  upsertIssue,
} from "./db.ts";
import { drain } from "./delivery.ts";
import {
  labelNames,
  listRecentIssues,
  makeClient,
  repoExists,
} from "./github.ts";
import { checkRelease } from "./poller.ts";
import { contention, issueEmbed, prLine, recentIssuesEmbed } from "./render.ts";
import type { DatabaseSync } from "node:sqlite";
import { splitSlug } from "./slug.ts";

/** How many recent issues /watch echoes back. */
const RECENT_COUNT = 5;

export const commands = [
  new SlashCommandBuilder()
    .setName("watch")
    .setDescription("Track a repo: new issues, PRs and releases as they happen")
    .addStringOption((o) =>
      o.setName("repo").setDescription("owner/repo").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("unwatch")
    .setDescription("Stop tracking a repo and forget its issues")
    .addStringOption((o) =>
      o.setName("repo").setDescription("owner/repo").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Table of tracked issues — reads the DB, no API calls"),
  new SlashCommandBuilder()
    .setName("issue")
    .setDescription("Full detail for one issue")
    .addIntegerOption((o) =>
      o.setName("number").setDescription("issue number").setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("repo").setDescription("owner/repo (if watching several)"),
    ),
  new SlashCommandBuilder()
    .setName("claim")
    .setDescription("Mark an issue as yours, so an external PR raises a race warning")
    .addIntegerOption((o) =>
      o.setName("number").setDescription("issue number").setRequired(true),
    )
    .addStringOption((o) => o.setName("repo").setDescription("owner/repo"))
    .addBooleanOption((o) =>
      o.setName("release").setDescription("drop the claim instead"),
    ),
].map((c) => c.toJSON());

/** Resolve the repo for commands where it is optional; unambiguous if only one. */
function resolveRepo(db: DatabaseSync, slug: string | null) {
  if (slug) {
    const parts = splitSlug(slug);
    return parts ? getRepo(db, parts[0], parts[1]) : undefined;
  }
  const all = listRepos(db);
  return all.length === 1 ? all[0] : undefined;
}

async function onWatch(i: ChatInputCommandInteraction, db: DatabaseSync, cfg: Config) {
  const slug = i.options.getString("repo", true);
  const parts = splitSlug(slug);
  if (!parts) {
    return i.editReply(
      `Couldn't read \`${slug}\` as a repository.\n` +
        "Try `Textualize/rich`, or paste the GitHub URL. " +
        "The owner is the repo's owner — you don't need to own it.",
    );
  }

  const gh = makeClient(cfg.githubToken);
  if (!(await repoExists(gh, parts[0], parts[1]))) {
    return i.editReply(`\`${slug}\` doesn't exist or isn't visible to this token.`);
  }
  if (getRepo(db, parts[0], parts[1])) return i.editReply(`Already watching \`${slug}\`.`);

  const repo = addRepo(db, parts[0], parts[1]);

  // No historical seeding. Start the cursor at now, so from this moment on you
  // hear about anything that changes -- and show the latest few issues straight
  // away so the command answers with something useful instead of a wait. A
  // full backfill of a large repo is thousands of rows nobody reads.
  setSyncState(db, repo.id, new Date().toISOString(), null);

  const recent = await listRecentIssues(gh, parts[0], parts[1], RECENT_COUNT);
  for (const raw of recent) {
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
      comments: raw.comments ?? 0,
    });
  }

  // Record the current release so the next new one is news, not the current one.
  await checkRelease(gh, db, cfg, { ...repo, last_release: null });

  const fresh = getRepo(db, parts[0], parts[1])!;
  return i.editReply({
    content: `Now watching \`${parts[0]}/${parts[1]}\`. You'll get new issues, closes, PRs and releases as they happen.`,
    embeds: [recentIssuesEmbed(fresh, recent)],
  });
}

async function onStatus(i: ChatInputCommandInteraction, db: DatabaseSync) {
  const repos = new Map(listRepos(db).map((r) => [r.id, `${r.owner}/${r.name}`]));
  const rows = listIssues(db).slice(0, 25);
  if (rows.length === 0) return i.editReply("Nothing tracked yet — try `/watch owner/repo`.");

  const table = rows.map((r) => {
    const links = getLinks(db, r.repo_id, r.number);
    const days = Math.floor((Date.now() - Date.parse(r.created_at)) / 86_400_000);
    return [
      `${repos.get(r.repo_id) ?? "?"}#${r.number}`.padEnd(28).slice(0, 28),
      `${days}d`.padStart(5),
      (r.state === "open" ? "open" : (r.state_reason ?? "closed")).padEnd(12),
      contention(r, links).slice(0, 34),
    ].join("  ");
  });

  return i.editReply(
    `\`\`\`\n${"issue".padEnd(28)}  ${"age".padStart(5)}  ${"state".padEnd(12)}  status\n${table.join("\n")}\n\`\`\``,
  );
}

async function onIssue(i: ChatInputCommandInteraction, db: DatabaseSync) {
  const n = i.options.getInteger("number", true);
  const repo = resolveRepo(db, i.options.getString("repo"));
  if (!repo) return i.editReply("Which repo? Pass `repo: owner/repo`.");

  const issue = getIssue(db, repo.id, n);
  if (!issue) return i.editReply(`No record of #${n} in \`${repo.owner}/${repo.name}\`.`);

  // All history, including links retired by a `disconnected` event.
  const all = getLinks(db, repo.id, n, false);
  const embed = issueEmbed(repo, issue, all.filter((l) => l.active));
  const retired = all.filter((l) => !l.active);
  if (retired.length) {
    embed.addFields({ name: "Unlinked", value: retired.map(prLine).join("\n") });
  }
  return i.editReply({ embeds: [embed] });
}

async function onClaim(i: ChatInputCommandInteraction, db: DatabaseSync, cfg: Config) {
  const n = i.options.getInteger("number", true);
  const repo = resolveRepo(db, i.options.getString("repo"));
  if (!repo) return i.editReply("Which repo? Pass `repo: owner/repo`.");
  if (!getIssue(db, repo.id, n)) return i.editReply(`No record of #${n}.`);

  const release = i.options.getBoolean("release") ?? false;
  claimIssue(db, repo.id, n, release ? null : cfg.githubHandle);
  return i.editReply(
    release
      ? `Released #${n}.`
      : `Claimed #${n}. An external PR on it will now raise a race warning.`,
  );
}

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] ready as ${c.user.tag}`);
  const channel = (await c.channels.fetch(cfg.discordChannelId)) as TextChannel;

  // Drain on connect: anything the poller queued while the gateway was down is
  // still sitting in the events table, which is the point of the split.
  const tick = async () => {
    try {
      const n = await drain(db, channel, cfg);
      if (n) console.log(`[bot] delivered ${n} events`);
    } catch (e) {
      console.error("[bot] drain failed:", e);
    }
  };
  await tick();

  // Resuming from suspend can leave the websocket open but dead: the process is
  // healthy, so Restart=always never fires, and the bot sits there looking
  // online while delivering nothing. discord.js reconnects on its own within a
  // few seconds, so only a sustained outage counts. Exiting hands the problem
  // to systemd, which knows how to start us cleanly.
  let unhealthy = 0;
  const HEALTH_STRIKES = 4; // ~2 minutes at the 30s tick

  setInterval(async () => {
    if (client.isReady()) {
      unhealthy = 0;
      await tick();
      return;
    }
    if (++unhealthy >= HEALTH_STRIKES) {
      console.error(
        `[bot] gateway not ready for ${(HEALTH_STRIKES * 30) / 60} minutes; exiting for restart`,
      );
      process.exit(1);
    }
    console.warn(`[bot] gateway not ready (${unhealthy}/${HEALTH_STRIKES})`);
  }, 30_000);
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  await i.deferReply();
  try {
    if (i.commandName === "watch") await onWatch(i, db, cfg);
    else if (i.commandName === "unwatch") {
      const parts = splitSlug(i.options.getString("repo", true));
      const gone = parts ? removeRepo(db, parts[0], parts[1]) : false;
      await i.editReply(gone ? "Stopped watching." : "Not watching that repo.");
    } else if (i.commandName === "status") await onStatus(i, db);
    else if (i.commandName === "issue") await onIssue(i, db);
    else if (i.commandName === "claim") await onClaim(i, db, cfg);
  } catch (e) {
    console.error(`[bot] ${i.commandName} failed:`, e);
    await i.editReply("That failed — check the logs.").catch(() => {});
  }
});

if (process.argv.includes("--register")) {
  const rest = new REST().setToken(cfg.discordToken);
  // The first token segment is the base64 application id, but that has not
  // always held across token formats — DISCORD_APP_ID wins when set.
  const appId =
    process.env.DISCORD_APP_ID ||
    Buffer.from(cfg.discordToken.split(".")[0]!, "base64").toString();
  if (!/^\d{17,20}$/.test(appId)) {
    console.error(
      `Could not derive the application id from the token (got "${appId}").\n` +
        "Set DISCORD_APP_ID in .env — it's the Application ID on your app's General Information page.",
    );
    process.exit(1);
  }
  await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log(`[bot] registered ${commands.length} commands`);
  process.exit(0);
}

await client.login(cfg.discordToken);
