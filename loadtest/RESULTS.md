# Load test results — POST /api/ingest

Measured 2026-10-16 with [`ingest.js`](ingest.js) (`npm run loadtest`), comparing the ingest path
before and after it was collapsed from three sequential database calls into one transactional
call (`ingest_batch()` in [`supabase/schema.sql`](../supabase/schema.sql)).

## Setup

- Whole local stack in one Colima VM: **2 vCPU, 4 GB**, on an Apple M4. Postgres 17, PostgREST
  16.4, nginx, the ingest image, and k6 itself all share those 2 CPUs.
- Each request is one game client's report: one session, one sample, sometimes one event.
  One player sends 0.2 requests/s, so 400 req/s ≈ 2,000 people playing at once.
- Load steps up 50 → 100 → 200 → 400 req/s, holding each level for 20 s. Figures below are for
  the held periods only.
- **Three runs of each version, alternated** (before, after, before, after...) so neither got a
  systematically warmer or colder machine.

## At 400 req/s — the level that separates them

| Version | Run | p50 | p95 | p99 | Achieved | Dropped |
|---|---|---|---|---|---|---|
| Before: 3 calls | 1 | 4.2 ms | 130.8 ms | 489.4 ms | 394 req/s | 209 |
| Before: 3 calls | 2 | 2.7 ms | 9.6 ms | 24.5 ms | 400 req/s | 0 |
| Before: 3 calls | 3 | 17.0 ms | 508.1 ms | 958.9 ms | 385 req/s | 310 |
| **After: 1 call** | 1 | 1.6 ms | 3.4 ms | 10.3 ms | 400 req/s | 0 |
| **After: 1 call** | 2 | 1.6 ms | 3.0 ms | 7.2 ms | 400 req/s | 0 |
| **After: 1 call** | 3 | 1.8 ms | 7.3 ms | 30.2 ms | 400 req/s | 0 |

"Dropped" is requests k6 could not even start because every simulated player was still waiting on
an earlier response — the service had fallen behind. Failed requests: 0.00% in every run of both.

At 50–200 req/s both versions held p95 under 10 ms in every run; the new one's median was about
1.5× lower (≈1.8–2.8 ms against ≈2.5–3.3 ms).

## What it means

**The old path was sitting on its knee at 400 req/s on this machine.** Each request made three
round trips to the database API, so the database tier handled three times the requests; at that
utilisation, small disturbances (a checkpoint, a GC pause, the scheduler) tipped it into queueing,
and once requests queue, latency grows much faster than load. Two of three runs collapsed; one
did not. The new path does a third of the round trips and never came close.

**The first comparison was wrong, and is kept here because of that.** A single before/after pair
showed a ~25× p95 improvement. Re-running the old version immediately afterwards gave 9.6 ms, not
131 ms — the first baseline had been slowed by something unrelated (most likely the monitoring
containers starting at the same moment). Only the alternated, repeated runs above support a claim,
and the claim they support is reliability under load — not a fixed multiplier.

**The more important change is not speed.** One transaction means a batch is stored entirely or not
at all, and with per-session sequence numbers a retried batch is stored once. Across every
"after" run: 0 duplicate rows (`count(*) - count(distinct (session_id, seq))`).

## Caveats

- One laptop, not production. In production the function runs on Vercel and the database on
  Supabase, where each round trip crosses a network — which makes cutting three round trips to
  one matter *more*, not less, but these absolute numbers do not transfer.
- k6 competes for the same 2 CPUs as the system under test, so the ceiling here is lower than the
  service's own.
- The objective the test enforces (p95 < 250 ms, < 1% failed) passed for both versions overall;
  the per-level table is what shows the difference.
