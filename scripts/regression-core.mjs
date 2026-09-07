// Pure decision logic for the CI performance gate.
//
// Deliberately free of network access, environment variables, and process.exit
// so every branch below can be unit tested. scripts/check-regression.mjs is the
// thin I/O shell that fetches the data and turns a verdict into an exit code.

export const REGRESSION_THRESHOLD = 0.10; // fail if avg FPS drops more than 10%

// The Godot logger reports one sample every 5 seconds, so 30 samples is about
// 2.5 minutes of gameplay. Below that an average is noise, not a measurement:
// a single load screen or alt-tab can move it further than a real regression.
export const MIN_SAMPLES = 30;

function toBuild(row) {
  const avgFps = Number(row?.avg_fps);
  const sampleCount = Number(row?.sample_count);
  return {
    version: row?.build_version ?? null,
    avgFps: Number.isFinite(avgFps) ? avgFps : null,
    // A view that doesn't expose sample_count yields null, which the caller
    // treats as "unknown" rather than "zero" — see selectBuilds below.
    sampleCount: Number.isFinite(sampleCount) ? sampleCount : null,
    lastSeen: row?.last_seen ?? null
  };
}

function isUsable(build, minSamples) {
  if (build.avgFps === null || build.avgFps <= 0) return false;
  // Unknown sample counts are allowed through; a missing column shouldn't
  // silently disable the gate on every build.
  return build.sampleCount === null || build.sampleCount >= minSamples;
}

/**
 * Pick the build under test and the baseline to compare it against.
 *
 * The Supabase query orders by last_seen, but order alone is fragile: replaying
 * telemetry for an old build would promote it to "latest". Sorting here on
 * last_seen and requiring a *different* build_version for the baseline makes
 * the selection explicit instead of implied by the query string.
 */
export function selectBuilds(rows, { minSamples = MIN_SAMPLES } = {}) {
  const builds = (Array.isArray(rows) ? rows : [])
    .map(toBuild)
    .filter(build => build.version)
    .sort((a, b) => String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? "")));

  const latest = builds[0] ?? null;
  const baseline = latest
    ? builds.find(build => build.version !== latest.version && isUsable(build, minSamples)) ?? null
    : null;

  return { latest, baseline };
}

/**
 * Decide whether the latest build regressed against its baseline.
 *
 * Returns a verdict rather than an exit code so the caller decides what is
 * fatal. Verdicts:
 *   "no-baseline"          — fewer than two comparable builds; nothing to gate
 *   "insufficient-samples" — not enough data behind the latest build's average
 *   "regression"           — avg FPS dropped past the threshold
 *   "pass"                 — within threshold
 */
export function evaluateRegression(rows, options = {}) {
  const { threshold = REGRESSION_THRESHOLD, minSamples = MIN_SAMPLES } = options;
  const { latest, baseline } = selectBuilds(rows, { minSamples });

  if (!latest || latest.avgFps === null) {
    return { verdict: "no-baseline", latest, baseline: null, reason: "No build data available yet." };
  }

  if (latest.sampleCount !== null && latest.sampleCount < minSamples) {
    return {
      verdict: "insufficient-samples",
      latest,
      baseline,
      reason:
        `Build ${latest.version} has only ${latest.sampleCount} samples ` +
        `(minimum ${minSamples}). Its average FPS is not yet reliable enough to gate on.`
    };
  }

  if (!baseline) {
    return {
      verdict: "no-baseline",
      latest,
      baseline: null,
      reason: `No previous build with at least ${minSamples} samples to compare against.`
    };
  }

  const drop = (baseline.avgFps - latest.avgFps) / baseline.avgFps;
  const changePercent = -drop * 100;

  return {
    verdict: drop > threshold ? "regression" : "pass",
    latest,
    baseline,
    drop,
    changePercent,
    reason:
      drop > threshold
        ? `Build ${latest.version} is down ${(drop * 100).toFixed(1)}% from ${baseline.version} ` +
          `(threshold ${(threshold * 100).toFixed(0)}%).`
        : `Build ${latest.version} is within ${(threshold * 100).toFixed(0)}% of ${baseline.version}.`
  };
}

function describe(build) {
  if (!build) return "none";
  const samples = build.sampleCount === null ? "sample count unknown" : `${build.sampleCount} samples`;
  return `${build.version} — ${build.avgFps.toFixed(1)} FPS (${samples})`;
}

/** Render a verdict as the multi-line text the CI job prints. */
export function formatReport(result) {
  const lines = [
    `Latest build:   ${describe(result.latest)}`,
    `Baseline build: ${describe(result.baseline)}`,
    ""
  ];

  if (result.verdict === "regression") lines.push(`FAIL  ${result.reason}`);
  else if (result.verdict === "insufficient-samples") lines.push(`SKIP  ${result.reason}`);
  else if (result.verdict === "no-baseline") lines.push(`SKIP  ${result.reason}`);
  else lines.push(`PASS  ${result.reason} (${result.changePercent >= 0 ? "+" : ""}${result.changePercent.toFixed(1)}%)`);

  return lines.join("\n");
}

/** Only a confirmed regression fails the build; missing data is never a failure. */
export function exitCodeFor(result) {
  return result.verdict === "regression" ? 1 : 0;
}
