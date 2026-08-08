const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const REGRESSION_THRESHOLD = 0.10; // fail if avg FPS drops more than 10%

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

const builds = await fetchBuildSummary();

if (builds.length < 2) {
  console.log("Not enough builds to compare yet. Skipping regression check.");
  process.exit(0);
}

const [latest, previous] = builds;
const drop = (previous.avg_fps - latest.avg_fps) / previous.avg_fps;

console.log(`Latest build:   ${latest.build_version} — ${latest.avg_fps} FPS`);
console.log(`Previous build: ${previous.build_version} — ${previous.avg_fps} FPS`);

if (drop > REGRESSION_THRESHOLD) {
  console.error(
    `\n⚠ Performance regression detected: build ${latest.build_version} is down ` +
    `${(drop * 100).toFixed(1)}% from build ${previous.build_version}.`
  );
  process.exit(1); // non-zero exit = fail the CI check
}

console.log("\nNo regression detected.");
process.exit(0);
