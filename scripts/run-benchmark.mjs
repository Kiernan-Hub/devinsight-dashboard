// Runs the headless Godot benchmark, compares it against the committed baseline, and exits
// non-zero on a regression. This is what makes the performance gate automatic: unlike
// check-regression.mjs, which waits for a human to have played the build, this script
// generates real telemetry for the current commit itself, on every push or PR.
//
// Runs the benchmark TRIALS_PER_RUN times and compares the MINIMUM p95 tick time across
// trials, not a single sample. Measured empirically on a real (if busy) dev machine: a single
// trial's p95 swung from -23% to +14% around its own mean, run to run, purely from OS
// scheduling noise — comfortably capable of tripping a naive single-sample threshold in either
// direction. Taking the minimum across repeated trials is standard practice for exactly this
// reason: scheduling noise can only ever ADD delay on top of the real cost, never subtract
// from it, so the minimum across trials is the least noise-contaminated estimate of what the
// code actually costs. A real regression still shows up as a higher minimum; a lucky trial
// does not produce a falsely low one, because it has to win against the other trials too.
//
// Usage:
//   node scripts/run-benchmark.mjs                  # run and compare against the baseline
//   node scripts/run-benchmark.mjs --update-baseline # run and OVERWRITE the baseline
//
// GODOT_BIN selects the binary (default: "godot" on PATH, matching how CI installs it).

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compareBenchmarkRun, extractResult } from "./benchmark-core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GODOT_DIR = join(ROOT, "godot");
const BASELINE_PATH = join(GODOT_DIR, "benchmark", "baseline.json");
const GODOT_BIN = process.env.GODOT_BIN || "godot";
const TRIALS_PER_RUN = 3;
// Generous relative to the benchmark's own ~180s internal safety valve: this also has to cover
// Godot's own startup time and leaves room for a slow CI runner before we give up entirely.
const PROCESS_TIMEOUT_MS = 5 * 60 * 1000;

function runGodotBenchmark() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      GODOT_BIN,
      ["--headless", "--path", GODOT_DIR, "--script", "benchmark/benchmark_scene.gd"],
      { timeout: PROCESS_TIMEOUT_MS }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });

    child.on("error", error => {
      // ENOENT here almost always means Godot isn't on PATH / GODOT_BIN is wrong — surface
      // that plainly rather than as an opaque spawn error.
      if (error.code === "ENOENT") {
        reject(new Error(
          `Could not run "${GODOT_BIN}". Set GODOT_BIN to the Godot executable's path, or ` +
          `install it so it's on PATH.`
        ));
      } else {
        reject(error);
      }
    });

    child.on("close", code => {
      if (child.killed) {
        reject(new Error(`Godot did not exit within ${PROCESS_TIMEOUT_MS / 1000}s and was killed.`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function loadBaseline() {
  try {
    return JSON.parse(await readFile(BASELINE_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Runs one trial and classifies it. A trial that crashed, produced no parsable result, or
// exited non-zero is reported as "malfunction" rather than silently excluded — one bad trial
// in the batch is itself information (something is wrong with this run), not noise to average
// away.
async function runTrial(index) {
  console.log(`Trial ${index + 1}/${TRIALS_PER_RUN}...`);
  const { code, stdout, stderr } = await runGodotBenchmark();
  const result = extractResult(stdout);

  if (!result) {
    console.error(`  malfunction: no parsable result (exit ${code})`);
    console.error("  --- stdout ---\n" + stdout.split("\n").map(l => "  " + l).join("\n"));
    console.error("  --- stderr ---\n" + stderr.split("\n").map(l => "  " + l).join("\n"));
    return { ok: false, result: null };
  }
  if (code !== 0) {
    console.error(`  malfunction: Godot exited ${code}\n` + stderr);
    return { ok: false, result };
  }
  if (result.timed_out || result.ticks !== result.expected_ticks) {
    console.error(`  malfunction: ${result.timed_out ? "timed out" : `only ${result.ticks}/${result.expected_ticks} ticks`}`);
    return { ok: false, result };
  }

  console.log(`  p95=${result.p95_frame_time_ms}ms  max=${result.max_frame_time_ms}ms  peak obstacles=${result.max_obstacle_count}`);
  return { ok: true, result };
}

async function main() {
  const updateBaseline = process.argv.includes("--update-baseline");

  console.log(`Running headless benchmark: ${TRIALS_PER_RUN} trials via ${GODOT_BIN}`);
  const trials = [];
  for (let i = 0; i < TRIALS_PER_RUN; i += 1) {
    trials.push(await runTrial(i));
  }

  const failed = trials.find(trial => !trial.ok);
  if (failed) {
    console.error("\nAt least one trial malfunctioned; refusing to compute an aggregate from a mixed batch.");
    return 1;
  }

  const successful = trials.map(trial => trial.result);
  const best = successful.reduce((min, trial) => trial.p95_frame_time_ms < min.p95_frame_time_ms ? trial : min);
  const p95Values = successful.map(t => t.p95_frame_time_ms);

  console.log(`\nBest of ${TRIALS_PER_RUN}: p95=${best.p95_frame_time_ms}ms (trials were: ${p95Values.join(", ")}ms)`);

  if (updateBaseline) {
    await writeFile(BASELINE_PATH, JSON.stringify(best, null, 2) + "\n");
    console.log(`Baseline updated: ${BASELINE_PATH}`);
    console.log("Review the diff and commit it deliberately — this is a golden-file update, not something the gate should ever do on its own.");
    return 0;
  }

  const baseline = await loadBaseline();
  const verdict = compareBenchmarkRun(best, baseline);
  console.log("");
  console.log(verdict.message);

  // "no_baseline" is the one status that passes without failing: it means only "nothing to
  // compare against yet," expected on the very first run before a baseline is committed, and
  // the existing gate's "pending must never silently pass" rule doesn't apply to it because it
  // isn't hiding a possible regression — there is no prior number for this run to have regressed
  // against. Every other non-healthy status means the comparison itself is untrustworthy (a
  // stale baseline) or the result is, which must fail loudly rather than pass silently.
  const passing = new Set(["healthy", "warning", "no_baseline"]);
  return passing.has(verdict.status) ? 0 : 1;
}

// A stack trace is not a useful CI failure — a missing Godot binary or a broken pipe should
// read as one clear line in the job log, the same reasoning applied to check-regression.mjs.
try {
  process.exit(await main());
} catch (error) {
  console.error(`\nBenchmark gate could not run: ${error.message}`);
  process.exit(1);
}
