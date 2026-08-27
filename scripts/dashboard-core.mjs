export const REGRESSION_THRESHOLD = 0.10;
export const WARNING_THRESHOLD = 0.05;

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
  return {
    currentFps: fps.at(-1),
    averageFps: fps.reduce((sum, value) => sum + value, 0) / fps.length,
    onePercentLow: percentile(fps, 0.01),
    // A low-FPS sample is a high frame-time sample; calculate the percentile in ms.
    p95FrameTime: percentile(fps.map(value => 1000 / value), 0.95),
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

export function detectEvents(logs) {
  const events = [];
  for (let index = 0; index < logs.length; index += 1) {
    const row = logs[index];
    const previous = logs[index - 1];
    if (!previous || row.build_version !== previous.build_version) {
      events.push({ type: "build", index, time: row.created_at, label: `Build ${row.build_version || "unversioned"}`, detail: "First sample in range" });
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

export function logsPath(rangeMinutes, buildVersion = "all") {
  const since = new Date(Date.now() - rangeMinutes * 60_000).toISOString();
  const buildFilter = buildVersion === "all" ? "" : `&build_version=eq.${encodeURIComponent(buildVersion)}`;
  return `/rest/v1/system_logs?select=*&created_at=gte.${encodeURIComponent(since)}${buildFilter}&order=created_at.asc&limit=2000`;
}
