// Fills the local Docker stack with realistic demo telemetry, so every dashboard panel has
// something to show the moment the stack is up.
//
//   docker compose up --build --wait
//   npm run seed                         # then open http://localhost:8080 (pick the 24h range)
//
// The data tells one deliberate story, the kind the dashboard exists to catch: the current build
// (from build-manifest.json) has a culling bug, so platforms pile up past height ~1500, frame
// time climbs with them, average FPS drops well past the 10% regression threshold against the
// baseline build, and more sessions end badly. The baseline build is healthy. An in-between
// build sits in the middle. One current-build session is still "running", so its outcome reads
// as active rather than concluded.
//
// Everything goes in through the real /api/ingest endpoint, so the seed is also one more check
// that the ingest path accepts what a real client sends. One thing cannot: the API stamps session
// start/end times with the *server's* clock, on purpose — a client cannot be trusted to say when
// its own session started (see lib/ingest-core.mjs, sessionRow). Replayed history would
// therefore look like dozens of sessions that all started a moment ago and lasted zero seconds.
// So after ingesting, the seeder backdates its own sessions with one SQL statement run directly
// against the local database: an admin-only correction, scoped to rows marked platform
// "seed-demo", and impossible through the public API by design.
//
// Re-running replaces the previous seed (identified by that same platform marker), with times
// relative to now, so the demo is always fresh. It never touches any other row.
//
// The generator is deterministic — a fixed pseudo-random seed — so the demo looks the same
// every time, which matters for screenshots and for scripts/seed.test.mjs.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { MAX_SAMPLES_PER_REQUEST } from "../lib/ingest-core.mjs";

export const SEED_PLATFORM = "seed-demo";
const SAMPLE_INTERVAL_S = 5;

// mulberry32: a tiny, well-known seeded PRNG. Math.random cannot be seeded, and a demo that
// changes shape on every run is useless for comparing screenshots or writing assertions.
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Live platforms at a given height. Healthy builds cull platforms that scroll off-screen, so the
// count hovers around a constant. The regressed build stops culling reliably past 1500, so the
// count grows with height — the correlation build_perf_by_height is built to expose.
function platformsAt(height, culling, rand) {
  const base = 38 + rand() * 6;
  if (culling === "healthy") return base;
  const excess = Math.max(0, height - 1500) / 500;
  return base + Math.pow(excess, culling === "leaky" ? 1.25 : 1.6) * (culling === "leaky" ? 9 : 21);
}

function sampleAt({ seconds, height, culling, rand }) {
  const platforms = platformsAt(height, culling, rand);
  const p95 = 7.4 + platforms * 0.115 + rand() * 1.2;
  // A frame that blows the budget now and then (asset load, GC pause): the reason the logger
  // records the worst frame of each interval and not only a percentile.
  const spike = rand() < 0.04 ? 4 + rand() * 6 : 1;
  const fps = Math.max(20, Math.min(144, Math.round(1000 / (p95 / 1.45))));
  return {
    fps_rate: fps,
    memory_used_mb: Number((88 + seconds * 0.012 + platforms * 0.06 + rand() * 0.8).toFixed(2)),
    frame_time_p95_ms: Number(p95.toFixed(3)),
    frame_time_max_ms: Number((p95 * (1.6 + rand() * 0.9) * spike).toFixed(3)),
    frames_sampled: fps * SAMPLE_INTERVAL_S,
    height: Number(height.toFixed(2)),
    platform_count: Math.round(platforms),
    entity_count: Math.round(platforms * 6.5 + 55 + rand() * 10),
    lava_speed: Number((1 + height / 2200).toFixed(3))
  };
}

