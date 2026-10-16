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

// Which build the comparison dropdown starts on.
//
// The manifest's declared baseline comes first, because that is what the CI gate compares
// against: a dashboard reading "warning" for the same build the gate fails as a regression is
// how a regression gets waved through. Failing that, the most recently seen build that is not
// the current one. Never the current build itself — a build compared with itself always reads
// "+0.0%, healthy".
//
// This used to be "the second most recently seen build", the same ordering bug the current-build
// side was fixed for in the September audit: playing an old build once moved it to the front of
// the list, pushed the current build into second place, and the dashboard then compared the
// current build against itself. Found by seeding three builds into the local Docker stack and
// replaying one sample from the oldest.
export function defaultBaseline(versions, { current, declaredBaseline } = {}) {
  if (declaredBaseline && declaredBaseline !== current && versions.includes(declaredBaseline)) {
    return declaredBaseline;
  }
  return versions.find(version => version !== current) ?? "";
}

// ---------------------------------------------------------------------------------------------
// Session explorer
// ---------------------------------------------------------------------------------------------

export const SESSION_LIST_LIMIT = 20;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A session id arrives from the page URL (?session=...) as well as from the database, so it is
// untrusted. PostgREST filters live in the query string; an id like "x&select=*" would otherwise
// rewrite the query. Anything that is not exactly a UUID is refused before it gets near one.
export function isSessionId(value) {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

export function sessionListPath(buildVersion = "all", limit = SESSION_LIST_LIMIT) {
  const buildFilter = buildVersion === "all" ? "" : `&build_version=eq.${encodeURIComponent(buildVersion)}`;
  return "/rest/v1/session_summary?select=id,build_version,platform,started_at,duration_seconds,sample_count,avg_fps,worst_frame_time_ms,outcome" +
    `${buildFilter}&order=started_at.desc&limit=${limit}`;
}

export function sessionDetailPaths(sessionId) {
  if (!isSessionId(sessionId)) throw new Error("not a session id");
  const id = encodeURIComponent(sessionId.toLowerCase());
  return {
    // Its own summary row, so a shared link to a session older than the visible list still
    // knows its build and outcome.
    summary: `/rest/v1/session_summary?select=id,build_version,platform,started_at,duration_seconds,sample_count,avg_fps,worst_frame_time_ms,outcome&id=eq.${id}`,
    samples: `/rest/v1/system_logs?select=created_at,fps_rate,frame_time_p95_ms,frame_time_max_ms,height,platform_count&session_id=eq.${id}&order=created_at.asc&limit=${LOG_QUERY_LIMIT}`,
    events: `/rest/v1/gameplay_events?select=created_at,event_type,height,detail&session_id=eq.${id}&order=created_at.asc&limit=500`
  };
}

export function formatDuration(seconds) {
  const total = Number(seconds);
  if (seconds == null || !Number.isFinite(total) || total < 0) return "—";
  const s = Math.round(total);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

// session_summary's outcome vocabulary, as the table shows it. Unknown values (a future view
// change, or a value this page has never heard of) render as themselves, never as "clean".
export function outcomeLabel(outcome) {
  const labels = {
    clean: { text: "Clean exit", tone: "good" },
    active: { text: "Still running", tone: "live" },
    ended_unclean: { text: "Ended unclean", tone: "bad" },
    abandoned: { text: "Abandoned", tone: "warn" }
  };
  return labels[outcome] ?? { text: String(outcome ?? "unknown"), tone: "" };
}

// Pins each gameplay event to the sample it happened during, so a death can be drawn on the
// frame-time chart at the point where it occurred: the last sample at or before the event, or
// the first sample if the event came before any (a run_start usually does). Samples must be in
// ascending time order, as sessionDetailPaths() asks for them.
export function placeEvents(samples, events) {
  if (!samples.length || !events?.length) return [];
  const times = samples.map(sample => Date.parse(sample.created_at));
  return events.map(event => {
    const at = Date.parse(event.created_at);
    let index = 0;
    while (index + 1 < times.length && times[index + 1] <= at) index += 1;
    const cause = event.detail && typeof event.detail.cause === "string" ? event.detail.cause.slice(0, 20) : null;
    const kind = event.detail && typeof event.detail.kind === "string" ? event.detail.kind.slice(0, 20) : null;
    const names = { run_start: "Start", run_end: "End", death: "Death", powerup: "Powerup", checkpoint: "Checkpoint" };
    const name = names[event.event_type] ?? String(event.event_type).slice(0, 20);
    return {
      index,
      type: event.event_type,
      label: cause ? `${name} (${cause})` : kind ? `${name} (${kind})` : name,
      height: event.height == null ? null : Number(event.height)
    };
  });
}
