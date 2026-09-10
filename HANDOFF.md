# Handoff — DevInsight Dashboard

Rewritten 2026-09-10, end of a cloud (claude.ai/code) session, specifically so a **fresh local
Claude Code session** (running on the user's Mac, with real tool access — Supabase reachable,
Godot installed, `ascent/` present) can pick this up with zero re-derivation. If you're that
session: read this whole file before touching anything. It replaces re-deriving context from
`git log`/diffing — slower and less reliable than what's written here.

**Current branch:** `claude/optimistic-galileo-uz4e47`, pushed to `origin`, clean, nothing
uncommitted, HEAD is `9f03f62`. `main` is separately at `ce12d26` (one commit behind — see
"What's not yet merged to main" below).

## Why this file was rewritten (read this first)

The cloud session that just ended could not reach the live Supabase database (network policy
blocked `savgtraqvbqkbblhhhxe.supabase.co` — confirmed via a 403 on CONNECT, not assumed), did
not have Godot installed, and did not have `ascent/` (gitignored, lives outside this repo).
So it could only do static/code-level work: run `npm test`, read and edit files, commit, push.
**It could not verify anything about the live system.** Every claim below about the live
database, the deployed Vercel function, or the real game is either carried forward unverified
from the previous (local) session's notes, or explicitly marked unverified. Don't treat silence
as confirmation — re-check the live-system items yourself now that you have real access.

## What's not yet merged to main

