# DevInsight — case study

A performance-telemetry pipeline for **Ascent**, a Godot vertical-climber game: the game reports
frame timings and gameplay context every five seconds; an ingest API validates and stores them in
Postgres; a dashboard shows them live; and two CI gates stop a slower build from merging. This
document is the engineering story — what was built, what broke, how each problem was found, and
what the measurements actually say. The [README](../README.md) is the reference; this is the
narrative.

<img src="../assets/architecture.svg" alt="Architecture diagram — see the README for a full text description.">

## At a glance

| | |
|---|---|
| Stack | Godot 4.7 (GDScript) · Node 24 (zero npm dependencies) · Postgres 17 / Supabase · PostgREST · Vercel · Docker · GitHub Actions |
| Run it | `docker compose up --build --wait && npm run seed` → http://localhost:8080 — no accounts |
| Tests | 122 Node tests · 60 Godot checks · 16-check end-to-end smoke test against real Postgres · SQL security invariants |
| CI | 5 workflows on every pull request: unit tests, real-telemetry FPS gate, headless benchmark, whole-stack Docker smoke test, lint (4 linters), CodeQL |
| Measured | At 400 requests/s (~2,000 concurrent players) on 2 vCPUs: p95 ≤ 7.3 ms, 0 dropped, 0 duplicates — [details](../loadtest/RESULTS.md) |

## The shape of the system

**Client.** `godot/system_logger.gd` measures every frame (not a once-a-second FPS reading —
a percentile is only meaningful over per-frame data), and every five seconds sends one sample:
P95 and worst frame time, memory, and gameplay context (height climbed, live platform count). If
the network is down, samples go to an on-disk queue that survives restarts and drains in batches
on reconnect. Samples are numbered per session and timestamped when taken.

**Write path.** `POST /api/ingest` is the only way data enters the database. It validates each
row independently (a bad row is dropped and reported; the rest of the batch is stored), corrects
for the client's clock, and writes the session, samples and events in **one transaction**. The
key that can write lives only in server environment variables; the key in the game and the
dashboard is read-only in Postgres.

**Read path.** Views roll samples up per build, per 500-unit height band, and per session. The
dashboard charts them, including a session explorer that opens any single run's timeline with
deaths and checkpoints marked where they happened.

**Gates.** The *FPS regression gate* compares the build a commit declares (in
`build-manifest.json`) against its declared baseline using real player telemetry, fails CI past a
10% regression, and turns its verdict on `main` into GitHub issues. The *headless benchmark gate*
runs a deterministic Godot workload on every PR, so there is a performance signal before any
human has played the build.

## What broke, and how it was found

The most useful part of the project is not any feature; it is the list below. Almost none of
these bugs crashed anything — they lost, duplicated or misdated data quietly, or made a check
report success it had not earned. The *method* column is the point: each was found by a specific
habit, not by luck.

| # | Problem | How it was found | Fix |
|---|---|---|---|
| 1 | The CI gate compared whichever telemetry arrived most recently, so replaying an old build inverted the comparison | Audit: reading what the gate actually queried | Anchor the gate to a build declared in the commit |
| 2 | The public anon key could insert rows — anyone who opened the dashboard could fail builds or hide regressions | Audit: listing what the published key could do | All writes through an ingest API; anon read-only |
| 3 | P95 frame time was computed from a once-per-5 s FPS reading, in which a single 200 ms hitch is mathematically invisible | Asking what the metric could and could not see | Measure every frame on the client |
| 4 | The offline queue's flush and live sends raced; `queue.clear()` deleted rows that had never been sent | Tracing ownership of every queued row | Remove only the rows the in-flight request carried |
| 5 | Queued FPS values came back from disk as floats (`60.0`) and Postgres rejected them | Round-tripping real data through the queue | Re-cast on load (the same trap reappeared for `seq` in 0.7.0 and got the same fix) |
| 6 | The ingest token was committed to this public repository | Caught in review, after it had been pushed | Token loaded at runtime from a gitignored file; old one flagged for rotation |
| 7 | Headless Godot paced `_process` at ~145 Hz regardless of workload, so the benchmark measured nothing | An 8× workload change produced 0% change in the reading | Time the workload itself inside the physics step |
| 8 | `schema.sql` ("safe to re-run") failed on every run after the first: one view depended on another | Applying the schema twice in a row to a local Docker Postgres | Drop the dependent view first; CI now applies it three times |
| 9 | The "read-only" anon role still held TRUNCATE, TRIGGER and REFERENCES | Replicating Supabase's permissive default grants locally and listing what anon held | Revoke everything, grant SELECT on a named list; a SQL test asserts it |
| 10 | The dashboard compared the current build *with itself* after anyone replayed an old build ("Healthy, +0.0%") | Seeding three builds of demo data and replaying one old sample | Default the comparison to the manifest's baseline, never the current build |
| 11 | The game never sent sample timestamps, so a backlog flushed after an outage — the case the queue exists for — collapsed onto one instant | Reading what the client actually sends while designing retries | Timestamp at sampling; correct client clock skew with `sent_at` |
| 12 | Three separate database calls per request: a failure on the third left two committed, the client retried, samples were stored twice | Load-test metrics showed the three calls; tracing what a 502 meant to the client | One transactional `ingest_batch()`; per-session `seq` with a unique key, so retries are stored once |
| 13 | A CI step piped through `tee`, and GitHub's default shell has no `pipefail`: a failing smoke test would have shown green | Reading the workflow before it ever ran | `shell: bash` (which is `-eo pipefail`) wherever output is piped |
| 14 | A Godot test that crashed half-way printed "ok"; a test file that failed to *parse* made Godot exit 0 with zero checks run | A new test aborted after 1 of 7 checks and the suite still said PASS; then a missing `return` produced exit 0 | Tests must reach their last line; a runner requires each suite's own PASS line |
| 15 | Grafana's login form was hidden but its built-in `admin/admin` still worked over the API | Trying it | Never create the default admin; API password auth off |
| 16 | The Supabase project was paused for inactivity and the gate failed on every push for weeks without anyone being told | Checking the production dashboard after an unrelated change: its database hostname no longer resolved | A "gate cannot run" alert issue, separate from "regression"; error messages now say `ENOTFOUND <host>` instead of "fetch failed" |
| 17 | The first load-test comparison suggested a 25× speed-up | Re-running the old version straight afterwards (9.6 ms, not 131 ms) | Three alternating runs per version; publish what they support |

