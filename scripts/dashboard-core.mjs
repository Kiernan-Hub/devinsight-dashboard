export const REGRESSION_THRESHOLD = 0.10;
export const WARNING_THRESHOLD = 0.05;
export const LOG_QUERY_LIMIT = 2000;

export function percentile(values, quantile) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const weight = index - lower;
  return sorted[lower + 1] === undefined
    ? sorted[lower]
    : sorted[lower] + weight * (sorted[lower + 1] - sorted[lower]);
}

export function summarizeLogs(logs) {
  const fps = logs.map(row => Number(row.fps_rate)).filter(value => value > 0 && Number.isFinite(value));
  const memory = logs.map(row => Number(row.memory_used_mb)).filter(Number.isFinite);
  if (!fps.length || !memory.length) return null;

  // Prefer frame timings actually measured over every frame in the interval (build 0.4.0+).
  // Falling back to 1000/fps is only an approximation of a smoothed per-second average, so
  // it cannot show a stutter — `frameTimeSource` lets the UI say which one it is showing
  // instead of labelling both "P95 frame time" and hoping nobody asks.
  const measuredP95 = logs.map(row => Number(row.frame_time_p95_ms)).filter(Number.isFinite);
  const measuredMax = logs.map(row => Number(row.frame_time_max_ms)).filter(Number.isFinite);
  const hasMeasured = measuredP95.length > 0;

  return {
    currentFps: fps.at(-1),
    averageFps: fps.reduce((sum, value) => sum + value, 0) / fps.length,
    onePercentLow: percentile(fps, 0.01),
    p95FrameTime: hasMeasured
      ? percentile(measuredP95, 0.95)
      : percentile(fps.map(value => 1000 / value), 0.95),
    frameTimeSource: hasMeasured ? "measured" : "derived",
    worstFrameMs: measuredMax.length ? Math.max(...measuredMax) : null,
    framesSampled: logs.reduce((total, row) => total + (Number(row.frames_sampled) || 0), 0),
    currentMemory: memory.at(-1),
    memoryDelta: memory.at(-1) - memory[0],
    sampleCount: logs.length
  };
}

export function compareBuilds(current, previous) {
  const currentAverage = Number(current?.avg_fps);
  const previousAverage = Number(previous?.avg_fps);
  if (!Number.isFinite(currentAverage) || !Number.isFinite(previousAverage) || previousAverage <= 0) return null;
  const changePercent = ((currentAverage - previousAverage) / previousAverage) * 100;
  const decline = -changePercent / 100;
  return {
    changePercent,
    status: decline > REGRESSION_THRESHOLD ? "regression" : decline > WARNING_THRESHOLD ? "warning" : "healthy"
  };
}

// Decides what the CI gate should do. Separated from the network and process-exit code in
// check-regression.mjs so the decision itself is testable without a database.
//
// "pending" exists because a gate with too little evidence must not report success — a green
// check that means "I couldn't tell" is how a real regression ships.
export function verdictFor({ current, baseline, manifest }) {
  const minSamples = Number(manifest?.min_samples) || 0;
  const buildVersion = manifest?.build_version ?? "unknown";
  const baselineVersion = manifest?.baseline_version ?? "unknown";

  if (!current) {
    return {
      status: "pending",
      message:
        `PENDING: no telemetry recorded for build ${buildVersion} yet.\n` +
        `Run that build so it reports samples, then re-run this check. ` +
        `The gate cannot pass or fail a build it has never measured.`
    };
  }

  if (Number(current.sample_count) < minSamples) {
    return {
      status: "pending",
      message:
        `PENDING: build ${buildVersion} has ${current.sample_count} samples, ` +
        `below the ${minSamples} required to judge it.`
    };
  }

  if (!baseline) {
    return {
      status: "pending",
      message: `PENDING: no telemetry recorded for baseline ${baselineVersion}; nothing to compare against.`
    };
  }

  if (Number(baseline.sample_count) < minSamples) {
    return {
      status: "pending",
      message:
        `PENDING: baseline ${baselineVersion} has ${baseline.sample_count} samples, ` +
        `below the ${minSamples} required to be a trustworthy comparison.`
    };
  }

  const comparison = compareBuilds(current, baseline);
  if (!comparison) {
    return { status: "pending", message: "PENDING: build averages are not comparable numbers." };
  }

  const change = comparison.changePercent;
  const signed = `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;

  if (comparison.status === "regression") {
    return {
      status: "regression",
      changePercent: change,
      message: `REGRESSION: build ${buildVersion} is ${signed} versus ${baselineVersion} — over the ${(REGRESSION_THRESHOLD * 100).toFixed(0)}% budget.`
    };
  }

  if (comparison.status === "warning") {
    return {
      status: "warning",
      changePercent: change,
      message: `WARNING: build ${buildVersion} is ${signed} versus ${baselineVersion} — within budget, but trending down.`
    };
  }

  return {
    status: "healthy",
    changePercent: change,
    message: `PASS: build ${buildVersion} is ${signed} versus ${baselineVersion}.`
  };
}

export function detectEvents(logs) {
  const events = [];
  for (let index = 0; index < logs.length; index += 1) {
    const row = logs[index];
    const previous = logs[index - 1];
    // Only a genuine boundary between two builds is an event. Flagging the first row in the
    // window was flagging the edge of the query, not anything that happened in the game.
    if (previous && row.build_version !== previous.build_version) {
      events.push({
        type: "build",
        index,
        time: row.created_at,
        label: `Build ${row.build_version || "unversioned"}`,
        detail: `Switched from ${previous.build_version || "unversioned"}`
      });
    }
    if (previous) {
      const before = Number(previous.fps_rate);
      const after = Number(row.fps_rate);
      if (before > 0 && after <= before * 0.7) {
        events.push({ type: "drop", index, time: row.created_at, label: "FPS drop", detail: `${before.toFixed(0)} → ${after.toFixed(0)} FPS` });
      }
      const memoryDelta = Number(row.memory_used_mb) - Number(previous.memory_used_mb);
      if (Number.isFinite(memoryDelta) && memoryDelta >= 8) {
        events.push({ type: "memory", index, time: row.created_at, label: "Memory spike", detail: `+${memoryDelta.toFixed(1)} MB` });
      }
    }
  }
  return events.reverse();
}

// Newest-first with a limit, so a window holding more rows than the limit yields the most
// recent slice. Ascending order gave the *oldest* rows in the window: on the 24h view — about
// 17,000 rows at one sample per 5s — the dashboard showed the first 2,000 and then labelled a
// reading from ~21 hours ago "Current FPS". Callers reverse the result for display.
export function logsPath(rangeMinutes, buildVersion = "all", limit = LOG_QUERY_LIMIT) {
  const since = new Date(Date.now() - rangeMinutes * 60_000).toISOString();
  const buildFilter = buildVersion === "all" ? "" : `&build_version=eq.${encodeURIComponent(buildVersion)}`;
  return `/rest/v1/system_logs?select=*&created_at=gte.${encodeURIComponent(since)}${buildFilter}&order=created_at.desc&limit=${limit}`;
}
