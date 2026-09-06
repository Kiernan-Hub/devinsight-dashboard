// CI entry point for the performance gate.
//
// This file is deliberately thin: it does the untestable work (read env, hit
// the network, exit with a status code) and delegates every decision to
// scripts/regression-core.mjs, which is covered by regression-core.test.mjs.

import { evaluateRegression, exitCodeFor, formatReport } from "./regression-core.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables.");
  process.exit(1);
}

async function fetchBuildSummary() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/build_fps_summary?select=*&order=last_seen.desc`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`
      }
    }
  );

  if (!res.ok) {
    console.error(`Supabase request failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  return res.json();
}

const result = evaluateRegression(await fetchBuildSummary());
console.log(formatReport(result));
process.exit(exitCodeFor(result));
