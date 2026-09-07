import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRegression, exitCodeFor, formatReport, selectBuilds } from "./regression-core.mjs";

const build = (version, avgFps, sampleCount, lastSeen) => ({
  build_version: version,
  avg_fps: avgFps,
  sample_count: sampleCount,
  last_seen: lastSeen
});

test("a drop past the threshold fails the build", () => {
  const result = evaluateRegression([
    build("0.3.0", 76.8, 443, "2026-01-02T00:00:00Z"),
    build("0.2.0", 108.1, 518, "2026-01-01T00:00:00Z")
  ]);
  assert.equal(result.verdict, "regression");
  assert.equal(result.changePercent.toFixed(1), "-29.0");
  assert.equal(exitCodeFor(result), 1);
});

test("a drop inside the threshold passes", () => {
  const result = evaluateRegression([
    build("0.3.0", 102.0, 443, "2026-01-02T00:00:00Z"),
    build("0.2.0", 108.1, 518, "2026-01-01T00:00:00Z")
  ]);
  assert.equal(result.verdict, "pass");
  assert.equal(exitCodeFor(result), 0);
});

test("an improvement is never a regression", () => {
  const result = evaluateRegression([
    build("0.3.0", 140.0, 443, "2026-01-02T00:00:00Z"),
    build("0.2.0", 108.1, 518, "2026-01-01T00:00:00Z")
  ]);
  assert.equal(result.verdict, "pass");
  assert.ok(result.changePercent > 0);
});

test("a thin sample set is skipped instead of gated on", () => {
  // 4 samples is ~20 seconds of play; the average is noise, and failing CI on
  // it would make the gate flaky rather than strict.
  const result = evaluateRegression([
    build("0.3.0", 40.0, 4, "2026-01-02T00:00:00Z"),
    build("0.2.0", 108.1, 518, "2026-01-01T00:00:00Z")
  ]);
  assert.equal(result.verdict, "insufficient-samples");
  assert.equal(exitCodeFor(result), 0);
  assert.match(result.reason, /only 4 samples/);
});

test("a thin baseline is skipped rather than used as a noisy reference", () => {
  const result = evaluateRegression([
    build("0.3.0", 60.0, 443, "2026-01-02T00:00:00Z"),
    build("0.2.0", 108.1, 3, "2026-01-01T00:00:00Z")
  ]);
  assert.equal(result.verdict, "no-baseline");
  assert.equal(exitCodeFor(result), 0);
});

test("replayed telemetry for an old build cannot masquerade as the baseline", () => {
  // Two rows for the same build must not compare against each other.
  const result = evaluateRegression([
    build("0.3.0", 76.8, 443, "2026-01-02T00:00:00Z"),
    build("0.3.0", 110.0, 400, "2026-01-01T12:00:00Z"),
    build("0.2.0", 80.0, 518, "2026-01-01T00:00:00Z")
  ]);
  assert.equal(result.baseline.version, "0.2.0");
  assert.equal(result.verdict, "pass");
});

test("selection sorts on last_seen rather than trusting query order", () => {
  const { latest, baseline } = selectBuilds([
    build("0.1.0", 90.0, 100, "2026-01-01T00:00:00Z"),
    build("0.3.0", 95.0, 100, "2026-01-03T00:00:00Z"),
    build("0.2.0", 92.0, 100, "2026-01-02T00:00:00Z")
  ]);
  assert.equal(latest.version, "0.3.0");
  assert.equal(baseline.version, "0.2.0");
});

test("a single build is reported as having no baseline, not as a pass", () => {
  const result = evaluateRegression([build("0.1.0", 90.0, 100, "2026-01-01T00:00:00Z")]);
  assert.equal(result.verdict, "no-baseline");
  assert.equal(exitCodeFor(result), 0);
});

test("empty and malformed responses do not throw", () => {
  assert.equal(evaluateRegression([]).verdict, "no-baseline");
  assert.equal(evaluateRegression(null).verdict, "no-baseline");
  assert.equal(evaluateRegression([{ build_version: "0.1.0", avg_fps: "nope" }]).verdict, "no-baseline");
});

test("a view without sample_count still gates instead of silently disabling itself", () => {
  const result = evaluateRegression([
    { build_version: "0.3.0", avg_fps: 76.8, last_seen: "2026-01-02T00:00:00Z" },
    { build_version: "0.2.0", avg_fps: 108.1, last_seen: "2026-01-01T00:00:00Z" }
  ]);
  assert.equal(result.verdict, "regression");
  assert.match(formatReport(result), /sample count unknown/);
});

test("the report names the failing build and the threshold", () => {
  const report = formatReport(evaluateRegression([
    build("0.3.0", 76.8, 443, "2026-01-02T00:00:00Z"),
    build("0.2.0", 108.1, 518, "2026-01-01T00:00:00Z")
  ]));
  assert.match(report, /FAIL/);
  assert.match(report, /0\.3\.0 is down 29\.0% from 0\.2\.0/);
  assert.match(report, /threshold 10%/);
});
