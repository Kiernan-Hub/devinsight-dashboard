// Validation and normalisation for the telemetry ingest endpoint.
//
// Kept free of network and framework code so the rules that decide what enters the database
// can be tested directly. api/ingest.js is the thin HTTP wrapper around this.

export const MAX_SAMPLES_PER_REQUEST = 200;
// The client stamps created_at, so its clock is not ours. A little skew is normal; hours are
// not, and a row dated in the future would pin itself to the top of every "most recent" query.
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
// The offline queue can hold samples across a long gap — a laptop closed over a holiday. Old
// data is still real data, but at some point it is noise rather than telemetry.
export const MAX_SAMPLE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUILD_VERSION_RE = /^[A-Za-z0-9._+-]{1,40}$/;
const APP_NAME_RE = /^[A-Za-z0-9 ._-]{1,60}$/;
const PLATFORM_RE = /^[A-Za-z0-9 ._()-]{1,60}$/;
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]{0,39}$/;

// Gameplay context sampled alongside each performance reading. These are what turn "frame time
// doubled" into "frame time doubled at height 4200 with 180 live platforms" — the difference
// between knowing a regression happened and knowing where to look for it.
const CONTEXT_FIELDS = {
  height: [-1e6, 1e6],
  platform_count: [0, 100000],
  entity_count: [0, 1000000],
  lava_speed: [0, 100000]
};

export const MAX_EVENTS_PER_REQUEST = 200;
export const EVENT_TYPES = ["run_start", "run_end", "death", "powerup", "checkpoint"];

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function inRange(value, min, max) {
  return isFiniteNumber(value) && value >= min && value <= max;
}

// Optional numeric field: absent/null is fine, present-but-wrong is not.
function optionalNumber(value, min, max) {
  if (value === undefined || value === null) return { ok: true, value: null };
  return inRange(value, min, max) ? { ok: true, value } : { ok: false };
}

function parseTimestamp(value, now) {
  if (value === undefined || value === null) return { ok: true, value: new Date(now).toISOString() };
  if (typeof value !== "string") return { ok: false, reason: "created_at must be a string" };
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return { ok: false, reason: "created_at is not a valid timestamp" };
  if (parsed > now + MAX_CLOCK_SKEW_MS) return { ok: false, reason: "created_at is in the future" };
  if (parsed < now - MAX_SAMPLE_AGE_MS) return { ok: false, reason: "created_at is too old" };
  return { ok: true, value: new Date(parsed).toISOString() };
}

export function validateSession(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "session is required" };
  if (typeof raw.id !== "string" || !UUID_RE.test(raw.id)) {
    return { ok: false, reason: "session.id must be a UUID" };
  }
  if (typeof raw.build_version !== "string" || !BUILD_VERSION_RE.test(raw.build_version)) {
    return { ok: false, reason: "session.build_version is missing or malformed" };
  }
  if (raw.platform !== undefined && raw.platform !== null &&
      (typeof raw.platform !== "string" || !PLATFORM_RE.test(raw.platform))) {
    return { ok: false, reason: "session.platform is malformed" };
  }
  return {
    ok: true,
    value: {
      id: raw.id.toLowerCase(),
      build_version: raw.build_version,
      platform: raw.platform ?? null,
      // A session is "ended cleanly" only if the client said so on the way out. A session that
      // simply stops reporting is a crash, a quit, or a closed laptop — the absence of this
      // flag is itself a signal, so it is never inferred.
      ended: raw.ended === true,
      ended_cleanly: raw.ended === true ? raw.ended_cleanly === true : null
    }
  };
}

export function validateSample(raw, { now = Date.now(), session } = {}) {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "sample must be an object" };

  if (!inRange(raw.fps_rate, 0, 1000) || !Number.isInteger(raw.fps_rate)) {
    return { ok: false, reason: "fps_rate must be an integer between 0 and 1000" };
  }
  if (!inRange(raw.memory_used_mb, 0, 1048576)) {
    return { ok: false, reason: "memory_used_mb must be a number between 0 and 1048576" };
  }

  const appName = raw.app_name ?? "Ascent";
  if (typeof appName !== "string" || !APP_NAME_RE.test(appName)) {
    return { ok: false, reason: "app_name is malformed" };
  }

  const p95 = optionalNumber(raw.frame_time_p95_ms, 0, 60000);
  const max = optionalNumber(raw.frame_time_max_ms, 0, 60000);
  const frames = optionalNumber(raw.frames_sampled, 0, 1000000);
  if (!p95.ok || !max.ok || !frames.ok) {
    return { ok: false, reason: "frame timing fields must be numbers within range" };
  }

  const timestamp = parseTimestamp(raw.created_at, now);
  if (!timestamp.ok) return timestamp;

  const notes = raw.session_notes ?? null;
  if (notes !== null && (typeof notes !== "string" || notes.length > 500)) {
    return { ok: false, reason: "session_notes must be a string of at most 500 characters" };
  }

  const context = {};
  for (const [field, [min, max]] of Object.entries(CONTEXT_FIELDS)) {
    const parsed = optionalNumber(raw[field], min, max);
    if (!parsed.ok) return { ok: false, reason: `${field} must be a number between ${min} and ${max}` };
    context[field] = parsed.value;
  }
  // Counts are counts.
  for (const field of ["platform_count", "entity_count"]) {
    if (context[field] !== null) context[field] = Math.round(context[field]);
  }

  return {
    ok: true,
    value: {
      created_at: timestamp.value,
      app_name: appName,
      // build_version comes from the session, never from the individual sample. One session
      // is one build by definition, and letting each row carry its own version would let a
      // client scatter rows across builds it never actually ran.
      build_version: session.build_version,
      session_id: session.id,
      fps_rate: raw.fps_rate,
      memory_used_mb: raw.memory_used_mb,
      session_notes: notes,
      frame_time_p95_ms: p95.value,
      frame_time_max_ms: max.value,
      frames_sampled: frames.value === null ? null : Math.round(frames.value),
      ...context
    }
  };
}

