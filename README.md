<h1 align="center">OASIS</h1>
<p align="center">A Discord bot that watches GitHub repos you don't own, so you hear about an issue before someone else fixes it.</p>

<p align="center">
  <img alt="Node 26+" src="https://img.shields.io/badge/node-%E2%89%A526-5FA04E?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="discord.js 14" src="https://img.shields.io/badge/discord.js-14-5865F2?logo=discord&logoColor=white">
  <img alt="SQLite via node:sqlite" src="https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?logo=sqlite&logoColor=white">
  <img alt="No build step" src="https://img.shields.io/badge/build-none-lightgrey">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue">
</p>

<p align="center">
  <a href="#what-it-does">What</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#configuration">Config</a> ·
  <a href="#deployment">Deploy</a> ·
  <a href="#api-behaviour-worth-knowing">Gotchas</a>
</p>

<!-- HERO: replace with a GIF of a race_warning landing in the channel -->

## What it does

You `/watch` a repo. From then on, new issues, closes, linked pull requests and releases arrive in one Discord channel on their own.

The part that isn't a news feed: you can `/claim` an issue you intend to work on. If somebody else opens a pull request against it, you get a **race warning** — a pinged, red embed — instead of finding out when your own PR is closed as a duplicate. Every PR author is compared against your GitHub handle and tagged `mine` or `external`, which is what makes that possible.

Two processes share one SQLite file:

- **poller** — one-shot, run by a systemd timer. Pulls, diffs, resolves issue↔PR links, queues events. Never talks to Discord.
- **bot** — long-lived gateway client. Drains the queue, serves slash commands. Never talks to GitHub except to validate `/watch`.

Split so a Discord outage cannot lose events — they sit in the queue and drain on reconnect — and a poller crash cannot take the gateway down.

## Quickstart

Requires **Node 26+**. It runs the TypeScript directly via native type stripping and uses the built-in `node:sqlite`, so there is no build step and no native dependency to compile.

```bash
git clone https://github.com/MaheshBhushan/oasis.git oasis
cd oasis
npm install
cp .env.example .env      # fill in tokens, see Configuration
npm run register          # publish slash commands (once)
npm run bot               # expect: [bot] ready as <name>
```

Then in Discord: `/watch Textualize/rich`.

> [!IMPORTANT]
> Invite the bot with **both** the `bot` and `applications.commands` scopes, or the slash commands never appear. It also needs **Read Message History** — without it the bot cannot fetch its own embeds to edit, and every update reposts instead.
>
> `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=84992`

## Commands

| Command | What it does |
|---|---|
| `/watch <repo>` | Start tracking. Answers in about a second with the five most recent issues. Accepts `owner/repo`, a browser URL, a clone URL, an SSH remote, or an issue deep link. |
| `/unwatch <repo>` | Stop tracking and forget its issues. |
| `/status` | Table of tracked issues — age, state, PR linked, owner. Pure DB read, no API calls. |
| `/issue <n>` | Full detail for one issue, including PR links retired by a `disconnected` event. |
| `/claim <n>` | Mark an issue as yours. An external PR on it now raises a race warning. |

`/watch` does **not** backfill history. The cursor starts at registration time, because a full history pull on a large repo is thousands of rows nobody reads.

## What arrives in the channel

| Event | Delivery |
|---|---|
| `issue_opened`, `issue_closed` | One embed per issue, **edited in place** as state changes. Colour by state, title struck through once closed. |
| `pr_opened_for_issue`, `pr_closed_unmerged` | Folded into that issue's embed. |
| `pr_merged` | Posts fresh with a ping. |
| `race_warning` | Posts fresh with a ping. External PR on an issue you claimed. |
| `release_published` | Standalone embed with tag, notes and author. Announced once. |
| `stale` | Open with no activity for `RADAR_STALE_DAYS`. |

More than `RADAR_DIGEST_THRESHOLD` quiet events in one cycle collapse into a single digest embed, so a busy repo can't flood the channel. Alerts are never batched.

