// POST /api/ingest — the only way telemetry enters the database.
//
// Before this existed, the game wrote to Supabase directly with the anon key. That key ships
// inside the game binary and inside the dashboard's JavaScript, so "anyone who has opened the
// dashboard can write anything to the telemetry table" was a load-bearing part of the design.
//
// Moving writes behind this endpoint does not make the client credential secret — nothing
// shipped in a binary is. What it changes is what that credential can do: it grants "append a
// validated sample to your own session" instead of "write arbitrary rows". The database key
// with real write power now lives only here, in server-side environment variables.

import { normalizeIngest, sessionRow, MAX_SAMPLES_PER_REQUEST } from "../lib/ingest-core.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INGEST_TOKEN = process.env.INGEST_TOKEN;

// 256 KB. MAX_SAMPLES_PER_REQUEST already bounds the row count; this bounds the bytes, so a
// single enormous string field cannot be used to burn function memory.
const MAX_BODY_BYTES = 256 * 1024;

function send(res, status, payload) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

async function supabase(path, { method = "POST", body, headers = {} }) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Supabase ${method} ${path} failed: ${response.status} ${detail.slice(0, 300)}`);
  }
  return response;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Method not allowed" });
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error("ingest: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured");
    return send(res, 500, { error: "Ingest is not configured" });
  }

  // Constant-time-ish comparison is overkill for a token that ships in a game binary; the
  // point of the check is to keep casual traffic and stray crawlers out of the table, not to
  // withstand a timing attack from someone who can already read the token.
  if (INGEST_TOKEN) {
    const provided = req.headers["x-ingest-token"];
    if (provided !== INGEST_TOKEN) {
      return send(res, 401, { error: "Invalid or missing ingest token" });
    }
  }

  let body = req.body;
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return send(res, 413, { error: "Request body too large" });
    }
    try {
      body = JSON.parse(body);
    } catch {
      return send(res, 400, { error: "Request body is not valid JSON" });
    }
  }

  const result = normalizeIngest(body);
  if (!result.ok) {
    return send(res, result.status, { error: result.error });
  }

  const { session, accepted, rejected } = result;

  try {
    // Upsert the session first: system_logs.session_id references it, so the parent row has to
    // exist before the samples that point at it.
    await supabase("sessions?on_conflict=id", {
      body: [sessionRow(session)],
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" }
    });

    if (accepted.length) {
      await supabase("system_logs", {
        body: accepted,
        headers: { Prefer: "return=minimal" }
      });
    }
  } catch (error) {
    // 502, not 400: the client's payload was fine, our downstream was not. The distinction
    // matters to the offline queue — a client must retry this, and must not retry a 400.
    console.error("ingest:", error.message);
    return send(res, 502, { error: "Could not record telemetry" });
  }

  // 200 even when some samples were rejected. The offline queue retries anything that is not a
  // success, so failing the whole batch over one bad row would make that batch a poison pill:
  // retried forever, never drained, every good row in it lost. The rejects are reported instead
  // so a malformed client is visible in the response rather than silently dropped.
  return send(res, 200, {
    session_id: session.id,
    accepted: accepted.length,
    rejected: rejected.length,
    ...(rejected.length ? { rejections: rejected.slice(0, 10) } : {}),
    limits: { max_samples_per_request: MAX_SAMPLES_PER_REQUEST }
  });
}