// The cast. Outcomes are chosen, not rolled, so the stability panel always shows one red, one
// amber and one green build plus an active session.
function sessionPlan(manifest) {
  const current = manifest.build_version;
  const baseline = manifest.baseline_version;
  const middle = "0.5.0";
  const builds = [
    { build: baseline, culling: "healthy", outcomes: ["clean", "clean", "clean", "clean", "clean", "clean", "clean", "abandoned", "clean", "clean", "clean", "clean", "clean", "clean"] },
    { build: middle, culling: "leaky", outcomes: ["clean", "clean", "clean", "clean", "clean", "clean", "clean", "unclean"] },
    { build: current, culling: "broken", outcomes: ["clean", "unclean", "clean", "abandoned", "clean", "unclean", "clean", "abandoned", "clean", "unclean", "active"] }
  ];
  // Builds are played in release order: the baseline first, the current build most recently.
  return builds.flatMap(({ build, culling, outcomes }) => outcomes.map(outcome => ({ build, culling, outcome })));
}

// Pure: returns everything the seeder will send and the session times it will backdate to,
// without touching the network. `now` is a millisecond timestamp.
export function buildSeed({ manifest, now, seed = 20261016 }) {
  const rand = seededRandom(seed);
  const plan = sessionPlan(manifest);
  const sessions = [];

  // Sessions run back to back, ending just before `now`; walk backwards so the last one (the
  // active session) ends at the present.
  let cursor = now - 30_000;
  for (let index = plan.length - 1; index >= 0; index -= 1) {
    const { build, culling, outcome } = plan[index];
    const durationS = Math.round(150 + rand() * 210);
    const sampleCount = Math.floor(durationS / SAMPLE_INTERVAL_S);
    const endMs = cursor;
    const startMs = endMs - sampleCount * SAMPLE_INTERVAL_S * 1000;
    const climbRate = 11 + rand() * 7; // height units per second
    cursor = startMs - Math.round(20_000 + rand() * 90_000); // a break between sessions

    // Numbered like a 0.7 client numbers them. A session that ended badly loses a few samples
    // on the way — requests that died with the stutter that preceded the crash — which the
    // session explorer reports as lost in transit (session_summary.samples_lost).
    const lossy = outcome === "unclean";
    const samples = [];
    for (let i = 1; i <= sampleCount; i += 1) {
      const seconds = i * SAMPLE_INTERVAL_S;
      const height = seconds * climbRate * (0.92 + rand() * 0.16);
      const sample = {
        ...sampleAt({ seconds, height, culling, rand }),
        created_at: new Date(startMs + seconds * 1000).toISOString(),
        seq: i - 1
      };
      if (lossy && i > 3 && i < sampleCount && rand() < 0.06) continue;
      samples.push(sample);
    }

    const at = seconds => new Date(startMs + seconds * 1000).toISOString();
    const finalHeight = samples.at(-1).height;
    const events = [{ event_type: "run_start", height: 0, created_at: at(0) }];
    for (let mark = 1000; mark < finalHeight; mark += 1000) {
      events.push({ event_type: "checkpoint", height: mark, created_at: at(Math.round(mark / climbRate)) });
    }
    if (rand() < 0.6) {
      const powerupAt = Math.round(rand() * sampleCount * SAMPLE_INTERVAL_S);
      events.push({ event_type: "powerup", height: Number((powerupAt * climbRate).toFixed(2)), created_at: at(powerupAt), detail: { kind: rand() < 0.5 ? "jetpack" : "shield" } });
    }
    // A session that crashed or is still running never reached a death screen.
    if (outcome === "clean" || outcome === "unclean") {
      events.push({ event_type: "death", height: finalHeight, created_at: at(sampleCount * SAMPLE_INTERVAL_S), detail: { cause: rand() < 0.7 ? "lava" : "fall" } });
      events.push({ event_type: "run_end", height: finalHeight, created_at: at(sampleCount * SAMPLE_INTERVAL_S) });
    }

    // Numbered in the order they happened, as the client numbers them when it records them.
    events.sort((a, b) => a.created_at.localeCompare(b.created_at));
    events.forEach((event, seq) => { event.seq = seq; });

    sessions.unshift({
      id: randomUUID(),
      build,
      outcome,
      startedAt: new Date(startMs).toISOString(),
      // An active session was "last seen" just now; everything else when its last sample landed.
      lastSeenAt: new Date(outcome === "active" ? now : endMs).toISOString(),
      samples,
      events
    });
  }
  return sessions;
}