Three commits sit on `claude/optimistic-galileo-uz4e47` ahead of `main` (`ce12d26`), not yet
merged, no PR opened (user didn't ask for one):

- `186674e` — fixed `npm test` (was completely broken on Node 22, see below)
- `cdee2e4` — fixed two auth/validation bugs in `api/ingest.js` (see below)
- `9f03f62` — this file, updated with the previous version of these notes

**These need to reach `main` for the fixes to actually protect the deployed system** — Vercel
presumably deploys from `main`, so the fail-open ingest-token bug (see below) is still live in
production until this branch is merged. This should be one of the first things you do: either
merge/fast-forward `main` to this branch, or open a PR and get it merged. Confirm which
deploy branch Vercel is actually watching before assuming `main` — check `vercel.json` and/or
the Vercel dashboard if you have access.

## This session's work (cloud, 2026-09-10) — full detail

### Fix 1 — `npm test` was silently running 0 of 57 tests (commit `186674e`)

`package.json`'s `test` script was `node --test scripts/ lib/` — passing two **directories** as
arguments. On Node 20 this works (Node scans a directory argument for test files). On Node 22
it doesn't: Node resolves each path as a module specifier and throws `MODULE_NOT_FOUND` before
a single test runs. In this cloud session (Node 22.22.2) the entire suite failed — 0 of 57 — in
a way that looked like a content problem (`not ok 1 - lib`, `not ok 2 - scripts`, no other
detail) until each test file was run individually and all passed.

**Root cause of why CI never caught this:** both `.github/workflows/perf-gate.yml` and
`benchmark-gate.yml` pin `node-version: 20`, while `package.json` declares
`"engines": { "node": ">=20" }` — claiming a range, verifying exactly one point in it.

**Fix:** `test` script now reads `node --test lib/*.test.mjs scripts/*.test.mjs` — shell-expanded
file globs, which resolve to real file paths on every Node version (rejected `node --test
"scripts/*.test.mjs"`, Node's own glob support, because that syntax only exists on Node 22+ and
would invert the bug — green on 22, broken on the Node 20 that CI actually runs). The
`perf-gate.yml` unit-test job (`test:`) is now a matrix over `node-version: [20, 22]` with
`fail-fast: false`, so a version-dependent break can't hide behind a single pinned version again.

**If you're touching this again:** don't "simplify" the test script back to directory args or
to Node's bare glob syntax without re-reading the paragraph above — both look like harmless
cleanups and both reintroduce the bug on one Node major or the other.

### Fix 2 — two protections in `api/ingest.js` that did nothing in deployment (commit `cdee2e4`)

Found by a cross-phase read of the write path (this was the "audit" the user's prior session
left as an open next-step). Both are the dangerous kind of bug: the code *reads* as protected
in review, but the protection is a no-op in the actual deployed configuration.

**2a. Fail-open ingest token check.** The auth check was:
```js
if (INGEST_TOKEN) {
  const provided = req.headers["x-ingest-token"];
  if (provided !== INGEST_TOKEN) return send(res, 401, ...);
}
```
If the `INGEST_TOKEN` env var is unset, this doesn't weaken auth — it **skips it entirely**,
leaving `/api/ingest` open to anyone, writing with the service-role key. This is exactly the
hole Phase 1 was built to close, reachable purely through misconfiguration.

This is not hypothetical: per the previous session's notes (still unconfirmed — see "the one
blocker" section below), **the original ingest token was committed to this public repo and
still needs rotating.** A naive rotation — delete the old value in Vercel, then set the new one
— opens exactly this fail-open window for however long the variable is unset. If you're doing
that rotation now that you (the local session) presumably have Vercel access, this fix matters
directly: verify it's actually deployed (see checklist below) before doing the rotation, or you
risk a window where any request during the gap is silently accepted with the old check but now
rejected outright with the new check (503) — which is the correct, safe behavior, just confirm
it's live first.

Fixed: now returns `503` with a logged reason when `INGEST_TOKEN` is unset, before touching the
database.

**2b. Body-size limit that only checked one of two shapes.** The 256 KB limit:
```js
if (typeof body === "string") {
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return send(res, 413, ...);
  ...
}
```
only ran when `req.body` arrived as a string. Vercel's Node runtime parses an
`application/json` request into an object *before* the handler runs, so on the actual deployed
path `typeof body === "string"` is false and this limit applied to **zero real requests**.

Fixed: now checks the declared `Content-Length` header up front (covers the parsed-object
shape), with the original string-based check kept as a fallback for chunked requests that carry
no `Content-Length`. The comment above `MAX_BODY_BYTES` was also corrected — it previously
overclaimed that the limit stopped a large field from "burning function memory," which isn't
true since the runtime has already parsed the body by the time the handler runs; the honest
claim is just "rejects an oversized payload before further work and before the database."

**Both fixes have regression tests** in `lib/ingest-api.test.mjs` (new tests: "an unconfigured
ingest token fails closed rather than open", "an oversized body is refused on the parsed-object
path", "a normal Content-Length is unaffected"). Both new tests were manually confirmed to
**fail** against the pre-fix code and pass against the fix — a test that passes either way
proves nothing, so this was checked deliberately, not assumed. Suite is now 60 tests: 59 pass,
1 skip (`logger-sync`, correctly skips when `ascent/` is absent — it will *run* for you locally
if `ascent/` is present, so watch for it actually passing, not skipping, once you have that dir).

### Open finding — NOT fixed, needs a decision, flagging for you

**Possible duplicate rows on a partial multi-table write in `api/ingest.js`.** The handler
writes three tables as sequential, un-batched requests: `sessions`, then `system_logs`, then
`gameplay_events`. If `system_logs` succeeds and the following `gameplay_events` write then
fails, the handler catches the error and returns `502`. The Godot client (`system_logger.gd`)
re-queues and retries the *entire batch* on any 5xx — including the samples that already made
it into `system_logs` on the failed attempt. There's no dedup/idempotency key on `system_logs`
to prevent the retry from inserting them a second time.

Likelihood is low (would need `system_logs` to succeed and `gameplay_events` to fail on the
same request), but the consequence is real: inflated sample counts and skewed averages feeding
straight into `build_fps_summary`, which is what the CI regression gate reads. This is exactly
the kind of bug that's invisible when Phase 1 (retry semantics) and Phase 2 (the events table)
are each reviewed in isolation — it only shows up looking at both together.

**Why not fixed already:** the real fixes both need a decision, not just a patch:
1. A client-generated idempotency key (e.g. a UUID per batch, or a hash) with a unique
   constraint on `system_logs`/`gameplay_events` to make retries safe — needs a schema change,
   stacked on top of the migration that's already pending (see below).
2. Write all three tables inside one Postgres function (RPC) so the whole batch is atomic —
   avoids the schema change but is a bigger refactor of `api/ingest.js`.

Ask the user which they'd prefer before picking one. Don't just pick the "smaller" one
unilaterally — this affects data integrity for a portfolio piece the user cares about being
correct, not just shippable.

## The standing blocker — carried forward from before, status genuinely unknown right now

This is unchanged from the previous handoff and **was not re-verifiable in the cloud session**
(no network access to Supabase). It is the single most important thing to check first now that
you have real local tool access.

`supabase/schema.sql` may still be far ahead of the live Supabase database. As of the last time
this was checked directly (2026-09-09, from a local session, via `curl` against the live REST
API):

```
column system_logs.height does not exist
Could not find the table 'public.gameplay_events'
Could not find the table 'public.build_perf_by_height'
Could not find the table 'public.build_session_health'
```

**Do this first:**
1. Re-run the same kind of live probe against Supabase to see if the migration was applied
   since 2026-09-09 (it may well have been — just genuinely unknown from here). Something like:
   ```bash
   curl -s "$SUPABASE_URL/rest/v1/system_logs?select=height&limit=1" \
     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
   curl -s "$SUPABASE_URL/rest/v1/gameplay_events?select=event_type&limit=1" \
     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
   curl -s "$SUPABASE_URL/rest/v1/build_perf_by_height?select=*&limit=1" \
     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
   curl -s "$SUPABASE_URL/rest/v1/build_session_health?select=*&limit=1" \
     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
   ```
   (`SUPABASE_URL` and the anon key are both visible in `index.html`, currently
   `https://savgtraqvbqkbblhhhxe.supabase.co` — grep for `SUPABASE_URL` there if it's moved.)
2. If still missing: the user needs to run `supabase/schema.sql` in the Supabase SQL editor, or
   `supabase db execute --file supabase/schema.sql`. It's idempotent — safe to re-run.
3. If it's applied and tables/columns exist: open the live dashboard and confirm the "Performance
   by height" and "Build stability" panels actually render, not just that the schema exists.

**If the migration isn't applied, the dashboard will look fine anyway** — every panel that
depends on the new schema fetches through `fetchOptional()`, which swallows a 404/400 and hides
the panel rather than erroring. Connection status stays "Live." If the user says "the new panels
aren't showing," the answer is almost certainly "migration not applied," not a new bug — but
verify, don't assume, given how stale this information now is.

Two leftover test rows from earlier live verification also may still need cleanup (harmless if
left, but should get done):
```sql
delete from system_logs where session_id in ('3f2504e0-4f89-41d3-9a0c-0305e82c3301', '4a67ad7f-bfe6-45eb-8ac1-8e65627b0dc9');
delete from sessions where id in ('3f2504e0-4f89-41d3-9a0c-0305e82c3301', '4a67ad7f-bfe6-45eb-8ac1-8e65627b0dc9');
```

## The other standing item — ingest token rotation, status also genuinely unknown

The original `INGEST_TOKEN` was committed to this **public** repo at some point and is still in
git history. Per the previous local session's notes, this had not been rotated as of
2026-09-09, and the cloud session had no way to check Vercel env vars. **Check whether
`INGEST_TOKEN` in Vercel has been changed since 2026-09-09.** If not, rotate it now — and do it
only *after* confirming fix 2a above (the fail-open bug) is actually live in the deployed
function, i.e. after merging `claude/optimistic-galileo-uz4e47` (or at least `cdee2e4`) to
whatever branch Vercel deploys from. Rotating against the old fail-open code means a bad
rotation attempt (e.g. accidentally leaving the var empty for a moment) fails safe now instead
of fully open.

## What this project is

Telemetry pipeline for the Godot game **Ascent** (a vertical climber). Started as an audit
engagement, then expanded into a 4-phase "make it full-stack" build, then this cross-phase
audit session. See `CLAUDE.md` for the stack summary and tone/audience notes (user is new to
CS, wants portfolio-grade work, plain-language explanations, no unexplained jargon). See
`README.md` for full user-facing documentation (kept up to date throughout — trust it over
re-deriving from code, though re-confirm it still matches after you touch anything).

**Critical structural fact, repeatedly relevant:** the actual game (`ascent/` — scenes, player,
level generator, renderer) is **gitignored** and lives outside this repo *on purpose* — a
deliberate design decision the user made and confirmed explicitly when asked, previously. Only
`godot/system_logger.gd` (the telemetry client) and `godot/benchmark/`, `godot/examples/` are
tracked. This has architectural consequences that already bit once (Phase 3, headless CI
benchmark had to use a synthetic proxy instead of real game logic) — don't assume CI can run
"the real game," because it structurally can't; it has nothing to run. Don't casually pull real
Ascent code into `godot/` without asking the user again — that boundary was a deliberate
choice made explicitly, not an oversight to "fix."

**On this local machine, `ascent/` should actually be present** (per the prior local session's
environment notes) — that's the point of a local session vs. the cloud one that just ended.
Confirm it's there; if it's not, that's a genuine surprise worth flagging, not silently working
around.

## Phase-by-phase summary (all previously merged to main, `ce12d26` and earlier)

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
- **Incident, self-caught (original discovery):** the ingest token was committed to this
  **public** repo. Server validation bounds shape, not plausibility — a public token let
  anyone forge believable telemetry. Fixed at the time: token now loads at runtime from
  `res://ingest_token.txt` (inside gitignored `ascent/`) or `INGEST_TOKEN` env var, never from
  source. **The old token is still in git history and needs rotating** — see standing item
  above, still not confirmed done as of this rewrite.
- Godot client bumped through 0.4.0 → 0.5.0. Offline queue restructured to batch by session
  (a flat list couldn't record which build queued samples came from — a backlog flushed after
  an upgrade would misattribute to the running build, which the regression gate would then
  misread).
- **Verified live end-to-end** at the time, including running the actual Godot game locally for
  ~40s and confirming real samples landed in Supabase with correct frame-timing data. This was
  weeks before the current staleness — worth spot-checking again now that you have local access.

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
  live against the missing-view state (degrades correctly), at the time.
- Build bumped to 0.6.0.

### Phase 3 — headless CI benchmark, no human required (commit `a0d54af`)
**User explicitly chose the scope here** when flagged with the gitignored-game conflict: three
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
  entirely. This is well-tested and documented in the script's own header — don't re-attempt
  the callback-interval approach without expecting to hit the same wall.
- Noise handling: single-trial P95 swung ±20%+ run-to-run from OS scheduling noise (measured
  empirically, not assumed). Fix: `scripts/run-benchmark.mjs` runs **3 trials, takes the
  minimum** (standard practice — scheduling noise only ever adds delay, never subtracts, so
  the min is the least-contaminated estimate of true cost).
- `scripts/benchmark-core.mjs` — pure comparison logic, unit tested. Thresholds: 30%
  regression / 15% warning, set with margin above the measured noise floor.
  `godot/benchmark/baseline.json` is a **deliberately committed golden file** — never written by
  the gate itself, only by `npm run benchmark:update-baseline` (a human runs it, reviews the
  diff, commits deliberately — same discipline as updating a snapshot test).
- `.github/workflows/benchmark-gate.yml` (runs on push AND pull_request — the whole point is a
  pre-merge signal the human-telemetry gate structurally can't give). Downloads Godot
  4.7-stable from the official GitHub release URL, confirmed working at the time.
- `perf-gate.yml` gained a `godot-tests` job — the GDScript test suites (52 checks) previously
  only ran locally, now run in CI too.
- **Verified at the time**: ran locally end-to-end multiple times (including a deliberate
  stress-test to prove sensitivity: 79→8921 obstacles moved P95 from 0.36ms→5.49ms), and on the
  actual GitHub Actions Linux runner via the public API.

### Phase 4 — surface build stability (commit `ce12d26`)
- New `build_session_health` view: rolls `session_summary.outcome` up per build into a
  crash/abandon rate. `active` sessions excluded from the rate (haven't concluded as anything
  yet — matches `session_summary`'s own philosophy). `nullif()` guards the "no concluded
  sessions yet" case so a brand-new build reads as "—, no concluded sessions yet" rather than a
  misleading 0% or a divide-by-zero.
- Dashboard: "Build stability" panel, color-coded (red ≥25%, amber ≥8%, green below), sample
  count riding alongside the percentage so 100% of 1 isn't confused with 100% of 200.
- Verified at the time: colors checked via actual DOM `className`, not screenshot appearance
  (they look similar at small size on a dark background — don't trust the screenshot alone if
  extending this). Null-rate path exercised for real via a genuine demo-mode 4th build. Missing-
  view degradation re-verified live (same pattern as Phase 2's height panel).

## Audit findings, this session — see full detail near the top of this file

Summarized again here just so it's not missed in a skim: fixed `npm test` on Node 22 + CI
matrix (`186674e`); fixed fail-open ingest token + ineffective body-size check in
`api/ingest.js` (`cdee2e4`); found but did NOT fix a possible duplicate-row bug on partial
multi-table writes (needs a user decision between an idempotency key or an atomic RPC).

## Test inventory (current, as of `9f03f62`)

```
npm test            # 60 Node tests: scripts/*.test.mjs + lib/*.test.mjs (59 pass, 1 skip without ascent/)
npm run test:godot  # 52 Godot checks: test_logger_queue.gd (38) + test_benchmark_model.gd (14)
npm run benchmark    # runs the actual 3-trial headless benchmark against baseline.json
```

`npm test` was verified working in the cloud session (Node 22.22.2, 59 pass / 1 skip / 0 fail).
`npm run test:godot` and `npm run benchmark` could NOT be run in the cloud session (no Godot) —
**run these yourself first thing**, they haven't been exercised since Phase 4 and the fix to
`npm test`'s invocation could theoretically interact with `check:logger-sync` in ways not yet
observed locally (low risk, but genuinely unverified — the cloud session only ran the plain
`npm test` path, not `npm run check:logger-sync` directly, though that path was covered by the
"1 skip" outcome, i.e. it correctly detected `ascent/`'s absence there).

Both GitHub Actions workflows (`perf-gate.yml`, `benchmark-gate.yml`) should be re-checked once
this branch is pushed/merged — they were last confirmed green on `ce12d26` via GitHub's public
REST API (unauthenticated `curl`, works for a public repo's run/job *status*; job *log*
downloads return 403 unauthenticated — use the browser, or fix `gh auth login` locally now that
you likely have an interactive terminal, which the cloud session didn't).

## Environment / tooling notes for whoever picks this up locally

- **Node and Godot were installed locally** via Homebrew in a previous local session
  (`/opt/homebrew/bin/node`, `/Applications/Godot.app/Contents/MacOS/Godot`, 4.7.stable.official).
  `export PATH="/opt/homebrew/bin:$PATH"` before running `npm`/`node`/`godot` if a fresh shell
  doesn't have it on PATH.
- **`gh` CLI was installed but not authenticated** as of the last local session. `gh auth
  login` needs an interactive flow — should be doable now in a real local terminal. Worth doing
  early; unblocks fetching CI job logs and opening/managing PRs without falling back to
  unauthenticated `curl` against the public API.
- No `package-lock.json` — zero npm dependencies, by design. CI uses `npm install`, not
  `npm ci`, deliberately for this reason.
- `ascent/` (the real game) should exist on this machine and is fully gitignored — confirm it's
  actually there; if a fresh clone, it won't be, which is expected per the "game lives outside
  the repo" design, but worth explicitly noting either way rather than assuming silently.

## Open threads / natural next steps

In rough priority order given everything above:

1. **Merge `claude/optimistic-galileo-uz4e47` to whatever branch Vercel deploys from** so the
   fail-open ingest-token fix is actually live. This should happen before anything else that
   touches production.
2. **Re-verify the migration status** (the standing blocker section above) — genuinely unknown
   right now, first real chance to check it since 2026-09-09.
3. **Confirm/perform the ingest token rotation** — also genuinely unknown, and should happen
   after step 1 so the rotation is protected by the fail-closed fix.
4. **Decide and implement the duplicate-row fix** (idempotency key vs. atomic RPC) — ask the
   user which approach they want; both are real work, not a quick patch.
5. Run `npm run test:godot` and `npm run benchmark` locally — unexercised this session, should
   still be green but hasn't been confirmed since Phase 4.
6. Roadmap items mentioned previously but not started: a session explorer (drill into individual
   sessions), regression alerts (notify on a real gate failure rather than requiring someone to
   check the dashboard), possibly wiring `benchmark-gate.yml`'s result onto a PR comment.

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
  what "should" be true. This whole engagement's credibility rests on that discipline — this
  file itself tries to model it by being explicit about what's verified vs. carried-forward vs.
  genuinely unknown. Don't drop it, and don't let staleness quietly turn into false confidence.
- When a protection (auth check, size limit, validation) is added, don't just add it — confirm
  it actually executes on the deployed code path, not just in the source. Both bugs fixed this
  session were exactly this failure mode: correct-looking code that was a no-op in practice.
- Commit messages in this repo are long and explain *why*, including false starts and what was
  ruled out. Keep doing that; it's clearly load-bearing for a portfolio piece meant to be read.

## Files worth reading first, in order, if picking this up cold

1. This file.
2. `README.md` — user-facing truth, kept current every phase (re-verify it's still accurate).
3. `CLAUDE.md` — short stack summary + tone/audience notes (user is new to CS, wants portfolio-
   grade work, plain-language explanations).
4. `supabase/schema.sql` — the whole data model, heavily commented.
5. `lib/ingest-core.mjs` and `api/ingest.js` — the two most important pieces given this
   session's findings; `api/ingest.js` especially, since it's the file that just got two
   security-relevant fixes.
6. `scripts/benchmark-core.mjs` — the other most important pure-logic contract.
