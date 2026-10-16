// Dashboard data source for the local Docker stack. Served at /config.js by the gateway in
// place of the repository's config.js (see docker/gateway/nginx.conf).
//
// The gateway serves the REST API from the dashboard's own origin, so the URL is wherever this
// page was loaded from. There is no key: a request with no Authorization header is run by
// PostgREST as the `anon` role, which is exactly what the public anon key grants in production.

export const ENVIRONMENT = "local (Docker)";
export const SUPABASE_URL = location.origin;
export const SUPABASE_ANON_KEY = null;