// The request bodies for one session, in the order a real client would send them: samples in
// batches no larger than the API accepts, events riding along with the first batch, and — only
// for sessions that ended at all — a final empty batch announcing the end.
export function requestsFor(session) {
  const meta = { id: session.id, build_version: session.build, platform: SEED_PLATFORM };
  const bodies = [];
  for (let i = 0; i < session.samples.length; i += MAX_SAMPLES_PER_REQUEST) {
    bodies.push({
      session: meta,
      samples: session.samples.slice(i, i + MAX_SAMPLES_PER_REQUEST),
      ...(i === 0 ? { events: session.events } : {})
    });
  }
  if (session.outcome === "clean" || session.outcome === "unclean") {
    bodies.push({ session: { ...meta, ended: true, ended_cleanly: session.outcome === "clean" }, samples: [] });
  }
  return bodies;
}

const isUuid = value => /^[0-9a-f-]{36}$/.test(value);
const isIso = value => !Number.isNaN(Date.parse(value)) && /^[0-9TZ:.-]+$/.test(value);

export function backdateSql(sessions) {
  // Every interpolated value is a UUID or an ISO timestamp this script generated itself; both are
  // re-checked against a strict character set anyway, so nothing else can reach the SQL.
  const rows = sessions.map(s => {
    if (!isUuid(s.id) || !isIso(s.startedAt) || !isIso(s.lastSeenAt)) throw new Error(`unsafe seed row ${s.id}`);
    return `('${s.id}'::uuid, '${s.startedAt}'::timestamptz, '${s.lastSeenAt}'::timestamptz)`;
  });
  return `update public.sessions s
   set started_at   = v.started_at,
       last_seen_at = v.last_seen_at,
       ended_at     = case when s.ended_at is not null then v.last_seen_at end
  from (values ${rows.join(",\n               ")}) as v(id, started_at, last_seen_at)
 where s.id = v.id and s.platform = '${SEED_PLATFORM}';
`;
}

// system_logs.session_id is `on delete set null`, so samples must go before their sessions or
// they would survive as orphans; gameplay_events cascade on their own.
export const RESET_SQL = `delete from public.system_logs where session_id in (select id from public.sessions where platform = '${SEED_PLATFORM}');
delete from public.sessions where platform = '${SEED_PLATFORM}';
`;

function psql(sql) {
  const result = spawnSync("docker", ["compose", "exec", "-T", "db", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], {
    input: sql,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`psql via docker compose failed (is the stack up?): ${result.stderr || result.error?.message}`);
  }
}

async function main() {
  const base = (process.argv[2] || process.env.SEED_BASE_URL || "http://localhost:8080").replace(/\/$/, "");
  const token = process.env.INGEST_TOKEN || "";
  const manifest = JSON.parse(readFileSync(new URL("../build-manifest.json", import.meta.url), "utf8"));
  const sessions = buildSeed({ manifest, now: Date.now() });

  psql(RESET_SQL);

  let samples = 0;
  let events = 0;
  for (const session of sessions) {
    for (const body of requestsFor(session)) {
      const response = await fetch(`${base}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "X-Ingest-Token": token } : {}) },
        body: JSON.stringify(body)
      });
      const result = await response.json().catch(() => ({}));
      if (response.status !== 200 || result.rejected) {
        throw new Error(`ingest refused seed data: HTTP ${response.status} ${JSON.stringify(result)}`);
      }
      samples += result.accepted;
      events += result.accepted_events;
    }
  }

  psql(backdateSql(sessions));

  const builds = [...new Set(sessions.map(s => s.build))].join(", ");
  console.log(`Seeded ${sessions.length} sessions (${samples} samples, ${events} events) across builds ${builds}.`);
  console.log(`Open ${base} and pick the 24h range to see every build (the seed spans about three hours).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`seed: ${error.message}`);
    process.exit(1);
  }
}
