// Runs the ingest API as an ordinary, long-lived Node server. This is what the Docker image runs.
//
// On Vercel this file is not used at all: Vercel calls api/ingest.js directly. The adapter in
// lib/node-server.mjs exists so that both paths execute the very same handler file.
//
//   node server.mjs        # listens on $PORT, default 8787
//
// Configuration is the same three variables Vercel uses (see README), each of which may instead
// be given as a file path via the `_FILE` suffix — e.g. SUPABASE_SERVICE_ROLE_KEY_FILE.

import { readFileSync } from "node:fs";
import { metrics } from "./lib/metrics.mjs";
import { createServer, registerProcessMetrics, resolveSecretFiles } from "./lib/node-server.mjs";

// This has to happen before the handler is imported, because api/ingest.js reads its
// configuration once, when the module first loads.
resolveSecretFiles(process.env, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "INGEST_TOKEN"], readFileSync);

const { default: ingest } = await import("./api/ingest.js");

const port = Number(process.env.PORT || 8787);
registerProcessMetrics(metrics);
const server = createServer({ "/api/ingest": ingest }, { metrics });

server.listen(port, () => {
  console.info(`ingest: listening on :${port}`);
  if (!process.env.INGEST_TOKEN) {
    console.info("ingest: INGEST_TOKEN is not set; accepting telemetry without a token");
  }
});

// `docker stop` sends SIGTERM, waits ten seconds, then sends SIGKILL. Inside a container Node
// runs as process 1, and Linux gives process 1 no default signal handling — so without this,
// SIGTERM is ignored, every stop takes the full ten seconds, and the eventual SIGKILL cuts off
// any request that was halfway through writing to the database. Closing the server stops new
// connections and lets in-flight requests finish first.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    console.info(`ingest: ${signal} received, finishing in-flight requests`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  });
}