## How it decides what to say

A poll only produces events for real diffs: an unseen issue, open↔closed, a change of `state_reason` (`completed` vs `not_planned` — "closed as not planned" is not a fix), or a change to a *watched* label. Everything else updates the row in silence.

Issues whose state moved get their timeline read for `connected`/`disconnected` events, `cross-referenced` events sourced from a PR, and `closed` events carrying a `commit_id` (resolved back to its PR). When the timeline yields nothing, a PR body search for `fixes #N` acts as a fallback — search has a far tighter quota, so it is not spent routinely.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `GITHUB_TOKEN` | — | Fine-grained, public repos read-only is enough |
| `GITHUB_HANDLE` | — | Drives `mine` vs `external` attribution |
| `DISCORD_TOKEN` | — | |
| `DISCORD_CHANNEL_ID` | — | Single channel for all watched repos |
| `DISCORD_APP_ID` | derived from token | Only needed if `--register` can't derive it |
| `RADAR_DB` | `radar.db` | Use an absolute path; both processes open it |
| `RADAR_LABELS` | `bug,good first issue` | Label changes outside this set are ignored |
| `RADAR_STALE_DAYS` | `30` | |
| `RADAR_DIGEST_THRESHOLD` | `5` | |
| `RADAR_RATE_FLOOR` | `500` | Poller pauses below this many remaining calls |
| `RADAR_PING` | `@here` | Discord user id for actionable alerts |

## Repository structure

```
src/
  bot.ts         gateway client, slash commands
  poller.ts      poll cycle, release check, rate-limit backoff
  diff.ts        which changes are worth an event
  links.ts       timeline -> issue/PR links, attribution
  events.ts      typed event queue, stale sweep
  delivery.ts    queue drain, edit-in-place vs post-fresh
  render.ts      embeds
  github.ts      API client, conditional requests
  db.ts          storage layer
  schema.sql     tables
  slug.ts        repo reference parsing
  radar.test.ts  test suite
deploy/          systemd unit + timer
```

## Deployment

```bash
mkdir -p ~/.config/systemd/user
cp deploy/*.service deploy/*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now issue-radar-bot.service issue-radar-poll.timer
loginctl enable-linger "$USER"     # or user units die on logout
```

The timer fires on a fixed interval. When GitHub quota drops below `RADAR_RATE_FLOOR` the poller writes a backoff gate next to the DB and skips firings, doubling the pause from 15 up to 120 minutes — a one-shot unit cannot widen its own timer, so it gates itself.

## API behaviour worth knowing

Recorded because each one cost real debugging time.

- **The issues endpoint returns pull requests too.** On `Textualize/rich`, 142 of 167 items in one window were PRs. They are split out by the `pull_request` key.
- **Cross-references arrive from other repositories.** `rich` issue #164 cross-references `pymc-devs/pymc#7634`. Taking that number at face value stores a link to a PR that doesn't exist in your namespace and 404s when fetched. Timeline sources are filtered on `repository.full_name`.
- **ETags key on the full URL**, and `since` moves whenever a cycle returns data — so the cycle right after a change can never 304; the *second* consecutive quiet cycle is the one that costs nothing. The sync cursor is therefore taken from `max(updated_at)` of the data, never wall-clock time, which would change the URL every cycle and defeat conditional requests entirely.
- **`since` is inclusive**, so the boundary issue reappears every cycle. It is deduped at the diff, not the fetch.
- **A deferred Discord interaction dies after 15 minutes.** Anything slower than that has to answer first and work afterwards.
- **Poll upserts must not clobber local columns.** `message_id`, `claimed_by` and `stale_notified_at` are ours, not GitHub's.

## Tests

```bash
npm test          # 41 tests, no network
npm run typecheck
```

Covers the diff rules, the PR/issue split, race warnings, the stale guard, digest batching, edit-in-place, the 404-repost path, repo reference parsing, and the body-regex fallback staying dormant while the timeline is productive.

## License

MIT
