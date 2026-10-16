import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultBaseline,
  formatDuration,
  isSessionId,
  outcomeLabel,
  placeEvents,
  sessionDetailPaths,
  sessionListPath,
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

test("the comparison defaults to the manifest's baseline, the build the CI gate uses", () => {
  // Newest-seen first, the order build_fps_summary is fetched in.
  const versions = ["0.6.0", "0.5.0", "0.3.0"];
  assert.equal(defaultBaseline(versions, { current: "0.6.0", declaredBaseline: "0.3.0" }), "0.3.0");
});

test("replaying an old build never makes the current build its own baseline", () => {
  // Someone played 0.3.0 most recently, so it jumped to the front. The old default — "the
  // second most recent" — picked 0.6.0 here and showed the current build at +0.0% vs itself.
  const versions = ["0.3.0", "0.6.0", "0.5.0"];
  assert.equal(defaultBaseline(versions, { current: "0.6.0", declaredBaseline: "0.3.0" }), "0.3.0");
  assert.equal(defaultBaseline(versions, { current: "0.6.0" }), "0.3.0", "without a manifest: any build but the current one");
});

test("baseline falls back sensibly when the declared one has no data", () => {
  assert.equal(defaultBaseline(["0.6.0", "0.5.0"], { current: "0.6.0", declaredBaseline: "0.3.0" }), "0.5.0");
  assert.equal(defaultBaseline(["0.6.0"], { current: "0.6.0", declaredBaseline: "0.3.0" }), "", "one build: nothing to compare");
  assert.equal(defaultBaseline(["0.6.0", "0.5.0"], { current: "0.6.0", declaredBaseline: "0.6.0" }), "0.5.0", "a manifest naming the current build as its own baseline is ignored");
});

const SESSION = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

test("session ids from the URL are refused unless they are exactly a UUID", () => {
  assert.equal(isSessionId(SESSION), true);
  for (const hostile of ["", "abc", `${SESSION}&select=*`, `${SESSION} `, null, 42]) {
    assert.equal(isSessionId(hostile), false, String(hostile));
  }
  assert.throws(() => sessionDetailPaths("x&select=*"), /not a session id/);
});

test("session queries are scoped to one session and ask for time order", () => {
  const { summary, samples, events } = sessionDetailPaths(SESSION.toUpperCase());
  assert.match(summary, new RegExp(`/session_summary\\?.*&id=eq\\.${SESSION}$`));
  assert.match(samples, new RegExp(`session_id=eq\\.${SESSION}&order=created_at\\.asc`));
  assert.match(events, /^\/rest\/v1\/gameplay_events\?/);
  assert.match(sessionListPath("0.6.0 beta"), /build_version=eq\.0\.6\.0%20beta&order=started_at\.desc&limit=20$/);
  assert.doesNotMatch(sessionListPath(), /build_version=eq\./, "no filter for all builds");
});

test("durations read naturally and absent ones say so", () => {
  assert.equal(formatDuration(42.4), "42s");
  assert.equal(formatDuration(252), "4m 12s");
  assert.equal(formatDuration(3725), "1h 02m");
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration("nope"), "—");
});

test("an unknown outcome is shown as itself, never as a clean exit", () => {
  assert.equal(outcomeLabel("ended_unclean").tone, "bad");
  assert.deepEqual(outcomeLabel("exploded"), { text: "exploded", tone: "" });
});

test("events are pinned to the sample they happened during", () => {
  const samples = ["12:00:05", "12:00:10", "12:00:15"].map(t => ({ created_at: `2026-10-16T${t}Z` }));
  const placed = placeEvents(samples, [
    { created_at: "2026-10-16T12:00:00Z", event_type: "run_start" },
    { created_at: "2026-10-16T12:00:12Z", event_type: "death", height: "1710.5", detail: { cause: "lava" } },
    { created_at: "2026-10-16T12:09:00Z", event_type: "powerup", detail: { kind: "jetpack" } }
  ]);
  assert.deepEqual(placed.map(p => p.index), [0, 1, 2], "before the first sample, during, after the last");
  assert.equal(placed[1].label, "Death (lava)");
  assert.equal(placed[1].height, 1710.5);
  assert.equal(placed[2].label, "Powerup (jetpack)");
  assert.deepEqual(placeEvents([], [{ created_at: "x", event_type: "death" }]), []);
  assert.deepEqual(placeEvents(samples, null), [], "events table missing (pre-migration database)");
});
