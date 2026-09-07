# DevInsight Dashboard

Live performance telemetry pipeline for my Godot game, **Ascent**. Every 5 seconds the running
game reports FPS and memory usage to a Postgres backend, which a live dashboard charts in real
time — and a CI gate automatically fails a build if it regresses performance by more than 10%
compared to the last one.

**Pipeline:** Godot (`godot/system_logger.gd`) → Supabase (Postgres + REST API) → `index.html`
dashboard (Chart.js), hosted on Vercel → GitHub Actions performance gate on every push.

The dashboard supports 5-minute through 24-hour query windows, build filtering and baseline
comparison, deploy/build markers, and a clickable performance-event timeline. Its headline
metrics emphasize tail behavior (P95 frame time and 1% low FPS) rather than relying only on an
average that can hide stutters. Build status is derived from explicit healthy, warning, and
regression thresholds.

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
on every push and pull request against `main`, comparing the latest build's average FPS (via the
`build_fps_summary` SQL view, grouped by `build_version`) against the previous build. A regression
over 10% fails the CI check — the same category of gate used in production game/perf engineering,
not something typically found in tutorial-tier portfolio projects.

The gate's decision logic lives in `scripts/regression-core.mjs`, kept free of network calls and
`process.exit` so it can be unit tested; `check-regression.mjs` is only the shell that fetches data
and turns a verdict into an exit code.

**A gate that stays honest when the data is thin.** A build average is only a measurement if
enough samples sit behind it. The logger reports every 5 seconds, so a build with 4 rows
represents about 20 seconds of play — an average that a single load screen can move further than
a genuine regression would. Failing CI on that makes the gate flaky rather than strict, so builds
under 30 samples are reported as skipped instead of judged, and a baseline that thin is not used
as a reference at all. Build selection also sorts on `last_seen` and requires a differing
`build_version` rather than trusting the query's row order, so replaying telemetry for an old
build can't quietly promote it to "latest" and compare a build against itself.

**Schema kept in the repo, not just in the console.** `supabase/schema.sql` is the source of
truth for the database side: the `system_logs` table, its indexes, the row-level security policies,
and the `build_fps_summary` view the CI gate reads. It matters for two reasons. The anon key is
embedded in the shipped game client, so it is public by design — the RLS policies are the only
thing limiting what that key can do, and they grant insert and select and nothing else, so a leaked
key cannot rewrite or erase history. And the whole pipeline depends on this schema, so a reader can
now inspect it and the project can be rebuilt from the repository alone. The script is re-runnable
and was verified by applying it to a local Postgres 16 instance, inserting the client's exact
payload as the `anon` role, confirming update and delete are refused, and running the CI gate
against the resulting view output.

## Stack

- **Godot** — game client, posts telemetry via `HTTPRequest`
- **Supabase** — Postgres + REST API, RLS-locked anon key (insert/select only)
- **Vercel** — static dashboard hosting
- **GitHub Actions** — CI performance regression gate

## Database setup

Apply the schema through the Supabase SQL editor, or directly:

```sh
psql "$SUPABASE_DB_URL" -f supabase/schema.sql
```

## Local checks

The dashboard's calculations live in a dependency-free module and are tested with no install step,
straight from a clone:

```sh
npm test          # node --test scripts/*.test.mjs
```

The browser tests need Playwright, so they are a separate command and a separate file extension
(`.uitest.mjs`) to keep the line above dependency-free:

```sh
npm ci
npx playwright install --with-deps chromium
npm run test:ui   # node --test scripts/*.uitest.mjs
```

Both run in CI and both gate the regression check, so a change that breaks the maths or the page
cannot reach `main` on a green build.

To look at the dashboard by hand, serve the repository with any static file server (for example
`python3 -m http.server 8000`) and open [`http://localhost:8000/?demo=1`](http://localhost:8000/?demo=1).
Demo mode uses a deterministic in-browser dataset containing two builds, FPS drops, and a memory
spike, so every feature can be exercised without a running Godot session or Supabase credentials.
Production mode remains the default; the demo dataset is only enabled by the explicit `?demo=1`
query parameter. Chart.js is checked into `vendor/` so the dashboard and demo stay testable when a
CDN is unavailable.

## Notes on the browser tests

Unit tests cover the arithmetic, but arithmetic is not what usually breaks a dashboard. A renamed
element id, a typo in a module import, or a Chart.js call that throws all leave the calculations
correct and the page blank — and leave a unit-test suite green. `scripts/dashboard-ui.uitest.mjs`
loads the real `index.html` in headless Chromium and asserts on what a visitor actually gets: that
every headline metric holds a number rather than a placeholder, that both canvases contain drawn
pixels, that the range buttons and build filter redraw, that pause/resume/refresh move the
connection state, that clicking a performance event highlights a point on the FPS chart, and that
an unreachable backend produces a visible **Offline** state with a working retry button instead of
an empty screen. Any console error or uncaught exception fails the run outright.

The suite was checked against deliberate breakage rather than assumed to work. Five mutations were
introduced one at a time — a renamed element id, a broken module import path, a flipped sign in the
build comparison, a swallowed offline state, and unwired event-click handlers — and each was caught
(7/8, 8/8, 1/8, 1/8 and 1/8 tests failing respectively). The whole suite runs in about four
seconds; Playwright's default 30-second wait is lowered to five, since the page renders from a
local fixture and a slow render is a failure rather than a delay.
