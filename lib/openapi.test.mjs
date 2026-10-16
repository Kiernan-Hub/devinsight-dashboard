// Keeps openapi.json honest. A hand-written API description drifts the first time someone changes
// a limit in code and forgets the document, and nothing notices — except a client author, later.
// So instead of trusting the numbers in the spec, these tests probe the real validator and handler
// with them: every documented bound is accepted at the edge and rejected just past it, every
// documented pattern is the validator's own, and the documented status codes are exactly the ones
// the code can send.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  normalizeIngest, APP_NAME_RE, BUILD_VERSION_RE, EVENT_TYPES, MAX_EVENTS_PER_REQUEST,
  MAX_SAMPLES_PER_REQUEST, PLATFORM_RE
} from "./ingest-core.mjs";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
const { schemas } = spec.components;
const operation = spec.paths["/api/ingest"].post;
const NOW = Date.parse("2026-10-16T12:00:05.120Z");
const session = { id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", build_version: "0.7.0" };
const baseSample = { fps_rate: 60, memory_used_mb: 90 };

const sampleOk = overrides => {
  const result = normalizeIngest({ session, samples: [{ ...baseSample, ...overrides }] }, { now: NOW });
  return result.ok && result.rejected.length === 0;
};
const eventOk = overrides => {
  const result = normalizeIngest({ session, samples: [], events: [{ event_type: "death", ...overrides }] }, { now: NOW });
  return result.ok && result.rejected.length === 0;
};

test("every numeric bound documented for a sample is the validator's actual bound", () => {
  let probed = 0;
  for (const [field, rule] of Object.entries(schemas.Sample.properties)) {
    if (rule.minimum === undefined) continue;
    const step = rule.type === "integer" ? 1 : 0.5;
    assert.ok(sampleOk({ [field]: rule.maximum }), `${field} = documented maximum ${rule.maximum} should be accepted`);
    assert.ok(!sampleOk({ [field]: rule.maximum + step }), `${field} just above the documented maximum should be rejected`);
    assert.ok(sampleOk({ [field]: rule.minimum }), `${field} = documented minimum ${rule.minimum} should be accepted`);
    assert.ok(!sampleOk({ [field]: rule.minimum - step }), `${field} just below the documented minimum should be rejected`);
    probed += 1;
  }
  assert.ok(probed >= 10, `expected to probe every numeric sample field, probed ${probed}`);
});

test("event bounds, the event vocabulary and seq match the validator", () => {
  const { height, seq, event_type: type } = schemas.Event.properties;
  assert.ok(eventOk({ height: height.maximum }) && !eventOk({ height: height.maximum + 1 }));
  assert.ok(eventOk({ seq: seq.maximum }) && !eventOk({ seq: seq.maximum + 1 }));
  assert.deepEqual(type.enum, EVENT_TYPES);
  assert.ok(!eventOk({ event_type: "teleport" }), "a type outside the documented enum must be rejected");
});

test("documented patterns and length limits are the validator's own", () => {
  assert.equal(schemas.Session.properties.build_version.pattern, BUILD_VERSION_RE.source);
  assert.equal(schemas.Session.properties.platform.pattern, PLATFORM_RE.source);
  assert.equal(schemas.Sample.properties.app_name.pattern, APP_NAME_RE.source);
  const notes = schemas.Sample.properties.session_notes.maxLength;
  assert.ok(sampleOk({ session_notes: "x".repeat(notes) }) && !sampleOk({ session_notes: "x".repeat(notes + 1) }));
});

test("documented batch limits are the handler's limits", () => {
  assert.equal(schemas.IngestRequest.properties.samples.maxItems, MAX_SAMPLES_PER_REQUEST);
  assert.equal(schemas.IngestRequest.properties.events.maxItems, MAX_EVENTS_PER_REQUEST);
  const tooMany = normalizeIngest({ session, samples: Array(MAX_SAMPLES_PER_REQUEST + 1).fill(baseSample) }, { now: NOW });
  assert.equal(tooMany.status, 413);
  assert.ok("413" in operation.responses);
});

test("the documented example is a request the server accepts in full", () => {
  const example = operation.requestBody.content["application/json"].examples.backlog.value;
  const result = normalizeIngest(example, { now: NOW });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted.length, example.samples.length);
});

test("the documented status codes are exactly the ones the code can send", () => {
  // Read straight from the source, so a new `send(res, 4xx, ...)` without documentation fails here.
  const handler = readFileSync(new URL("../api/ingest.js", import.meta.url), "utf8");
  const core = readFileSync(new URL("./ingest-core.mjs", import.meta.url), "utf8");
  const fromCode = new Set([
    ...[...handler.matchAll(/send\(res, (\d{3})/g)].map(m => m[1]),
    ...[...core.matchAll(/status: (\d{3})/g)].map(m => m[1])
  ]);
  assert.deepEqual([...fromCode].sort(), Object.keys(operation.responses).sort());
});

test("every field the success response documents as required is one the handler sends", () => {
  const handler = readFileSync(new URL("../api/ingest.js", import.meta.url), "utf8");
  const okBlock = handler.slice(handler.lastIndexOf("send(res, 200"));
  for (const field of schemas.IngestResult.required) {
    assert.match(okBlock, new RegExp(`\\b${field}\\b`), `${field} is documented as always present but the 200 response does not set it`);
  }
});
