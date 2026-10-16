// Runs the GDScript test suites and decides pass/fail itself, because Godot's exit code cannot.
//
//   npm run test:godot            (GODOT_BIN overrides the `godot` on PATH)
//
// When a --script fails to *parse* — a typo in a test, or in godot/system_logger.gd, which the
// tests load — Godot prints "Parse Error", runs nothing, and exits 0. CI then reported the Godot
// tests as passed with zero checks run. (Found by running a test file with a missing `return`.)
// So a suite only passes here if Godot exited 0, printed its own final "PASS — N checks" line,
// and printed no SCRIPT ERROR anywhere along the way.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const GODOT = process.env.GODOT_BIN || "godot";
const SUITES = ["tests/test_logger_queue.gd", "tests/test_benchmark_model.gd"];

// Pure, so the rule itself is unit-tested (run-godot-tests.test.mjs).
export function judge({ status, output }) {
  const passLine = output.match(/^PASS — (\d+) checks$/m);
  if (/SCRIPT ERROR|Parse Error/.test(output)) return { ok: false, reason: "script error (see output above)" };
  if (status !== 0) return { ok: false, reason: `Godot exited ${status}` };
  if (!passLine) return { ok: false, reason: "no final PASS line: the suite did not run to completion" };
  return { ok: true, checks: Number(passLine[1]) };
}

function main() {
  let failed = 0;
  let checks = 0;
  for (const suite of SUITES) {
    const run = spawnSync(GODOT, ["--headless", "--path", "godot", "--script", suite], { encoding: "utf8" });
    if (run.error) {
      console.error(`${suite}: could not start Godot (${run.error.message}). Set GODOT_BIN or put godot on PATH.`);
      return 1;
    }
    const output = `${run.stdout}${run.stderr}`;
    process.stdout.write(output);
    const verdict = judge({ status: run.status, output });
    if (verdict.ok) checks += verdict.checks;
    else {
      failed += 1;
      console.error(`\n✖ ${suite}: ${verdict.reason}\n`);
    }
  }
  console.log(failed ? `\n${failed} Godot suite(s) failed` : `\nAll Godot suites passed — ${checks} checks`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
