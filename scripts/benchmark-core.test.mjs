import test from "node:test";
import assert from "node:assert/strict";
import { compareBenchmarkRun, extractResult, REGRESSION_THRESHOLD, WARNING_THRESHOLD } from "./benchmark-core.mjs";

const baseline = { expected_ticks: 1800, p95_frame_time_ms: 1.2 };
const run = (overrides = {}) => ({
  ticks: 1800, expected_ticks: 1800, timed_out: false, p95_frame_time_ms: 1.2, ...overrides
});

test("a run matching the baseline is healthy", () => {
  const verdict = compareBenchmarkRun(run(), baseline);
  assert.equal(verdict.status, "healthy");
  assert.match(verdict.message, /PASS/);
});

test("a run well past the regression threshold fails", () => {
  const verdict = compareBenchmarkRun(run({ p95_frame_time_ms: baseline.p95_frame_time_ms * (1 + REGRESSION_THRESHOLD + 0.05) }), baseline);
  assert.equal(verdict.status, "regression");
  assert.match(verdict.message, /REGRESSION/);
});

test("a run between the warning and regression thresholds warns without failing", () => {
  const midpoint = (WARNING_THRESHOLD + REGRESSION_THRESHOLD) / 2;
  const verdict = compareBenchmarkRun(run({ p95_frame_time_ms: baseline.p95_frame_time_ms * (1 + midpoint) }), baseline);
  assert.equal(verdict.status, "warning");
});

test("a run that got FASTER is healthy, not flagged", () => {
  const verdict = compareBenchmarkRun(run({ p95_frame_time_ms: baseline.p95_frame_time_ms * 0.7 }), baseline);
  assert.equal(verdict.status, "healthy");
});

test("no baseline is reported distinctly and does not fail", () => {
  const verdict = compareBenchmarkRun(run(), null);
  assert.equal(verdict.status, "no_baseline");
  assert.match(verdict.message, /update-baseline/);
});

test("a baseline for a different workload is rejected as stale, not silently compared", () => {
  // If the benchmark's own constants changed, an old baseline describes a different amount of
  // work. Comparing anyway would attribute a workload change to a performance regression (or
  // hide a real one) — this must be loud, the same way an ungated "pending" must never pass.
  const verdict = compareBenchmarkRun(run(), { ...baseline, expected_ticks: 900 });
  assert.equal(verdict.status, "stale_baseline");
});

test("a timed-out run is never treated as a valid measurement", () => {
  const verdict = compareBenchmarkRun(run({ timed_out: true }), baseline);
  assert.equal(verdict.status, "timed_out");
});

test("an incomplete run is never compared", () => {
  const verdict = compareBenchmarkRun(run({ ticks: 1200 }), baseline);
  assert.equal(verdict.status, "invalid");
});

test("a missing or unparsable result is invalid, not a crash", () => {
  assert.equal(compareBenchmarkRun(null, baseline).status, "invalid");
  assert.equal(compareBenchmarkRun(undefined, baseline).status, "invalid");
});

// --- stdout parsing ---------------------------------------------------------

test("the result line is found among Godot's own startup noise", () => {
  const stdout = [
    "Godot Engine v4.7.stable.official.5b4e0cb0f - https://godotengine.org",
    "",
    'BENCHMARK_RESULT:{"ticks":1800,"expected_ticks":1800,"p95_frame_time_ms":1.2}',
    ""
  ].join("\n");
  const result = extractResult(stdout);
  assert.equal(result.ticks, 1800);
  assert.equal(result.p95_frame_time_ms, 1.2);
});

test("a missing result line yields null, not a throw", () => {
  assert.equal(extractResult("Godot Engine v4.7.stable\nSCRIPT ERROR: something broke"), null);
});

test("a corrupted result line yields null, not a throw", () => {
  assert.equal(extractResult("BENCHMARK_RESULT:{not valid json"), null);
});
