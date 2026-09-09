import test from "node:test";
import assert from "node:assert/strict";
import {
  compareBuilds,
  detectEvents,
  logsPath,
  percentile,
  summarizeLogs,
  verdictFor,
  LOG_QUERY_LIMIT
} from "./dashboard-core.mjs";

test("comparison reports a 29 percent regression with the correct sign", () => {
  const result = compareBuilds({ avg_fps: 76.8 }, { avg_fps: 108.1 });
  assert.equal(result.status, "regression");
  assert.equal(result.changePercent.toFixed(1), "-29.0");
});

test("summary calculates engineering-focused percentiles", () => {
  const summary = summarizeLogs([
    { fps_rate: 50, memory_used_mb: 90 },
    { fps_rate: 100, memory_used_mb: 92 },
    { fps_rate: 60, memory_used_mb: 94 }
  ]);
  assert.equal(summary.currentFps, 60);
  assert.equal(summary.onePercentLow.toFixed(1), "50.2");
  assert.ok(summary.p95FrameTime > 19);
});

test("summary prefers real frame timings over ones derived from FPS", () => {
  const derived = summarizeLogs([
    { fps_rate: 60, memory_used_mb: 90 },
    { fps_rate: 60, memory_used_mb: 90 }
  ]);
  assert.equal(derived.frameTimeSource, "derived");
  assert.equal(derived.worstFrameMs, null);

  // Same FPS readings, but the per-frame data shows a stutter the FPS average cannot.
  const measured = summarizeLogs([
    { fps_rate: 60, memory_used_mb: 90, frame_time_p95_ms: 31.5, frame_time_max_ms: 210, frames_sampled: 300 },
    { fps_rate: 60, memory_used_mb: 90, frame_time_p95_ms: 33.0, frame_time_max_ms: 180, frames_sampled: 300 }
  ]);
  assert.equal(measured.frameTimeSource, "measured");
  assert.equal(measured.worstFrameMs, 210);
  assert.equal(measured.framesSampled, 600);
  assert.ok(measured.p95FrameTime > derived.p95FrameTime,
    "a real stutter must not be hidden by an identical FPS average");
});

test("events identify build boundaries and material FPS drops", () => {
  const events = detectEvents([
    { created_at: "2026-01-01T00:00:00Z", build_version: "0.2.0", fps_rate: 120, memory_used_mb: 90 },
    { created_at: "2026-01-01T00:00:05Z", build_version: "0.3.0", fps_rate: 60, memory_used_mb: 91 }
  ]);
  assert.deepEqual(events.map(event => event.type), ["drop", "build"]);
});

test("the first row in a window is not itself an event", () => {
  const events = detectEvents([
    { created_at: "2026-01-01T00:00:00Z", build_version: "0.3.0", fps_rate: 60, memory_used_mb: 90 },
    { created_at: "2026-01-01T00:00:05Z", build_version: "0.3.0", fps_rate: 60, memory_used_mb: 90 }
  ]);
  assert.deepEqual(events, [], "the edge of the query is not something that happened in the game");
});

test("range query asks for the newest rows, safely encoded", () => {
  const path = logsPath(1440, "0.3.0 rc1");
  assert.match(path, /created_at=gte\./);
  assert.match(path, /build_version=eq\.0\.3\.0%20rc1/);
  // Ascending order returned the OLDEST rows of an over-limit window, so a 24h view showed
  // data from ~21 hours ago and labelled it "current".
  assert.match(path, /order=created_at\.desc/);
  assert.match(path, new RegExp(`limit=${LOG_QUERY_LIMIT}`));
});

test("percentile returns null for empty data", () => assert.equal(percentile([], 0.95), null));

// --- CI gate verdicts ------------------------------------------------------

const manifest = { build_version: "0.4.0", baseline_version: "0.3.0", min_samples: 30 };

test("a build with no telemetry is pending, never a pass", () => {
  const verdict = verdictFor({ current: null, baseline: { avg_fps: 100, sample_count: 500 }, manifest });
  assert.equal(verdict.status, "pending");
  assert.match(verdict.message, /no telemetry recorded for build 0\.4\.0/);
});

test("too few samples is pending, never a pass", () => {
  const verdict = verdictFor({
    current: { avg_fps: 60, sample_count: 4 },
    baseline: { avg_fps: 100, sample_count: 500 },
    manifest
  });
  assert.equal(verdict.status, "pending");
  assert.match(verdict.message, /below the 30 required/);
});

test("a thin baseline is not a trustworthy comparison", () => {
  const verdict = verdictFor({
    current: { avg_fps: 60, sample_count: 500 },
    baseline: { avg_fps: 100, sample_count: 2 },
    manifest
  });
  assert.equal(verdict.status, "pending");
  assert.match(verdict.message, /baseline 0\.3\.0 has 2 samples/);
});

test("a real regression fails the gate", () => {
  const verdict = verdictFor({
    current: { avg_fps: 76.8, sample_count: 443 },
    baseline: { avg_fps: 108.1, sample_count: 518 },
    manifest
  });
  assert.equal(verdict.status, "regression");
  assert.match(verdict.message, /REGRESSION/);
});

test("a small dip warns without failing", () => {
  const verdict = verdictFor({
    current: { avg_fps: 93, sample_count: 443 },
    baseline: { avg_fps: 100, sample_count: 518 },
    manifest
  });
  assert.equal(verdict.status, "warning");
});

test("a healthy build passes", () => {
  const verdict = verdictFor({
    current: { avg_fps: 104, sample_count: 443 },
    baseline: { avg_fps: 100, sample_count: 518 },
    manifest
  });
  assert.equal(verdict.status, "healthy");
  assert.match(verdict.message, /PASS/);
});

test("the gate compares the declared builds, not whichever was seen most recently", () => {
  // Replaying an old build must not invert the comparison: the verdict is a pure function of
  // the two builds the manifest names, so ordering by recency cannot enter into it.
  const forwards = verdictFor({
    current: { avg_fps: 76.8, sample_count: 443 },
    baseline: { avg_fps: 108.1, sample_count: 518 },
    manifest
  });
  const backwards = verdictFor({
    current: { avg_fps: 108.1, sample_count: 518 },
    baseline: { avg_fps: 76.8, sample_count: 443 },
    manifest
  });
  assert.equal(forwards.status, "regression");
  assert.equal(backwards.status, "healthy");
});
