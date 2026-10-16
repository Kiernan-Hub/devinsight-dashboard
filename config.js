// Where the dashboard reads telemetry from.
//
// The anon key is public by design: it ships in this page's JavaScript and is read-only in
// Postgres (see supabase/schema.sql, "Row-level security"). The key that can write never appears
// in client code.
//
// The local Docker stack serves a different file at this same path (docker/gateway/
// config.local.js), which is how one index.html works against both Supabase and a local
// database without any environment detection in the page itself.

export const ENVIRONMENT = "production";
export const SUPABASE_URL = "https://savgtraqvbqkbblhhhxe.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhdmd0cmFxdmJxa2JibGhoaHhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4OTE5MjAsImV4cCI6MjEwMTQ2NzkyMH0.t6mC5d1a1P82j_NXGV_nLvrp5g4V3vfFuos37mrnq0w";
