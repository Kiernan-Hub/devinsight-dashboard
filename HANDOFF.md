# Handoff — DevInsight Dashboard

Written 2026-09-10 so a fresh chat can continue this project with zero re-derivation. If you're
a new Claude session picking this up: read this whole file before touching anything. It
replaces re-deriving context from git log/diffing — that's slower and less reliable than what's
written here.

## Where things stand right now

`main` is clean, all four planned phases are merged and pushed, and both CI workflows are
confirmed green on the latest commit (`ce12d26`) — verified via GitHub's public REST API, not
assumed from a local pass. There is exactly **one blocking item** standing between "the code is
right" and "the live system is fully working": see **The one blocker** below.

Nothing is mid-edit. Nothing is uncommitted. Safe to start fresh work immediately.

## The one blocker — do this first if the user hasn't already

`supabase/schema.sql` has moved far ahead of the live Supabase database. Last verified directly
against the live DB (via `curl` against the REST API) on 2026-09-09:

```
column system_logs.height does not exist
Could not find the table 'public.gameplay_events'
Could not find the table 'public.build_perf_by_height'
Could not find the table 'public.build_session_health'  (added since, definitely also missing)
```

**Fix:** the user needs to run `supabase/schema.sql` in the Supabase SQL editor (or
`supabase db execute --file supabase/schema.sql`). It's idempotent — safe to re-run. I cannot do
this myself; it needs their Supabase dashboard access, which I don't have.

**Do not be alarmed that things "don't work" live** — every dashboard panel that depends on
these (Performance by height, Build stability) was deliberately built to **degrade gracefully**:
they fetch through `fetchOptional()`, which swallows a 404/400 and hides the panel rather than
erroring. Connection status stays "Live", no false error banner. This was verified live against
the real unmigrated database, twice (once per panel). If the user reports "the new panels aren't
showing," the answer is almost certainly "migration not applied yet," not a bug.

Two leftover test rows from earlier live verification also still need cleanup (harmless, but
mentioned to the user before and apparently not yet run):

```sql
delete from system_logs where session_id in ('3f2504e0-4f89-41d3-9a0c-0305e82c3301', '4a67ad7f-bfe6-45eb-8ac1-8e65627b0dc9');
delete from sessions where id in ('3f2504e0-4f89-41d3-9a0c-0305e82c3301', '4a67ad7f-bfe6-45eb-8ac1-8e65627b0dc9');
```

## What this project is

Telemetry pipeline for the Godot game **Ascent** (a vertical climber). Started as an audit
engagement, then expanded into a 4-phase "make it full-stack" build. See `CLAUDE.md` for the
stack summary and `README.md` for full user-facing documentation (kept up to date throughout —
trust it over re-deriving from code).

**Critical structural fact, repeatedly relevant:** the actual game (`ascent/` — scenes, player,
level generator, renderer) is **gitignored** and lives outside this repo *on purpose* — a
deliberate design decision the user made and confirmed explicitly when asked. Only
`godot/system_logger.gd` (the telemetry client) is tracked. This has architectural
consequences that already bit once (see Phase 3 below) — don't assume CI can run "the real
game," because it can't; it has nothing to run.

## Phase-by-phase summary

### Audit (pre-Phase-1)
Found and fixed: CI gate compared telemetry unrelated to the pushed commit; anon Supabase key
could write arbitrary rows (public XSS + fake-regression risk); offline queue silently dropped
unsent rows on a race between flush and live-send; dashboard queried logs ascending (showed
stale data in wide windows); dashboard threw and falsely showed "Offline" on all-invalid data;
P95/1%-low metrics were computed from 5-second-sampled FPS, not real per-frame data (couldn't
see stutters); no committed DB schema existed at all. All fixed, tested, committed before Phase
1 began.

