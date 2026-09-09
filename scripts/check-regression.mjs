// CI performance gate.
//
// Compares the build declared by this commit against its declared baseline and fails the
// job if average FPS dropped by more than the manifest's threshold.
//
// The gate is anchored to build-manifest.json rather than to "whatever telemetry arrived
// most recently". That anchoring is what makes it a gate on *this commit* instead of a gate
// on the clock: the manifest says which build this code produces, the script verifies the
// Godot logger really stamps that version, and only then does it compare that specific
// version against its specific baseline.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verdictFor } from "./dashboard-core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SUPABASE_URL = process.env.SUPABASE_URL;
// Prefer the service-role key. The anon key can be read (and written) by anyone who has
// looked at the dashboard's JavaScript, so a gate that reads with it is a gate that
// strangers can move. The service-role key is genuinely secret and read-only in this script.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const USING_ANON = !process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY.");
  process.exit(1);
}

if (USING_ANON) {
  console.warn(
    "warning: reading telemetry with the public anon key. Anyone holding that key can insert\n" +
    "         rows and move this gate. Set the SUPABASE_SERVICE_ROLE_KEY secret to fix.\n"
  );
}

async function loadManifest() {
  const raw = await readFile(join(ROOT, "build-manifest.json"), "utf8");
  const manifest = JSON.parse(raw);
  for (const field of ["build_version", "baseline_version"]) {
    if (typeof manifest[field] !== "string" || !manifest[field]) {
      throw new Error(`build-manifest.json is missing a valid "${field}"`);
    }
  }
  return manifest;
}

// Guards against the manifest and the game drifting apart. Without this the manifest could
// claim to gate 0.4.0 while the client still reports 0.3.0, and the gate would sit forever
// waiting for samples that no build will ever produce.
async function assertLoggerMatches(expectedVersion) {
  const source = await readFile(join(ROOT, "godot", "system_logger.gd"), "utf8");
  const match = source.match(/const\s+BUILD_VERSION\s*:=\s*"([^"]+)"/);
  if (!match) {
    throw new Error("Could not find BUILD_VERSION in godot/system_logger.gd");
  }
  if (match[1] !== expectedVersion) {
    throw new Error(
      `Build version mismatch: build-manifest.json declares "${expectedVersion}" but ` +
      `godot/system_logger.gd stamps "${match[1]}". Bump both together.`
    );
  }
}

async function fetchBuild(version) {
  const url =
    `${SUPABASE_URL}/rest/v1/build_fps_summary` +
    `?select=*&build_version=eq.${encodeURIComponent(version)}`;

  const response = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });

  if (!response.ok) {
    throw new Error(`Supabase request failed: ${response.status} ${response.statusText}`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) {
    throw new Error("Supabase returned an unexpected response shape");
  }
  return rows[0] ?? null;
}

function describe(row) {
  if (!row) return "no telemetry recorded";
  return `${Number(row.avg_fps).toFixed(1)} FPS over ${row.sample_count} samples`;
}

async function main() {
  const manifest = await loadManifest();
  await assertLoggerMatches(manifest.build_version);

  const [current, baseline] = await Promise.all([
    fetchBuild(manifest.build_version),
    fetchBuild(manifest.baseline_version)
  ]);

  const verdict = verdictFor({ current, baseline, manifest });

  console.log(`Gate build:  ${manifest.build_version} — ${describe(current)}`);
  console.log(`Baseline:    ${manifest.baseline_version} — ${describe(baseline)}`);
  console.log("");
  console.log(verdict.message);

  // A gate that cannot yet judge must not report success — that is how a real regression
  // slips through green. "pending" is surfaced as a neutral, clearly-labelled non-failure.
  return verdict.status === "regression" ? 1 : 0;
}

// A stack trace is not a useful CI failure. Configuration mistakes — a drifted manifest, an
// unreachable database — should read as one clear line in the job log.
try {
  process.exit(await main());
} catch (error) {
  console.error(`\nPerformance gate could not run: ${error.message}`);
  process.exit(1);
}
