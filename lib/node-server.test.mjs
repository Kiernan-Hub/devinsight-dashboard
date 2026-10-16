// Tests for lib/node-server.mjs: real HTTP requests, over a real socket, into the real
// api/ingest.js handler. Only Supabase itself is stubbed.
//
// The point of the adapter is that the handler cannot tell it is not on Vercel. So rather than
// unit-testing the adapter's helpers in isolation, these tests check the handler's observable
// behaviour through it: every status code ingest-api.test.mjs pins down must come out the same.

import test from "node:test";
import assert from "node:assert/strict";

import { createServer, resolveSecretFiles, MAX_REQUEST_BYTES } from "./node-server.mjs";
import { createRegistry } from "./metrics.mjs";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
process.env.INGEST_TOKEN = "test-token";

const { default: ingest } = await import("../api/ingest.js");

const SESSION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const session = { id: SESSION_ID, build_version: "0.6.0", platform: "Linux" };
const quietLog = { info() {}, error() {} };

// The tests talk to the server with fetch, and the handler talks to Supabase with fetch. Only the
// second is stubbed: anything not addressed to Supabase goes through to the real network stack.
const realFetch = globalThis.fetch;
const supabaseCalls = [];
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith(process.env.SUPABASE_URL)) return realFetch(url, options);
  const body = JSON.parse(options.body);
  supabaseCalls.push({ url, body });
  return { ok: true, status: 200, json: async () => ({ samples: body.p_samples.length, events: body.p_events.length }), text: async () => "" };
};

async function withServer(routes, fn, options = {}) {
  const server = createServer(routes, { log: quietLog, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function post(base, body, { token = "test-token", path = "/api/ingest" } = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Ingest-Token": token } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("a valid batch goes through the adapter into the real handler and out to Supabase", async () => {
  supabaseCalls.length = 0;
  await withServer({ "/api/ingest": ingest }, async base => {
    const res = await post(base, { session, samples: [{ fps_rate: 60, memory_used_mb: 90 }] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    const body = await res.json();
    assert.equal(body.accepted, 1);
    assert.equal(body.session_id, SESSION_ID);
  });
  assert.equal(supabaseCalls.length, 1, "one transactional call: session, samples and events together");
  assert.match(supabaseCalls[0].url, /\/rest\/v1\/rpc\/ingest_batch$/);
});

test("the ingest token header survives Node's header normalisation", async () => {
  // Node lower-cases incoming header names; the handler reads req.headers["x-ingest-token"].
  // A client sending "X-Ingest-Token" must still be recognised, and a wrong one still refused.
  await withServer({ "/api/ingest": ingest }, async base => {
    assert.equal((await post(base, { session, samples: [] })).status, 200);
    assert.equal((await post(base, { session, samples: [] }, { token: "wrong" })).status, 401);
    assert.equal((await post(base, { session, samples: [] }, { token: null })).status, 401);
  });
});

test("the body reaches the handler raw, so its own JSON and size checks still run", async () => {
  await withServer({ "/api/ingest": ingest }, async base => {
    const malformed = await post(base, "{not json");
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /not valid JSON/);

    // Over the handler's 256 KB limit but under the adapter's 1 MB one: the 413 must come from
    // the handler, proving the adapter did not parse the body and skip the handler's check.
    const big = await post(base, JSON.stringify({ session, samples: [], pad: "x".repeat(300 * 1024) }));
    assert.equal(big.status, 413);
  });
});

test("a body over the transport limit is refused without being buffered", async () => {
  let called = false;
  await withServer({ "/api/ingest": () => { called = true; } }, async base => {
    const res = await post(base, "x".repeat(MAX_REQUEST_BYTES + 1));
    assert.equal(res.status, 413);
  });
  assert.equal(called, false, "the handler must never see an over-limit body");
});

test("res.status() chains the way Vercel's does", async () => {
  // The handler writes res.status(405).setHeader(...) — this only works if both return res.
  await withServer({ "/api/ingest": ingest }, async base => {
    const res = await fetch(`${base}/api/ingest`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });
});

test("unknown paths 404 and the health check answers without touching Supabase", async () => {
  supabaseCalls.length = 0;
  await withServer({ "/api/ingest": ingest }, async base => {
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  });
  assert.equal(supabaseCalls.length, 0);
});

test("a handler that throws gets a 500, and the server keeps serving", async () => {
  const routes = { "/boom": () => { throw new Error("kaboom"); }, "/ok": (_req, res) => res.status(204).end() };
  await withServer(routes, async base => {
    assert.equal((await fetch(`${base}/boom`, { method: "POST" })).status, 500);
    assert.equal((await fetch(`${base}/ok`, { method: "POST" })).status, 204);
  });
});

test("a handler that forgets to respond does not leave the client hanging", async () => {
  await withServer({ "/forgetful": async () => {} }, async base => {
    assert.equal((await fetch(`${base}/forgetful`, { method: "POST" })).status, 500);
  });
});

test("resolveSecretFiles reads _FILE secrets and trims the trailing newline", () => {
  const files = { "/keys/service": "secret-value\n" };
  const env = resolveSecretFiles({ KEY_FILE: "/keys/service", OTHER: "kept" }, ["KEY", "OTHER"], path => files[path]);
  assert.equal(env.KEY, "secret-value");
  assert.equal(env.OTHER, "kept", "a plain variable with no _FILE twin is left alone");
});

test("resolveSecretFiles refuses an ambiguous secret", () => {
  assert.throws(
    () => resolveSecretFiles({ KEY: "a", KEY_FILE: "/x" }, ["KEY"], () => "b"),
    /Both KEY and KEY_FILE are set/
  );
});

test("with a registry, requests are counted and timed, and /metrics serves them", async () => {
  const registry = createRegistry();
  await withServer({ "/api/ingest": ingest }, async base => {
    await post(base, { session, samples: [] });
    await post(base, "{not json");
    const scrape = await fetch(`${base}/metrics`);
    assert.equal(scrape.status, 200);
    assert.match(scrape.headers.get("content-type"), /^text\/plain; version=0\.0\.4/);
    const text = await scrape.text();
    assert.match(text, /ingest_http_requests_total\{route="\/api\/ingest",method="POST",status="200"\} 1/);
    assert.match(text, /ingest_http_requests_total\{route="\/api\/ingest",method="POST",status="400"\} 1/);
    assert.match(text, /ingest_http_request_duration_seconds_count\{route="\/api\/ingest"\} 2/);
  }, { metrics: registry });
});

test("arbitrary paths share one route label, so clients cannot mint unlimited time series", async () => {
  const registry = createRegistry();
  await withServer({ "/api/ingest": ingest }, async base => {
    for (let i = 0; i < 5; i += 1) await fetch(`${base}/random-${i}`);
    const text = await (await fetch(`${base}/metrics`)).text();
    assert.match(text, /route="unmatched",method="GET",status="404"\} 5/);
    assert.doesNotMatch(text, /random-/);
  }, { metrics: registry });
});

test("without a registry there is no /metrics endpoint", async () => {
  await withServer({ "/api/ingest": ingest }, async base => {
    assert.equal((await fetch(`${base}/metrics`)).status, 404);
  });
});
