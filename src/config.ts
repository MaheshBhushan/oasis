/** Single-channel deployment: one DISCORD_CHANNEL_ID for every watched repo. */
export interface Config {
  dbPath: string;
  githubToken: string;
  githubHandle: string;
  discordToken: string;
  discordChannelId: string;
  /** Label changes only produce events for labels in this set. */
  watchedLabels: string[];
  staleDays: number;
  /**
   * How far back /watch seeds history. Full history on a large repo is tens of
   * thousands of items and hours of pagination, and dormant issues are not what
   * you race anyone for — recent activity is.
   */
  backfillDays: number;
  /** Batch into a single digest embed once a cycle exceeds this many events. */
  digestThreshold: number;
  /** Poller backs off (doubling its interval) below this many remaining calls. */
  rateLimitFloor: number;
  /** Prefix on actionable alerts. `<@id>` for a DM-style ping, or `@here`. */
  pingTarget: string;
  /**
   * Only announce issues carrying one of `watchedLabels`. On a repo the size of
   * openclaw this is the difference between a readable feed and a firehose —
   * everything else still lands in the DB for /status and /issue.
   */
  onlyLabelled: boolean;
  /** Skip issues that already have a pull request attached. */
  onlyUnclaimed: boolean;
  /** Max issue timelines resolved per repo per cycle. Bounds quota spend. */
  linkBudget: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export function loadConfig(): Config {
  return {
    dbPath: process.env.RADAR_DB ?? "radar.db",
    githubToken: req("GITHUB_TOKEN"),
    githubHandle: process.env.GITHUB_HANDLE ?? "MaheshBhushan",
    discordToken: req("DISCORD_TOKEN"),
    discordChannelId: req("DISCORD_CHANNEL_ID"),
    watchedLabels: (process.env.RADAR_LABELS ?? "bug,good first issue")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    staleDays: Number(process.env.RADAR_STALE_DAYS ?? 30),
    backfillDays: Number(process.env.RADAR_BACKFILL_DAYS ?? 90),
    digestThreshold: Number(process.env.RADAR_DIGEST_THRESHOLD ?? 5),
    rateLimitFloor: Number(process.env.RADAR_RATE_FLOOR ?? 500),
    pingTarget: process.env.RADAR_PING
      ? `<@${process.env.RADAR_PING}>`
      : "@here",
    onlyLabelled: process.env.RADAR_ONLY_LABELLED === "true",
    onlyUnclaimed: process.env.RADAR_ONLY_UNCLAIMED === "true",
    linkBudget: Number(process.env.RADAR_LINK_BUDGET ?? 60),
  };
}
