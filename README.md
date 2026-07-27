# issue-radar

Watches GitHub repos and pushes issue/PR activity into one Discord channel, with
an emphasis on the thing that actually matters: knowing when someone else opens a
PR against an issue you had claimed.

Two processes over one SQLite file:

- **poller** — one-shot, run by a systemd timer. Pulls, diffs, resolves links,
  queues events. Never talks to Discord.
- **bot** — long-lived gateway client. Drains the event queue, serves slash
  commands. Never talks to GitHub except to validate `/watch`.

They are split so a Discord outage cannot lose events (they sit in the queue and
drain on reconnect) and a poller crash cannot take the gateway down.

## Requirements

Node 26+. It runs the TypeScript directly via native type stripping and uses the
built-in `node:sqlite`, so there is no build step and no native dependency.

## Setup

```
npm install
cp .env.example .env      # fill in tokens
npm run register          # publish slash commands (once, and after changing them)
npm run bot
```

Deploy the units in `deploy/` for the poller timer and the bot service.

## Commands

| command | what it does |
|---|---|
| `/watch owner/repo` | Validates the repo, seeds every issue **silently**, starts polling. No announcements during backfill — a busy repo would otherwise dump hundreds of embeds at once. |
| `/unwatch owner/repo` | Stops watching and forgets its issues. |
| `/status` | Table of tracked issues: age, state, PR linked, owner. Pure DB read, no API calls, instant. |
| `/issue <n>` | Full detail for one issue, including PR links retired by a `disconnected` event. |
| `/claim <n>` | Marks an issue as yours. An external PR on it now raises a race warning. |

## How it decides what to say

A poll only produces events for real diffs: unseen issue, open↔closed, a change
of `state_reason` (`completed` vs `not_planned` — "closed as not planned" is not
a fix), or a change to a *watched* label. Everything else updates the row in
silence.

Issues whose state moved get their timeline read for `connected`/`disconnected`,
`cross-referenced` from a PR, and `closed` with a `commit_id` (resolved back to
its PR). PR authors are compared against `GITHUB_HANDLE` and tagged `mine` or
`external`.

Delivery keeps the channel readable: one embed per issue, edited in place as
things change; colour by state and a struck-through title once closed. The
exceptions are `race_warning` and `pr_merged`, which post fresh with a ping
because they need a decision. More than `RADAR_DIGEST_THRESHOLD` quiet events in
a cycle collapse into a single digest.

## Things that bit us, recorded so they don't again

- **The issues endpoint returns pull requests too.** On `Textualize/rich`, 142 of
  167 items in one window were PRs. They are split out by the `pull_request` key.
- **Cross-references come from other repos.** A popular library gets referenced by
  every downstream project; `rich` issue #164 cross-references `pymc-devs/pymc`
  #7634. Taking that number at face value stores a link to a PR that doesn't
  exist in your namespace. Timeline sources are filtered on `repository.full_name`.
- **ETags are keyed to the full URL,** and `since` moves whenever a cycle returns
  data — so the cycle right after a change can never 304; the second consecutive
  quiet cycle is the one that goes free. The sync cursor is therefore taken from
  `max(updated_at)` of the data, never from wall-clock time, which would change
  the URL every cycle and defeat conditional requests completely.
- **`since` is inclusive,** so the boundary issue reappears every cycle. It is
  deduped at the diff, not at the fetch.
- **Poll upserts must not clobber local columns.** `message_id`, `claimed_by` and
  `stale_notified_at` are ours, not GitHub's.

## Rate limits and failure

Octokit handles 5xx retry with jitter and primary/secondary limit waits. On top
of that, each cycle checks remaining core quota; below `RADAR_RATE_FLOOR` the
poller writes a backoff gate next to the DB and skips firings, doubling the pause
from 15 up to 120 minutes until quota recovers. The systemd interval itself stays
fixed — a one-shot process can't widen its own timer, so it gates itself instead.

Events are marked delivered only after Discord confirms, so a crash mid-drain
re-delivers rather than dropping. A 404 on an edit (someone deleted the embed)
clears the stored `message_id` and reposts instead of wedging the queue.

## Tests

```
npm test          # 24 tests, no network
npm run typecheck
```
