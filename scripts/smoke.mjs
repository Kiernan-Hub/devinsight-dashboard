// End-to-end check of a running stack: sends real telemetry in through the ingest endpoint, then
// reads it back out through the same public REST API the dashboard uses.
//
//   docker compose up --build --wait
//   npm run smoke                          # against http://localhost:8080
//   node scripts/smoke.mjs <base-url>      # against anything else with the same URL layout
//
// Unit tests prove each piece does what it should in isolation, with the database stubbed out.
// This proves the pieces agree with each other: that the rows the handler builds are rows the
// real schema accepts, that the views compute over them, and that the public read path cannot
// write. Each of those has broken before without any unit test noticing (see HANDOFF.md).
//
// Writes one session under build "0.0.0-smoke". Point it only at a disposable database.
//
// Named smoke.mjs, not smoke-test.mjs: Node's test runner treats any *-test.mjs file as a unit
// test, so under the old name `npm test` ran this too — passing whenever a local stack happened
// to be up, and failing in CI where none is.

import { randomUUID } from "node:crypto";

const base = (process.argv[2] || process.env.SMOKE_BASE_URL || "http://localhost:8080").replace(/\/$/, "");
const token = process.env.INGEST_TOKEN || "";
const BUILD = "0.0.0-smoke";
const sessionId = randomUUID();

let failures = 0;
function check(label, condition, detail = "") {
  console.log(`${condition ? "✔" : "✖"} ${label}${!condition && detail ? `\n    ${detail}` : ""}`);
  if (!condition) failures += 1;
}

function ingest(payload) {
  return fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Ingest-Token": token } : {}) },
    body: JSON.stringify(payload)
  });
}

// Reads exactly as the dashboard does in local mode: no key, so PostgREST runs it as anon.
async function read(path) {
  const response = await fetch(`${base}/rest/v1/${path}`);
  return { status: response.status, rows: response.ok ? await response.json() : await response.text() };
}

// `docker compose up --wait` already waits for health checks, but a stack started any other way
// may still be coming up. Retry only the failures that mean "not up yet", for a bounded time.
async function firstContact(payload, deadlineMs = 30_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await ingest(payload);
      if (![502, 503, 504].includes(response.status) || Date.now() > until) return response;
    } catch (error) {
      if (Date.now() > until) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

const now = Date.now();
const sample = (secondsAgo, overrides = {}) => ({
  fps_rate: 60,
  memory_used_mb: 92.5,
  frame_time_p95_ms: 18.2,
  frame_time_max_ms: 41,
  frames_sampled: 300,
  height: 1200,
  platform_count: 44,
  entity_count: 310,
  lava_speed: 1.5,
  created_at: new Date(now - secondsAgo * 1000).toISOString(),
  ...overrides
});

console.log(`Smoke test against ${base} (session ${sessionId})\n`);

// 1. Write through the front door.
const first = await firstContact({
  session: { id: sessionId, build_version: BUILD, platform: "smoke-test" },
  samples: [sample(15), sample(10, { height: 1700 }), sample(5, { fps_rate: -1 })],
  events: [{ event_type: "run_start", height: 0 }, { event_type: "death", height: 1710, detail: { cause: "lava" } }]
});
const firstBody = await first.json().catch(() => ({}));
check("ingest accepts a valid batch", first.status === 200, `HTTP ${first.status} ${JSON.stringify(firstBody)}`);
check("ingest stores the good samples and rejects the bad one, without failing the batch",
  firstBody.accepted === 2 && firstBody.rejected === 1 && firstBody.accepted_events === 2,
  JSON.stringify(firstBody));

const ended = await ingest({ session: { id: sessionId, build_version: BUILD, ended: true, ended_cleanly: true }, samples: [] });
check("ingest records a clean session end", ended.status === 200, `HTTP ${ended.status}`);

// 2. Read it back through the dashboard's path.
const logs = await read(`system_logs?select=build_version,fps_rate,height,frame_time_p95_ms&session_id=eq.${sessionId}`);
check("the samples are readable through the public REST API",
  logs.status === 200 && logs.rows.length === 2 && logs.rows.every(row => row.build_version === BUILD),
  `HTTP ${logs.status} ${JSON.stringify(logs.rows)}`);

const events = await read(`gameplay_events?select=event_type&session_id=eq.${sessionId}&order=created_at.asc`);
check("the gameplay events are stored", events.status === 200 && events.rows.length === 2, JSON.stringify(events.rows));

const summary = await read(`session_summary?select=outcome,sample_count&id=eq.${sessionId}`);
check("session_summary rolls the session up as a clean exit",
  summary.status === 200 && summary.rows[0]?.outcome === "clean" && Number(summary.rows[0]?.sample_count) === 2,
  JSON.stringify(summary.rows));

// Every view the dashboard and the CI gate read must exist and answer. A missing one is how the
// production dashboard ended up silently hiding panels (see HANDOFF.md, "The one blocker").
for (const view of ["build_fps_summary", "build_perf_by_height", "death_distribution", "build_session_health"]) {
  const result = await read(`${view}?select=*&build_version=eq.${BUILD}`);
  check(`${view} answers with this build's row(s)`, result.status === 200 && result.rows.length > 0,
    `HTTP ${result.status} ${typeof result.rows === "string" ? result.rows.slice(0, 200) : JSON.stringify(result.rows)}`);
}

// 3. The public read path must not be a write path. This is the property the whole ingest
// endpoint exists to provide; checking it against the real database is the only way to know the
// grants and policies actually say what the schema's comments claim.
const forged = await fetch(`${base}/rest/v1/system_logs`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app_name: "forged", build_version: BUILD, fps_rate: 1, memory_used_mb: 1 })
});
check("an anonymous direct insert is refused", forged.status === 401 || forged.status === 403, `HTTP ${forged.status}`);

const wiped = await fetch(`${base}/rest/v1/system_logs?session_id=eq.${sessionId}`, { method: "DELETE" });
const survivors = await read(`system_logs?select=id&session_id=eq.${sessionId}`);
check("an anonymous delete is refused and removes nothing",
  (wiped.status === 401 || wiped.status === 403) && survivors.rows.length === 2,
  `HTTP ${wiped.status}, ${survivors.rows.length} rows remain`);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