export function validateEvent(raw, { now = Date.now(), session } = {}) {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "event must be an object" };

  if (typeof raw.event_type !== "string" || !EVENT_TYPE_RE.test(raw.event_type)) {
    return { ok: false, reason: "event_type must be a lowercase identifier" };
  }
  // An open vocabulary would let a client invent event names that no query knows about, and
  // the dashboard would silently ignore them. A closed set fails loudly instead.
  if (!EVENT_TYPES.includes(raw.event_type)) {
    return { ok: false, reason: `event_type must be one of: ${EVENT_TYPES.join(", ")}` };
  }

  const timestamp = parseTimestamp(raw.created_at, now);
  if (!timestamp.ok) return timestamp;

  const height = optionalNumber(raw.height, -1e6, 1e6);
  if (!height.ok) return { ok: false, reason: "height must be a number" };

  let detail = raw.detail ?? null;
  if (detail !== null) {
    if (typeof detail !== "object" || Array.isArray(detail)) {
      return { ok: false, reason: "detail must be an object" };
    }
    // Bounded so a client cannot use the free-form field as unlimited storage.
    const encoded = JSON.stringify(detail);
    if (encoded.length > 1000) return { ok: false, reason: "detail must serialise to under 1000 characters" };
  }

  return {
    ok: true,
    value: {
      created_at: timestamp.value,
      session_id: session.id,
      build_version: session.build_version,
      event_type: raw.event_type,
      height: height.value,
      detail
    }
  };
}

// Validates a whole request body.
//
// Deliberately partial: valid samples are accepted even when siblings are rejected. The client
// flushes its offline backlog as one batch, so rejecting all 100 rows because one is malformed
// would make that batch a poison pill — the client would retry it forever, never draining, and
// every good row in it would be lost. Bad rows are dropped and reported instead.
export function normalizeIngest(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  const session = validateSession(body.session);
  if (!session.ok) {
    return { ok: false, status: 400, error: session.reason };
  }

  const rawSamples = body.samples;
  if (!Array.isArray(rawSamples)) {
    return { ok: false, status: 400, error: "samples must be an array" };
  }
  if (rawSamples.length > MAX_SAMPLES_PER_REQUEST) {
    return {
      ok: false,
      status: 413,
      error: `Too many samples: ${rawSamples.length} exceeds the limit of ${MAX_SAMPLES_PER_REQUEST}`
    };
  }

  const rawEvents = body.events ?? [];
  if (!Array.isArray(rawEvents)) {
    return { ok: false, status: 400, error: "events must be an array" };
  }
  if (rawEvents.length > MAX_EVENTS_PER_REQUEST) {
    return {
      ok: false,
      status: 413,
      error: `Too many events: ${rawEvents.length} exceeds the limit of ${MAX_EVENTS_PER_REQUEST}`
    };
  }

  const accepted = [];
  const rejected = [];
  rawSamples.forEach((raw, index) => {
    const result = validateSample(raw, { now, session: session.value });
    if (result.ok) accepted.push(result.value);
    else rejected.push({ kind: "sample", index, reason: result.reason });
  });

  const acceptedEvents = [];
  rawEvents.forEach((raw, index) => {
    const result = validateEvent(raw, { now, session: session.value });
    if (result.ok) acceptedEvents.push(result.value);
    else rejected.push({ kind: "event", index, reason: result.reason });
  });

  return { ok: true, session: session.value, accepted, acceptedEvents, rejected };
}

// The row written to the `sessions` table. last_seen_at advances on every ingest, which is what
// makes an abandoned session detectable later: it has a last_seen_at but no ended_at.
//
// Deliberately carries no sample counter. Each request only knows its own batch size, so an
// upserted count would overwrite rather than accumulate — a session reporting ten times would
// end up claiming one sample. session_summary derives the true count by joining the rows.
export function sessionRow(session, { now = Date.now() } = {}) {
  const timestamp = new Date(now).toISOString();
  return {
    id: session.id,
    build_version: session.build_version,
    platform: session.platform,
    last_seen_at: timestamp,
    ...(session.ended ? { ended_at: timestamp, ended_cleanly: session.ended_cleanly } : {})
  };
}
