// Runs the Vercel-style handlers in api/ on a plain Node HTTP server.
//
// On Vercel, a handler receives a request whose body has already been read, and a response
// with a few helpers bolted on (res.status() among them). Plain Node's http module provides
// neither. This file supplies exactly those two things, so api/ingest.js runs here unchanged:
// the file Vercel deploys is byte-for-byte the file the Docker image runs. If the two ever
// needed different handler code, a bug could exist in one deployment and not the other, and
// local testing would stop meaning anything about production.

import http from "node:http";

// Transport-level cap: the stand-in for the request size limit Vercel enforces before a handler
// ever runs. The handler has its own, tighter limit (256 KB) and stays the authority on what is
// acceptable; this one only stops a client from streaming an unbounded body into memory.
export const MAX_REQUEST_BYTES = 1024 * 1024;

// Resolves to the body as a string, or to null if it exceeded `limit`. An oversized body is
// drained and discarded rather than cut off mid-stream, because destroying the socket would
// also destroy the 413 response that explains why.
export function readBody(req, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// The `_FILE` convention: a secret can be supplied as the path to a file holding it, instead of
// as the value itself. Docker secrets, Kubernetes, and this project's own local key generator
// (scripts/local-keys.mjs) all hand secrets over as files, and a file's contents never show up
// in `docker inspect` or a process listing the way an environment variable's do.
export function resolveSecretFiles(env, names, readFile) {
  for (const name of names) {
    const path = env[`${name}_FILE`];
    if (!path) continue;
    if (env[name]) {
      // Two sources for one secret means one of them is silently ignored. Refuse to guess which.
      throw new Error(`Both ${name} and ${name}_FILE are set; set only one`);
    }
    env[name] = readFile(path, "utf8").trim();
  }
  return env;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

// `routes` maps an exact path to a handler, e.g. { "/api/ingest": handler }. Vercel's routing is
// file-based; with a single function, an explicit table is simpler and says everything there is
// to know about what this server exposes.
export function createServer(routes, { log = console } = {}) {
  return http.createServer(async (req, res) => {
    const started = performance.now();
    const { pathname } = new URL(req.url, "http://localhost");
    res.on("finish", () => {
      // One line per request, never the body: telemetry payloads are not secret, but a habit of
      // logging request bodies is how secrets eventually end up in logs.
      log.info(`${req.method} ${pathname} ${res.statusCode} ${(performance.now() - started).toFixed(1)}ms`);
    });

    // Liveness only. It deliberately does not touch the database: a container whose database is
    // briefly unreachable is still a healthy container, and restarting it would not help.
    if (pathname === "/healthz") {
      return sendJson(res, 200, { ok: true });
    }

    const handler = routes[pathname];
    if (!handler) {
      return sendJson(res, 404, { error: "Not found" });
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: "Could not read request body" });
    }
    if (body === null) {
      res.setHeader("Connection", "close");
      return sendJson(res, 413, { error: "Request body too large" });
    }

    // The two Vercel conveniences the handlers rely on. The body is passed as the raw string
    // rather than pre-parsed JSON so the handler's own size check and its "not valid JSON" 400
    // both still run — parsing it here would quietly skip them.
    req.body = body;
    res.status = code => {
      res.statusCode = code;
      return res;
    };

    try {
      await handler(req, res);
    } catch (error) {
      log.error(`${req.method} ${pathname} handler threw:`, error);
      if (!res.headersSent) return sendJson(res, 500, { error: "Internal error" });
    }

    // A handler that returned without finishing the response would leave the client hanging
    // until it timed out. Finish it, loudly, so the bug shows up in the logs instead.
    if (!res.writableEnded) {
      log.error(`${req.method} ${pathname} handler returned without sending a response`);
      if (!res.headersSent) return sendJson(res, 500, { error: "Internal error" });
      res.end();
    }
  });
}
