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

// Replaces global fetch, recording what the handler sends to Supabase.
function stubFetch({ ok = true, status = 201 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    return {
      ok,
      status,
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

  // The session must be upserted before the samples, because system_logs.session_id
  // references it — inserting the children first would violate the foreign key.
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /sessions\?on_conflict=id/);
  assert.match(calls[1].url, /system_logs/);
  assert.equal(calls[0].body[0].id, SESSION_ID);

  // Every row carries the session's build, and the service-role key never leaves the server.
  assert.ok(calls[1].body.every(row => row.build_version === "0.5.0"));
  assert.ok(calls[1].body.every(row => row.session_id === SESSION_ID));
  assert.equal(calls[1].options.headers.apikey, "service-role-test-key");
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
  assert.equal(calls.length, 1, "no sample insert should be attempted for an empty batch");
  assert.ok(calls[0].body[0].ended_at, "ending a session should stamp ended_at");
  assert.equal(calls[0].body[0].ended_cleanly, true);
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