### Phase 1 — own the write path (commits `893e438`..`0b414f7`, `e356a3b`)
- New `api/ingest.js` (Vercel Function): the only write path into Supabase now. Validates via
  `lib/ingest-core.mjs` (pure logic, fully unit tested — read this file, it's the contract).
  Writes with the **service-role key**, held server-side only.
- Anon key is now **read-only** in Postgres (RLS insert policy dropped, `insert/update/delete`
  revoked from `anon`). This is the actual fix for "anyone can forge telemetry" — constraints
  alone can only bound *plausibility*, not stop a determined forger; removing the write grant is
  what closes it.
- New `sessions` table — one row per play session. `outcome` (clean/ended_unclean/abandoned/
  active) is inferred from **absence of data** the client can't fake: a session is only "clean"
  if it explicitly said so on the way out.
- **Incident, self-caught:** the ingest token was committed to this **public** repo. Server
  validation bounds shape, not plausibility — a public token let anyone forge believable
  telemetry. Fixed: token now loads at runtime from `res://ingest_token.txt` (inside gitignored
  `ascent/`) or `INGEST_TOKEN` env var, never from source. **The old token is still in git
  history and needs rotating** — I don't think this has been done. Ask the user, or check
  whether `INGEST_TOKEN` has been changed in Vercel since 2026-09-09.
- Godot client bumped through 0.4.0 → 0.5.0. Offline queue restructured to batch by session
  (a flat list couldn't record which build queued samples came from — a backlog flushed after
  an upgrade would misattribute to the running build, which the regression gate would then
  misread).
- **Verified live end-to-end**, including running the actual Godot game locally for ~40s and
  confirming real samples landed in Supabase with correct frame-timing data.

### Phase 2 — correlate performance with gameplay (commits `c265246`, `b350c06`)
- Samples now carry gameplay context (`height`, `platform_count`, `entity_count`, `lava_speed`)
  on the *same row* as frame timings — correlation is a column comparison, not a join.
- New views: `build_perf_by_height` (frame time vs platform count per 500-unit height band),
  `death_distribution`. New `gameplay_events` table (closed vocabulary: `run_start`, `run_end`,
  `death`, `powerup`, `checkpoint` — enforced at API and DB constraint both).
- Logger gained `register_context_provider(Callable)` / `log_event()` — **one-directional**:
  the logger knows nothing about Ascent, holds one Callable. A provider that throws/returns
  wrong type degrades to "no context," never breaks telemetry.
- Real game instrumented (`ascent/Scenes/level_generator.gd`, `lava.gd`) — since that dir is
  gitignored, the actual call sites are preserved as documentation in
  `godot/examples/instrumentation.gd` (committed, `.gdignore`d from the test harness so it
  doesn't break `godot/` parsing).
- Dashboard: "Performance by height" panel. Verified in demo mode (clear correlation shown) AND
  live against the missing-view state (degrades correctly).
- Build bumped to 0.6.0.

### Phase 3 — headless CI benchmark, no human required (commit `a0d54af`)
**User explicitly chose the scope here** when I flagged the gitignored-game conflict: three
options were offered (synthetic proxy / extract shared logic module / commit a minimal real
scene), user picked **synthetic proxy only** — original code, no real game logic exposed.
Remember this if extending: don't casually pull real Ascent code into `godot/` without asking
again, that boundary was a deliberate choice, not an oversight.

- `godot/benchmark/benchmark_model.gd` — pure, static, deterministic decision logic (hazard
  speed, spawn density, culling). `godot/benchmark/benchmark_scene.gd` — the SceneTree runner.
- **Non-obvious gotcha, worth knowing before touching this again:** originally measured frame
  time via the interval between engine `_process` callbacks (mirroring how
  `system_logger.gd` measures the real game). In `--headless` mode this turned out to be
  governed by an internal idle-loop pace (~145Hz, rock-stable regardless of actual workload —
  proven by 8x-ing the obstacle count with zero change in the reading). `Engine.max_fps = 0`,
  `OS.low_processor_usage_mode = false`, and a project-level vsync override *all* failed to
  move it. **Fix:** measure the workload's own wall-clock duration directly inside
  `_physics_process` (bracket with `Time.get_ticks_usec()`), sidestepping the outer loop
  entirely. This is now well-tested and documented in the script's own header — don't
  re-attempt the callback-interval approach without expecting to hit the same wall.
- Noise handling: single-trial P95 swung ±20%+ run-to-run from OS scheduling noise (measured
  empirically, not assumed). Fix: `scripts/run-benchmark.mjs` runs **3 trials, takes the
  minimum** (standard practice — scheduling noise only ever adds delay, never subtracts, so
  the min is the least-contaminated estimate of true cost).
- `scripts/benchmark-core.mjs` — pure comparison logic, unit tested. Thresholds: 30%
  regression / 15% warning, set with margin above the measured noise floor.
  `godot/benchmark/baseline.json` is a **deliberately committed golden file** — never written by
  the gate itself, only by `npm run benchmark:update-baseline` (a human runs it, reviews the
  diff, commits deliberately — same discipline as updating a snapshot test).
- New `.github/workflows/benchmark-gate.yml` (runs on push AND pull_request — the whole point
  is a pre-merge signal the human-telemetry gate structurally can't give). Downloads Godot
  4.7-stable from the **verified-live** official GitHub release URL (I fetched it for real
  during this work, confirmed the exact asset name/binary format — don't assume it needs
  re-checking unless bumping the Godot version).
- `perf-gate.yml` gained a `godot-tests` job — the GDScript test suites (52 checks) previously
  only ran locally, now run in CI too.
- **Verified**: ran locally end-to-end multiple times (including a deliberate stress-test to
  prove sensitivity: 79→8921 obstacles moved P95 from 0.36ms→5.49ms). **Also verified on the
  actual GitHub Actions Linux runner** — pulled job-level status via the public API (no `gh`
  auth available in that session; `gh` is now installed via brew but never authenticated —
  `gh auth status` returns "not logged into any hosts"). A green `benchmark` job step is
  meaningful evidence, not just a checkmark: `run-benchmark.mjs` only exits 0 for
  `healthy`/`warning`/`no_baseline`, so success implies 1800/1800 ticks completed, no stale
  baseline mismatch, and a passing comparison.

### Phase 4 — surface build stability (commit `ce12d26`)
- New `build_session_health` view: rolls `session_summary.outcome` up per build into a
  crash/abandon rate. `active` sessions excluded from the rate (haven't concluded as anything
  yet — matches `session_summary`'s own philosophy). `nullif()` guards the "no concluded
  sessions yet" case so a brand-new build reads as "—, no concluded sessions yet" rather than a
  misleading 0% or a divide-by-zero.
- Dashboard: "Build stability" panel, color-coded (red ≥25%, amber ≥8%, green below), sample
  count riding alongside the percentage so 100% of 1 isn't confused with 100% of 200.
- Verified: colors checked via actual DOM `className`, not screenshot appearance (they look
  similar at small size on a dark background — don't trust the screenshot alone if extending
  this). Null-rate path exercised for real via a genuine demo-mode 4th build. Missing-view
  degradation re-verified live (same pattern as Phase 2's height panel).

## Test inventory (all passing as of `ce12d26`)

```
npm test            # 57 Node tests: scripts/*.test.mjs + lib/*.test.mjs
npm run test:godot  # 52 Godot checks: test_logger_queue.gd (38) + test_benchmark_model.gd (14)
npm run benchmark    # runs the actual 3-trial headless benchmark against baseline.json
```

Both GitHub Actions workflows (`perf-gate.yml`, `benchmark-gate.yml`) run these in CI. Both are
green on `ce12d26` — reconfirmed via `curl https://api.github.com/repos/Kiernan-Hub/devinsight-dashboard/actions/runs`
(works unauthenticated for a public repo; job logs do NOT work unauthenticated — 403 "Must have
admin rights" — use the browser to view logs if ever needed, but `gh` auth is the better fix if
this comes up again).

## Environment / tooling notes for whoever picks this up

- **Node and Godot are installed locally** via Homebrew (`/opt/homebrew/bin/node`,
  `/Applications/Godot.app/Contents/MacOS/Godot`, version 4.7.stable.official). Neither was
  present at the start of this engagement — installed deliberately mid-session. `export
  PATH="/opt/homebrew/bin:$PATH"` before running `npm`/`node` if a fresh shell doesn't have it.
- **`gh` CLI is installed but not authenticated.** `gh auth login` needs an interactive flow
  this environment can't do. The public GitHub REST API via `curl` covers run/job status just
  fine for a public repo; only log *downloads* need real auth.
- No `package-lock.json` — zero npm dependencies, by design. CI uses `npm install`, not
  `npm ci`, deliberately for this reason.
- `ascent/` (the real game) exists locally in this checkout and is fully gitignored. If you're
  a fresh session in a fresh clone, it **will not be there** — that's expected, not a problem,
  per the "game lives outside the repo" design.

## Open threads / natural next steps

Nothing is currently broken or half-finished. These are options, not obligations — pick based
on what the user actually asks for next:

1. **Confirm the migration was applied** (see blocker above) and that gameplay telemetry is
   actually landing — would need to re-run the same live `curl` probes against Supabase used
   throughout this engagement, then check the dashboard panels populate for real.
2. **Confirm the ingest token was rotated** — it was exposed in git history; I flagged it but
   never confirmed a rotation happened.
3. Roadmap items mentioned but not started: a session explorer (drill into individual
   sessions), regression alerts (notify on a real gate failure rather than requiring someone to
   check the dashboard), possibly wiring `benchmark-gate.yml`'s result onto a PR comment.
4. A fresh, skeptical audit pass across all 4 phases together, now that they're settled — the
   kind of review that catches integration issues invisible when each phase was reviewed in
   isolation.

## How to work in this repo (patterns established, worth continuing)

- Pure logic lives separate from I/O/orchestration, always: `lib/ingest-core.mjs` vs
  `api/ingest.js`; `scripts/dashboard-core.mjs` vs `index.html`; `scripts/benchmark-core.mjs`
  vs `scripts/run-benchmark.mjs`; `godot/benchmark/benchmark_model.gd` vs `benchmark_scene.gd`.
  Keep doing this — it's what makes everything unit-testable without booting an engine/server.
- Every dashboard render path uses `textContent`/DOM construction, **never** `innerHTML`, for
  anything database-derived (`build_version` etc. are attacker-choosable since anon can still
  read, and used to be writable). Don't regress this.
- Optional dashboard data (things that depend on the pending migration) fetches through
  `fetchOptional()` and hides its panel on failure rather than erroring — established pattern,
  reuse it for any new optional panel.
- Before trusting any claim about the live system, verify it directly (curl against Supabase/
  Vercel, run the actual test suite, check CI via the API) rather than asserting from memory of
  what "should" be true. This whole engagement's credibility rests on that discipline — don't
  drop it.
- Commit messages in this repo are long and explain *why*, including false starts and what was
  ruled out. Keep doing that; it's clearly load-bearing for a portfolio piece meant to be read.

## Files worth reading first, in order, if picking this up cold

1. This file.
2. `README.md` — user-facing truth, kept current every phase.
3. `CLAUDE.md` — short stack summary + tone/audience notes (user is new to CS, wants portfolio-
   grade work, plain-language explanations).
4. `supabase/schema.sql` — the whole data model, heavily commented.
5. `lib/ingest-core.mjs` and `scripts/benchmark-core.mjs` — the two most important pure-logic
   contracts.
