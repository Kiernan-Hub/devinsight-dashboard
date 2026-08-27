import test from "node:test";
import assert from "node:assert/strict";
import { compareBuilds, detectEvents, logsPath, percentile, summarizeLogs } from "./dashboard-core.mjs";

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

test("events identify build boundaries and material FPS drops", () => {
  const events = detectEvents([
    { created_at: "2026-01-01T00:00:00Z", build_version: "0.2.0", fps_rate: 120, memory_used_mb: 90 },
    { created_at: "2026-01-01T00:00:05Z", build_version: "0.3.0", fps_rate: 60, memory_used_mb: 91 }
  ]);
  assert.deepEqual(events.map(event => event.type), ["drop", "build", "build"]);
});

test("range query includes a safely encoded build filter", () => {
  const path = logsPath(30, "0.3.0 rc1");
  assert.match(path, /created_at=gte\./);
  assert.match(path, /build_version=eq\.0\.3\.0%20rc1/);
});

test("percentile returns null for empty data", () => assert.equal(percentile([], 0.95), null));