## Decisions worth defending

- **The public key is public, so it must not matter.** The anon key ships in the game binary and
  the dashboard's JavaScript; nothing can make it secret. So it can only read. Writing needs the
  service-role key, which exists only server-side. Constraints can bound how *absurd* a forged row
  is; only removing the write grant stops a *plausible* one.
- **Partial acceptance, and status codes as a contract.** The client's offline queue decides from
  the status code alone: 2xx clear, 4xx drop (it will be judged the same way forever), 5xx retry.
  Failing a whole batch over one bad row would make it a poison pill retried forever, so bad rows
  are dropped and reported inside a 200. A database failure is a 502, never a 400 — misreporting
  it would discard good data. The [OpenAPI document](../openapi.json) states this contract, and a
  test checks the document against the code.
- **Crashes are inferred, never reported.** A session is "clean" only if the game said so on the
  way out; a session that just stops reporting is "abandoned". A crashing client cannot lie about
  how it died, because it never gets to say anything.
- **Never trust the client's clock, but keep its intervals.** Timestamps are corrected by
  `(server now) − (sent_at − created_at)`: the client's clock may be hours wrong, but the gap
  between two readings of the same clock is the sample's true age.
- **Pure logic apart from I/O, everywhere.** Validation, gate verdicts, benchmark comparison,
  alert decisions, dashboard maths, demo-data generation and the Godot runner's pass rule are pure
  functions with unit tests; the network and process code around them is thin.
- **Local mirrors production instead of mocking it.** The Docker stack runs the same handler
  file, the unmodified production schema on top of Supabase's real (permissive) default grants,
  and the same URL layout. That faithfulness is what found bugs 8, 9 and 10.
- **Supply chain: pin everything, let a bot do the bumping.** Actions pinned to commit SHAs (a
  tag can be re-pointed, as in the 2025 `tj-actions` compromise), images to digests, Dependabot
  for updates, least-privilege tokens per job, and the one job that runs a pull request's code
  never holds a token that can write.

## Measurements, honestly

- **Load:** at 400 req/s on a 2-vCPU VM, the old three-call write path fell behind in two of three
  runs (p95 131 ms and 508 ms, hundreds of requests dropped); the transactional path held p95
  3.0–7.3 ms with nothing dropped and zero duplicate rows in all three. Below 400 req/s both were
  fine. The first single comparison suggested 25× and was noise — [RESULTS.md](../loadtest/RESULTS.md)
  keeps that on record.
- **Benchmark noise:** a single headless trial's P95 swung ±20%; the gate takes the minimum of
  three trials (scheduling noise only ever adds time) and sets its thresholds (15% warn, 30% fail)
  above the measured noise floor.

## Limits, stated plainly

- **Nothing added on 2026-10-16 has yet run in production or on GitHub's runners.** The production
  Supabase project is paused, and the CI changes were verified by running each workflow step's
  script locally, in order, from an empty database — not by GitHub.
- The headless benchmark measures this repository's own synthetic workload (the real game is kept
  out of the public repo on purpose) and CPU only; it cannot see a GPU regression.
- Load numbers are from one laptop with the load generator sharing the CPUs; in production every
  database round trip crosses a network, which makes the one-call design matter more but means the
  absolute numbers do not transfer.
- Metrics are only scraped in the Docker deployment; a serverless function has no long-lived
  process to scrape.
- No per-client rate limiting: on Vercel it needs shared state (a store such as Redis) that the
  project does not have, and an in-memory limiter per function instance would only look like one.

## Run it

```sh
docker compose up --build --wait          # Postgres, PostgREST, ingest API, dashboard
npm run seed                              # three builds of realistic demo data
open http://localhost:8080                # pick the 24h range; click a session
npm run smoke                             # 16 end-to-end checks against the real database
npm run check:regression:local            # the CI gate, finding the seeded regression
docker compose --profile monitoring up -d # + Prometheus and Grafana on :3001
npm run loadtest                          # k6, 50 → 400 req/s
```
