// Load test for POST /api/ingest, run by k6 inside the Compose network:
//
//   npm run loadtest            # needs the stack up: docker compose up --build --wait
//
// Each request is shaped like a real game client's: one session, one sample (the game reports
// every 5 seconds), now and then a gameplay event. So a request rate converts directly into
// players: one player is 0.2 requests per second, and 100 requests per second is ~500 people
// playing at once.
//
// The arrival rate climbs in steps rather than holding one fixed load, so a single run shows
// where latency starts to bend, not just whether one number passed. Rows are written under
// platform "load-test" and deleted afterwards by the npm script.

import http from "k6/http";
import exec from "k6/execution";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://gateway";
const PEAK = Number(__ENV.PEAK_RPS || 400);

// Four held load levels with short ramps between them. Requests made while a level is held are
// tagged with it, so the summary reports each level separately: an average over the whole run
// would hide exactly the point where latency starts to bend.
const LEVELS = [0.125, 0.25, 0.5, 1].map(f => Math.round(PEAK * f));
const HOLDS = [[20, 40], [50, 70], [80, 100], [110, 130]]; // seconds into the run
const levelAt = seconds => {
  const i = HOLDS.findIndex(([from, to]) => seconds >= from && seconds < to);
  return i === -1 ? "ramp" : String(LEVELS[i]);
};

const perLevel = {};
for (const level of LEVELS) {
  perLevel[`http_req_duration{level:${level}}`] = ["p(95)>=0"];
  perLevel[`http_req_failed{level:${level}}`] = ["rate>=0"];
  perLevel[`http_reqs{level:${level}}`] = ["count>=0"];
}

export const options = {
  scenarios: {
    players: {
      executor: "ramping-arrival-rate",
      startRate: 10,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 400,
      stages: [
        { target: PEAK * 0.125, duration: "20s" },
        { target: PEAK * 0.125, duration: "20s" },
        { target: PEAK * 0.25, duration: "10s" },
        { target: PEAK * 0.25, duration: "20s" },
        { target: PEAK * 0.5, duration: "10s" },
        { target: PEAK * 0.5, duration: "20s" },
        { target: PEAK, duration: "10s" },
        { target: PEAK, duration: "20s" }
      ]
    }
  },
  // The service-level objective this test enforces: almost nothing fails, and the slowest 5% of
  // requests still answer within a quarter of a second. Exceeding either fails the run.
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<250"],
    // Always-true thresholds whose only job is to make k6 report each level as its own metric.
    ...perLevel
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"]
};

// Each virtual player is one session reporting numbered samples, exactly like a 0.7 game client:
// module-level state in k6 is per virtual user, so every VU keeps its own id and counter. The
// database therefore does the same uniqueness check on (session, seq) it does in production.
const sessionId = crypto.randomUUID();
let seq = 0;

export default function () {
  const now = new Date().toISOString();
  const body = {
    session: { id: sessionId, build_version: "0.0.0-load", platform: "load-test" },
    sent_at: now,
    samples: [{
      seq: seq++,
      fps_rate: 55 + Math.floor(Math.random() * 30),
      memory_used_mb: 90 + Math.random() * 10,
      frame_time_p95_ms: 12 + Math.random() * 6,
      frame_time_max_ms: 20 + Math.random() * 30,
      frames_sampled: 300,
      height: Math.random() * 5000,
      platform_count: 40 + Math.floor(Math.random() * 40),
      created_at: now
    }],
    ...(Math.random() < 0.1 ? { events: [{ event_type: "checkpoint", height: 1000, created_at: now, seq: seq }] } : {})
  };
  const level = levelAt(exec.instance.currentTestRunDuration / 1000);
  const response = http.post(`${BASE_URL}/api/ingest`, JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...(__ENV.INGEST_TOKEN ? { "X-Ingest-Token": __ENV.INGEST_TOKEN } : {}) },
    tags: { level }
  });
  check(response, { "stored (HTTP 200)": r => r.status === 200 });
}

// One row per held level: what was asked for, what was achieved, and how latency held up.
// "Dropped" counts requests k6 could not even start because every virtual player was still
// waiting on a previous response — the clearest sign the service has fallen behind.
export function handleSummary(data) {
  const m = name => data.metrics[name]?.values ?? {};
  const ms = v => (v == null ? "—" : `${v.toFixed(1)} ms`);
  const rows = LEVELS.map(level => {
    const duration = m(`http_req_duration{level:${level}}`);
    const count = m(`http_reqs{level:${level}}`).count ?? 0;
    return `| ${String(level).padStart(5)} req/s (~${level * 5} players) | ${(count / 20).toFixed(0).padStart(5)} req/s | ${ms(duration.med).padStart(9)} | ${ms(duration["p(95)"]).padStart(9)} | ${ms(duration["p(99)"]).padStart(9)} | ${((m(`http_req_failed{level:${level}}`).rate ?? 0) * 100).toFixed(2)}% |`;
  });
  const overall = m("http_req_duration");
  const failed = (m("http_req_failed").rate ?? 0) * 100;
  const dropped = m("dropped_iterations").count ?? 0;
  const passed = overall["p(95)"] < 250 && failed < 1;
  const text = [
    "",
    "| Held load | Achieved | p50 | p95 | p99 | Failed |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    `Whole run: ${m("http_reqs").count} requests, p95 ${ms(overall["p(95)"])}, ${failed.toFixed(2)}% failed, ${dropped} dropped.`,
    `Objective (p95 < 250 ms, < 1% failed): ${passed ? "MET" : "NOT MET"}`,
    ""
  ].join("\n");
  return { stdout: text };
}
