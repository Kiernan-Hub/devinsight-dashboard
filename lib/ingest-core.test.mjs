import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeIngest,
  sessionRow,
  validateSample,
  validateSession,
  MAX_SAMPLES_PER_REQUEST,
  MAX_SAMPLE_AGE_MS
} from "./ingest-core.mjs";

const SESSION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const NOW = Date.parse("2026-09-09T12:00:00.000Z");

const session = { id: SESSION_ID, build_version: "0.5.0", platform: "macOS" };
const sample = (overrides = {}) => ({
  created_at: "2026-09-09T11:59:55.000Z",
  fps_rate: 60,
  memory_used_mb: 92.4,
  frame_time_p95_ms: 18.2,
  frame_time_max_ms: 51,
  frames_sampled: 300,
  ...overrides
});

// --- sessions --------------------------------------------------------------

test("a session needs a real UUID and a plausible build version", () => {
  assert.equal(validateSession({ ...session, id: "not-a-uuid" }).ok, false);
  assert.equal(validateSession({ ...session, build_version: "" }).ok, false);
  assert.equal(validateSession({ ...session, build_version: '"><script>' }).ok, false);
  assert.equal(validateSession(session).ok, true);
});

test("a session is only ended cleanly when the client says so on the way out", () => {
  // Absence of the flag is itself the signal: a session that just stops reporting crashed,
  // quit, or had its lid closed. Inferring "clean" would erase that distinction.
  assert.equal(validateSession(session).value.ended_cleanly, null);
  assert.equal(validateSession({ ...session, ended: true }).value.ended_cleanly, false);
  assert.equal(validateSession({ ...session, ended: true, ended_cleanly: true }).value.ended_cleanly, true);
});

// --- samples ---------------------------------------------------------------

test("samples outside plausible ranges are rejected", () => {
  const opts = { now: NOW, session: validateSession(session).value };
  assert.equal(validateSample(sample({ fps_rate: -1 }), opts).ok, false);
  assert.equal(validateSample(sample({ fps_rate: 60.5 }), opts).ok, false);
  assert.equal(validateSample(sample({ fps_rate: 99999 }), opts).ok, false);
  assert.equal(validateSample(sample({ memory_used_mb: -3 }), opts).ok, false);
  assert.equal(validateSample(sample({ frame_time_p95_ms: "fast" }), opts).ok, false);
  assert.equal(validateSample(sample(), opts).ok, true);
});

test("frame timing fields are optional, so pre-0.4.0 clients still ingest", () => {
  const opts = { now: NOW, session: validateSession(session).value };
  const result = validateSample(
    { created_at: "2026-09-09T11:59:55.000Z", fps_rate: 60, memory_used_mb: 92.4 },
    opts
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.frame_time_p95_ms, null);
  assert.equal(result.value.frames_sampled, null);
});

test("a sample's build version comes from the session, not the sample", () => {
  const opts = { now: NOW, session: validateSession(session).value };
  const result = validateSample(sample({ build_version: "9.9.9" }), opts);
  assert.equal(result.value.build_version, "0.5.0", "a client must not scatter rows across builds it never ran");
  assert.equal(result.value.session_id, SESSION_ID);
});

test("timestamps in the future or the distant past are rejected", () => {
  const opts = { now: NOW, session: validateSession(session).value };
  assert.equal(validateSample(sample({ created_at: "2027-01-01T00:00:00Z" }), opts).ok, false);
  assert.equal(
    validateSample(sample({ created_at: new Date(NOW - MAX_SAMPLE_AGE_MS - 1000).toISOString() }), opts).ok,
    false
  );
  // Small skew is normal and must be tolerated: the client stamps its own clock.
  assert.equal(validateSample(sample({ created_at: new Date(NOW + 60_000).toISOString() }), opts).ok, true);
});

test("a missing timestamp defaults to arrival time", () => {
  const opts = { now: NOW, session: validateSession(session).value };
  const result = validateSample(sample({ created_at: undefined }), opts);
  assert.equal(result.value.created_at, new Date(NOW).toISOString());
});

// --- whole requests --------------------------------------------------------

test("one malformed sample does not poison the whole batch", () => {
  // The offline queue flushes as a single batch. Rejecting all of it because one row is bad
  // would make that batch a poison pill the client retries forever, losing every good row.
  const result = normalizeIngest({
    session,
    samples: [sample(), sample({ fps_rate: -5 }), sample({ fps_rate: 58 })]
  }, { now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.accepted.length, 2);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].index, 1);
  assert.match(result.rejected[0].reason, /fps_rate/);
});

test("a bad session rejects the request outright", () => {
  const result = normalizeIngest({ session: { id: "nope" }, samples: [] }, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test("oversized batches are refused rather than truncated", () => {
  const result = normalizeIngest(
    { session, samples: Array.from({ length: MAX_SAMPLES_PER_REQUEST + 1 }, () => sample()) },
    { now: NOW }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 413);
});

test("non-object bodies and non-array samples are refused", () => {
  assert.equal(normalizeIngest(null).ok, false);
  assert.equal(normalizeIngest("payload").ok, false);
  assert.equal(normalizeIngest({ session, samples: "many" }).ok, false);
});

test("an empty batch is valid — it is how a session reports it is still alive", () => {
  const result = normalizeIngest({ session, samples: [] }, { now: NOW });
  assert.equal(result.ok, true);
  assert.deepEqual(result.accepted, []);
});

// --- session rows ----------------------------------------------------------

test("session rows carry ended_at only when the session actually ended", () => {
  const open = sessionRow(validateSession(session).value, { now: NOW, sampleCount: 12 });
  assert.equal(open.ended_at, undefined);
  assert.equal(open.last_seen_at, new Date(NOW).toISOString());
  assert.equal(open.sample_count, 12);

  const closed = sessionRow(validateSession({ ...session, ended: true, ended_cleanly: true }).value, { now: NOW });
  assert.equal(closed.ended_at, new Date(NOW).toISOString());
  assert.equal(closed.ended_cleanly, true);
});
