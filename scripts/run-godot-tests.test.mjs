// The rule that decides whether a Godot suite passed. Godot's exit code alone says "success" for
// a test file that failed to parse and ran nothing, which is the case these tests pin down.

import test from "node:test";
import assert from "node:assert/strict";
import { judge } from "./run-godot-tests.mjs";

test("a clean run with its PASS line passes, and its check count is read", () => {
  assert.deepEqual(judge({ status: 0, output: "  ok  a\n\nPASS — 46 checks\n" }), { ok: true, checks: 46 });
});

test("a parse error fails even though Godot exits 0", () => {
  const output = 'SCRIPT ERROR: Parse Error: Not all code paths return a value.\nERROR: Failed to load script "res://tests/x.gd"\n';
  assert.equal(judge({ status: 0, output }).ok, false);
});

test("a run that never prints its PASS line fails", () => {
  assert.equal(judge({ status: 0, output: "  ok  a\n" }).ok, false);
});

test("a runtime script error fails even if the suite's own count says PASS", () => {
  assert.equal(judge({ status: 0, output: "SCRIPT ERROR: Invalid access\nPASS — 3 checks\n" }).ok, false);
});

test("a non-zero exit fails", () => {
  assert.equal(judge({ status: 1, output: "FAIL — 1 of 3 checks failed\n" }).ok, false);
});
