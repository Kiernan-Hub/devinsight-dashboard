-- Recreates the parts of a Supabase project that exist before any user SQL runs, so that
-- supabase/schema.sql applies to plain Postgres exactly as written.
--
-- Runs once, on first boot of an empty database volume, before 10-schema.sql (Postgres's image
-- runs /docker-entrypoint-initdb.d/ in filename order).
--
-- The rule for this file: replicate Supabase, do not improve on it. The point of the local stack
-- is that schema.sql behaves here the way it will in production. A shim that quietly granted
-- less than Supabase does would make the schema's own `revoke` statements look like they work
-- when, against the real defaults, they might not.

-- Supabase's API roles. PostgREST connects as `authenticator` (which can do nothing by itself)
-- and switches into whichever role the request's JWT names, or `anon` if there is none.
create role anon         nologin noinherit;
-- service_role bypasses row-level security entirely: that is what makes it the key with real
-- write power, and why it lives only in server-side environment variables.
create role service_role nologin noinherit bypassrls;
-- Signed-in end users. Nothing in this project uses Supabase Auth, but every Supabase project
-- has this role, and anyone can mint a token for it by signing up — so schema.sql strips its
-- privileges explicitly, and needs it to exist here to do so.
create role authenticated nologin noinherit;

-- The password only matters inside the Compose network: the database port is not published to
-- the host machine at all.
create role authenticator login noinherit password 'authenticator';
grant anon, authenticated, service_role to authenticator;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase's defaults, reproduced deliberately: every new table, view, sequence and function in
-- `public` grants ALL privileges to the API roles, and access is meant to be narrowed afterwards
-- by row-level security and explicit revokes. That permissive starting point is precisely what
-- schema.sql's `revoke ... from anon` exists to undo, so it has to be here for the revoke to be
-- tested at all.
alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
