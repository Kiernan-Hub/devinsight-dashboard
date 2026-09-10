// Pure comparison logic for the headless CI benchmark (godot/benchmark/). Kept separate from
// the orchestration script (run-benchmark.mjs) that shells out to Godot, the same split as
// dashboard-core.mjs/index.html and ingest-core.mjs/api/ingest.js: the decision of what counts
// as a regression should be testable without booting an engine.
//
// Thresholds are looser than the human-telemetry gate's (10%/5% in dashboard-core.mjs).
// Measured empirically: back-to-back runs of the same commit, on the same machine, varied by
// roughly +/-8% in p95 tick time purely from OS scheduling noise — a CI runner is a shared,
// noisier environment than an aggregate over hundreds of real play sessions, and this check
// runs on every single push rather than waiting for a stable sample to accumulate.
export const REGRESSION_THRESHOLD = 0.30;
export const WARNING_THRESHOLD = 0.15;

// Compares this run's p95 tick time against a stored baseline.
//
// Frame TIME, not FPS — higher is worse, which is the opposite sign convention from
// compareBuilds() in dashboard-core.mjs (where lower FPS is the regression). `change` here is
// positive when the run got slower.
export function compareBenchmarkRun(current, baseline) {
  if (!current || typeof current !== "object") {
    return { status: "invalid", message: "Benchmark produced no usable result." };
  }

  if (current.timed_out) {
    return {
      status: "timed_out",
      message: "Benchmark hit its wall-clock safety limit before finishing. Treat this as a " +
        "hung or pathologically overloaded run, not a valid measurement."
    };
  }

  if (current.ticks !== current.expected_ticks) {
    return {
      status: "invalid",
      message: `Benchmark completed ${current.ticks} of ${current.expected_ticks} ticks — ` +
        `an incomplete run cannot be compared.`
    };
  }

  if (!baseline) {
    return {
      status: "no_baseline",
      message: "No baseline recorded yet. Run `npm run benchmark:update-baseline` once the " +
        "current numbers are trusted, then commit godot/benchmark/baseline.json."
    };
  }

  // The baseline is only a valid comparison point if it describes the same workload. If the
  // benchmark's own constants changed, an old baseline's numbers describe a different amount
  // of work — comparing anyway would silently attribute a workload change to a performance
  // regression, or the reverse. This must fail loudly rather than pass on a meaningless
  // comparison, the same reasoning that keeps a "pending" gate from ever reporting success.
  if (baseline.expected_ticks !== current.expected_ticks) {
    return {
      status: "stale_baseline",
      message: `The benchmark's workload changed (expected_ticks was ${baseline.expected_ticks}, ` +
        `is now ${current.expected_ticks}). The baseline describes a different amount of work ` +
        `and must be regenerated: run \`npm run benchmark:update-baseline\` and commit the result.`
    };
  }

  const change = (current.p95_frame_time_ms - baseline.p95_frame_time_ms) / baseline.p95_frame_time_ms;
  const status = change > REGRESSION_THRESHOLD ? "regression" : change > WARNING_THRESHOLD ? "warning" : "healthy";
  const signed = `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`;

  const labels = {
    regression: `REGRESSION: p95 tick time is ${signed} versus the recorded baseline ` +
      `(${current.p95_frame_time_ms}ms vs ${baseline.p95_frame_time_ms}ms) — over the ` +
      `${(REGRESSION_THRESHOLD * 100).toFixed(0)}% budget.`,
    warning: `WARNING: p95 tick time is ${signed} versus the baseline — within budget, but trending up.`,
    healthy: `PASS: p95 tick time is ${signed} versus the baseline.`
  };

  return { status, changePercent: change * 100, message: labels[status] };
}

// Extracts the JSON result from Godot's stdout. The engine prints its own startup/shutdown
// noise on the same stream, so the result line is picked out by its unique prefix rather than
// assumed to be the last line or the only line.
export function extractResult(stdout, prefix = "BENCHMARK_RESULT:") {
  const line = stdout.split("\n").map(l => l.trim()).find(l => l.startsWith(prefix));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
}
