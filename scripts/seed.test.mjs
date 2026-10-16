// Tests for scripts/seed.mjs, the local demo-data generator.
//
// The first test is the one that matters: every request the seeder will send must pass the real
// ingest validation with zero rejections. If ingest-core's rules ever tighten, this fails here,
// in `npm test`, instead of as a half-seeded demo.

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeIngest, MAX_SAMPLES_PER_REQUEST } from "../lib/ingest-core.mjs";
import { backdateSql, buildSeed, requestsFor, seededRandom, SEED_PLATFORM } from "./seed.mjs";

const manifest = { build_version: "0.6.0", baseline_version: "0.3.0" };
const NOW = Date.parse("2026-10-16T20:00:00Z");
const sessions = buildSeed({ manifest, now: NOW });

const mean = values => values.reduce((sum, v) => sum + v, 0) / values.length;
const samplesOf = build => sessions.filter(s => s.build === build).flatMap(s => s.samples);

test("every seed request passes real ingest validation with nothing rejected", () => {
  for (const session of sessions) {
    for (const body of requestsFor(session)) {
      const result = normalizeIngest(body, { now: NOW });
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.rejected, [], JSON.stringify(result.rejected));
      assert.ok(body.samples.length <= MAX_SAMPLES_PER_REQUEST);
      assert.equal(body.session.platform, SEED_PLATFORM, "the reset and backdate steps find seed rows by this marker");
    }
  }
});

test("the generator is deterministic apart from session ids", () => {
  const strip = list => list.map(({ id, ...rest }) => rest);
  assert.deepEqual(strip(buildSeed({ manifest, now: NOW })), strip(sessions));
  assert.deepEqual([seededRandom(1)(), seededRandom(1)()], [seededRandom(1)(), seededRandom(1)()]);
});

test("the story holds: the current build regresses past the 10% threshold, the baseline does not", () => {
  const current = mean(samplesOf("0.6.0").map(s => s.fps_rate));
  const baseline = mean(samplesOf("0.3.0").map(s => s.fps_rate));
  assert.ok(current < baseline * 0.9, `current ${current.toFixed(1)} vs baseline ${baseline.toFixed(1)}`);
});

test("platform count tracks height in the regressed build, and not in the healthy one", () => {
  const high = build => mean(samplesOf(build).filter(s => s.height > 3000).map(s => s.platform_count));
  const low = build => mean(samplesOf(build).filter(s => s.height < 1000).map(s => s.platform_count));
  assert.ok(high("0.6.0") > low("0.6.0") * 2, "the height panel should show a clear correlation");
  assert.ok(high("0.3.0") < low("0.3.0") * 1.2, "the baseline should stay flat");
});

test("every outcome the stability panel distinguishes is represented", () => {
  assert.deepEqual(new Set(sessions.map(s => s.outcome)), new Set(["clean", "unclean", "abandoned", "active"]));
  // Only sessions that ended send the final "ended" request.
  for (const session of sessions) {
    const ended = requestsFor(session).some(body => body.session.ended);
    assert.equal(ended, session.outcome === "clean" || session.outcome === "unclean", session.outcome);
  }
});

test("sessions are in the past, in order, and do not overlap", () => {
  for (let i = 0; i < sessions.length; i += 1) {
    const s = sessions[i];
    assert.ok(Date.parse(s.startedAt) < Date.parse(s.samples[0].created_at));
    assert.ok(Date.parse(s.samples.at(-1).created_at) <= NOW);
    if (i > 0) assert.ok(Date.parse(sessions[i - 1].lastSeenAt) < Date.parse(s.startedAt));
  }
});

test("the backdate SQL refuses anything that is not a generated UUID or timestamp", () => {
  assert.match(backdateSql(sessions.slice(0, 1)), /platform = 'seed-demo'/);
  const hostile = [{ ...sessions[0], id: "x'); drop table sessions; --" }];
  assert.throws(() => backdateSql(hostile), /unsafe seed row/);
});
