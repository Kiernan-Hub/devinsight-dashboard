// Tests for lib/metrics.mjs. The exact text matters: Prometheus rejects a malformed scrape
// entirely, so one bad line would lose every metric, not just that one. (CI additionally runs
// Prometheus's own `promtool check metrics` against the live endpoint.)

import test from "node:test";
import assert from "node:assert/strict";

import { createRegistry } from "./metrics.mjs";

test("counters render with HELP, TYPE and one line per label set", () => {
  const registry = createRegistry();
  const requests = registry.counter("http_requests_total", "Requests.", ["route", "status"]);
  requests.inc(["/api/ingest", "200"]);
  requests.inc(["/api/ingest", "200"], 2);
  requests.inc(["/api/ingest", "502"]);
  assert.equal(registry.render(), [
    "# HELP http_requests_total Requests.",
    "# TYPE http_requests_total counter",
    'http_requests_total{route="/api/ingest",status="200"} 3',
    'http_requests_total{route="/api/ingest",status="502"} 1',
    ""
  ].join("\n"));
});

test("histogram buckets are cumulative and end in +Inf", () => {
  const registry = createRegistry();
  const latency = registry.histogram("latency_seconds", "Latency.", [], [0.1, 0.5]);
  for (const value of [0.05, 0.2, 0.3, 2]) latency.observe([], value);
  const lines = registry.render().split("\n");
  assert.deepEqual(lines.slice(2, 7), [
    'latency_seconds_bucket{le="0.1"} 1',
    'latency_seconds_bucket{le="0.5"} 3',
    'latency_seconds_bucket{le="+Inf"} 4',
    "latency_seconds_sum 2.55",
    "latency_seconds_count 4"
  ]);
});

test("label values are escaped, so client-influenced text cannot break the format", () => {
  const registry = createRegistry();
  registry.counter("odd_total", "Odd.", ["value"]).inc(['say "hi"\\\nbye']);
  assert.match(registry.render(), /odd_total\{value="say \\"hi\\"\\\\\\nbye"\} 1/);
});

test("misuse fails loudly instead of producing a scrape Prometheus would reject", () => {
  const registry = createRegistry();
  assert.throws(() => registry.counter("x_total", "x").inc([], -1), /can only increase/);
  registry.counter("dup", "first");
  assert.throws(() => registry.gauge("dup", "second"), /already registered as a counter/);
});

test("collectors refresh gauges on every scrape", () => {
  const registry = createRegistry();
  const gauge = registry.gauge("ticks", "Ticks.");
  let ticks = 0;
  registry.collectors.push(() => gauge.set([], ++ticks));
  registry.render();
  assert.match(registry.render(), /^ticks 2$/m);
});
