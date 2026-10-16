// Tests for the HTTP behaviour of api/ingest.js: status codes, auth, and what it sends to
// Supabase. The validation rules themselves are covered in ingest-core.test.mjs.
//
// The status codes matter more than they look. The Godot client decides whether to retry from
// them: it re-queues a 5xx and drops a 4xx. Getting that mapping wrong either loses data or
// creates a poison pill the client retries forever.

import test from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
process.env.INGEST_TOKEN = "test-token";

const { default: handler } = await import("../api/ingest.js");

const SESSION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const session = { id: SESSION_ID, build_version: "0.5.0", platform: "macOS" };
const sample = (overrides = {}) => ({ fps_rate: 60, memory_used_mb: 92.4, ...overrides });

function mockRes() {
  const res = { statusCode: 0, headers: {}, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.setHeader = (key, value) => { res.headers[key] = value; return res; };
  res.end = body => { res.body = body ? JSON.parse(body) : null; return res; };
  return res;
}

function mockReq(body, { method = "POST", token = "test-token" } = {}) {
  return { method, headers: token === null ? {} : { "x-ingest-token": token }, body };
}

// Replaces global fetch, recording what the handler sends to Supabase. By default the stand-in
// for ingest_batch() reports every row as newly stored; `stored` overrides that, to play a
// retry of rows the database already has.
function stubFetch({ ok = true, status = 200, stored = null } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    return {
      ok,
      status,
      json: async () => stored ?? { samples: body?.p_samples?.length ?? 0, events: body?.p_events?.length ?? 0 },
      text: async () => (ok ? "" : "insert failed")
    };
  };
  return calls;
}

test("a valid batch is written and acknowledged", async () => {
  const calls = stubFetch();
  const res = mockRes();
  await handler(mockReq({ session, samples: [sample(), sample({ fps_rate: 58 })] }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.accepted, 2);
  assert.equal(res.body.rejected, 0);
  assert.equal(res.body.session_id, SESSION_ID);

  // One call, so the session, samples and events commit in one transaction (ingest_batch in
  // supabase/schema.sql). As separate calls, a failure part-way left half a batch stored and the
  // client's retry wrote the other half twice.
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/ingest_batch$/);
  const { p_session, p_samples } = calls[0].body;
  assert.equal(p_session.id, SESSION_ID);

  // Every row carries the session's build, and the service-role key never leaves the server.
  assert.ok(p_samples.every(row => row.build_version === "0.5.0"));
  assert.ok(p_samples.every(row => row.session_id === SESSION_ID));
  assert.equal(calls[0].options.headers.apikey, "service-role-test-key");
  assert.equal(res.body.duplicates, 0);
});

test("partial batches are accepted with the rejections reported", async () => {
  stubFetch();
  const res = mockRes();
  await handler(mockReq({ session, samples: [sample(), sample({ fps_rate: -1 })] }), res);

  assert.equal(res.statusCode, 200, "a 4xx here would make the batch a poison pill the client retries forever");
  assert.equal(res.body.accepted, 1);
  assert.equal(res.body.rejected, 1);
  assert.equal(res.body.rejections[0].index, 1);
});

test("an empty batch still refreshes the session without writing samples", async () => {
  const calls = stubFetch();
  const res = mockRes();
  await handler(mockReq({ session: { ...session, ended: true, ended_cleanly: true }, samples: [] }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0].body.p_samples, [], "an empty batch carries no samples");
  assert.ok(calls[0].body.p_session.ended_at, "ending a session should stamp ended_at");
  assert.equal(calls[0].body.p_session.ended_cleanly, true);
});

test("a bad token is rejected", async () => {
  stubFetch();
  const res = mockRes();
  await handler(mockReq({ session, samples: [] }, { token: "wrong" }), res);
  assert.equal(res.statusCode, 401);

  const missing = mockRes();
  await handler(mockReq({ session, samples: [] }, { token: null }), missing);
  assert.equal(missing.statusCode, 401);
});

test("non-POST methods are refused", async () => {
  stubFetch();
  const res = mockRes();
  await handler(mockReq({ session, samples: [] }, { method: "GET" }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "POST");
});

test("a malformed body is a 400, not a crash", async () => {
  stubFetch();
  const res = mockRes();
  await handler(mockReq("{not json", {}), res);
  assert.equal(res.statusCode, 400);

  const noSession = mockRes();
  await handler(mockReq({ samples: [] }), noSession);
  assert.equal(noSession.statusCode, 400);
});

test("a raw JSON string body is parsed", async () => {
  stubFetch();
  const res = mockRes();
  await handler(mockReq(JSON.stringify({ session, samples: [sample()] })), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.accepted, 1);
});

test("a database failure is a 502 so the client retries instead of dropping data", async () => {
  stubFetch({ ok: false, status: 500 });
  const res = mockRes();
  await handler(mockReq({ session, samples: [sample()] }), res);

  // 502, not 400: the payload was fine, our downstream was not. The client re-queues 5xx and
  // drops 4xx, so misreporting this as a 400 would silently discard good telemetry.
  assert.equal(res.statusCode, 502);
});


test("events travel in the same transaction as the samples and the session", async () => {
  const calls = stubFetch();
  const res = mockRes();
  await handler(mockReq({
    session,
    samples: [sample({ height: 4210, platform_count: 182 })],
    events: [{ event_type: "death", height: 4210, detail: { cause: "lava" } }]
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.accepted, 1);
  assert.equal(res.body.accepted_events, 1);

  assert.equal(calls.length, 1);
  const { p_samples, p_events } = calls[0].body;

  // Gameplay context rides on the sample row itself, so a correlation query is a plain
  // column comparison rather than a join against a separate timeline.
  assert.equal(p_samples[0].height, 4210);
  assert.equal(p_samples[0].platform_count, 182);
  assert.deepEqual(p_events[0].detail, { cause: "lava" });
  assert.equal(p_events[0].session_id, SESSION_ID);
});

test("a retry of rows already stored is reported as duplicates, not as an error", async () => {
  // The database skipped all three samples and the event: an earlier attempt had committed them
  // and only the response was lost. Still a 200, so the client clears them from its queue.
  stubFetch({ stored: { samples: 0, events: 0 } });
  const res = mockRes();
  await handler(mockReq({
    session,
    samples: [sample({ seq: 0 }), sample({ seq: 1 }), sample({ seq: 2 })],
    events: [{ event_type: "death", seq: 0 }]
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.accepted, 3);
  assert.equal(res.body.duplicates, 3);
  assert.equal(res.body.duplicate_events, 1);
});

test("the client's clock error is reported back", async () => {
  stubFetch();
  const res = mockRes();
  const sentAt = new Date(Date.now() + 90_000).toISOString(); // a clock 90 s fast
  await handler(mockReq({ session, sent_at: sentAt, samples: [] }), res);
  assert.ok(Math.abs(res.body.clock_offset_ms + 90_000) < 2_000, String(res.body.clock_offset_ms));
});
