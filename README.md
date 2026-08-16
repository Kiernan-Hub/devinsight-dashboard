# DevInsight Dashboard

Live performance telemetry pipeline for my Godot game, **Ascent**. Every 5 seconds the running
game reports FPS and memory usage to a Postgres backend, which a live dashboard charts in real
time — and a CI gate automatically fails a build if it regresses performance by more than 10%
compared to the last one.

**Pipeline:** Godot (`godot/system_logger.gd`) → Supabase (Postgres + REST API) → `index.html`
dashboard (Chart.js), hosted on Vercel → GitHub Actions performance gate on every push.

## Notable engineering decisions

**Offline retry queue.** If the game can't reach Supabase (dropped connection, brief outage),
data points aren't silently lost — they queue locally on disk. On reconnect, the entire backlog
is sent as a single bulk insert rather than trickling out one row every 5 seconds, so a long
outage doesn't leave live gameplay data stuck behind a slow-draining queue.

Building this surfaced two real bugs worth mentioning:
- **A blocking design flaw**: the first version prioritized flushing the backlog over collecting
  new data, so as long as anything was queued, fresh telemetry stopped being gathered entirely.
  Fixed by giving the flush its own independent request instead of sharing one with live sends.
- **A JSON type-coercion bug**: entries that round-tripped through the local disk queue failed to
  re-insert into Postgres (`22P02: invalid input syntax for type integer`). Godot's JSON parser
  doesn't distinguish `60` from `60.0` — every number becomes a float on parse — so a queued FPS
  value silently drifted from an int to a float and got rejected by Postgres's `integer` column
  on the way back out. Fixed by explicitly re-casting on load.

**CI performance gate.** `.github/workflows/perf-gate.yml` runs `scripts/check-regression.mjs`
on every push to `main`, comparing the latest build's average FPS (via the `build_fps_summary`
SQL view, grouped by `build_version`) against the previous build. A regression over 10% fails
the CI check — the same category of gate used in production game/perf engineering, not something
typically found in tutorial-tier portfolio projects.

## Stack

- **Godot** — game client, posts telemetry via `HTTPRequest`
- **Supabase** — Postgres + REST API, RLS-locked anon key (insert/select only)
- **Vercel** — static dashboard hosting
- **GitHub Actions** — CI performance regression gate
