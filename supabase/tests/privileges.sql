-- Database security invariants. Raises an error, failing whatever ran it, if any is broken.
--
-- Runs in CI against the local Docker stack, which applies schema.sql on top of a replica of
-- Supabase's permissive default grants (docker/db/00-supabase-roles.sql) — so this checks what
-- the schema actually leaves in place, not what it was intended to.
--
--   docker compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/privileges.sql
--
-- It only reads the catalog, so it is also safe to paste into the Supabase SQL editor to audit
-- the production database directly.

do $$
declare
  problems text;
begin
  -- 1. Every table in `public` has row-level security switched on. On Supabase, a table without
  --    it is readable and writable by anyone holding the public anon key: the single most common
  --    way Supabase projects leak data.
  select string_agg(format('%I has row-level security disabled', c.relname), E'\n')
    into problems
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p')
    and not c.relrowsecurity;
  if problems is not null then
    raise exception E'RLS check failed:\n%', problems;
  end if;

  -- 2. The public anon key can read, and do nothing else, anywhere in `public`. Read straight
  --    from each object's access list, so it catches every privilege type the server version
  --    has (including ones newer than this file, such as Postgres 17's MAINTAIN).
  select string_agg(format('anon holds %s on %I', a.privilege_type, c.relname), E'\n' order by c.relname, a.privilege_type)
    into problems
  from pg_class c
  cross join lateral aclexplode(c.relacl) a
  where c.relnamespace = 'public'::regnamespace
    and a.grantee = 'anon'::regrole
    and a.privilege_type <> 'SELECT';
  if problems is not null then
    raise exception E'anon is not read-only:\n%', problems;
  end if;

  -- 3. Signed-in users get nothing: this project has no accounts, and on Supabase anyone can
  --    create one. to_regrole() keeps this check usable on a database without the role at all.
  if to_regrole('authenticated') is not null then
    select string_agg(format('authenticated holds %s on %I', a.privilege_type, c.relname), E'\n' order by c.relname, a.privilege_type)
      into problems
    from pg_class c
    cross join lateral aclexplode(c.relacl) a
    where c.relnamespace = 'public'::regnamespace
      and a.grantee = 'authenticated'::regrole;
    if problems is not null then
      raise exception E'authenticated holds privileges it should not:\n%', problems;
    end if;
  end if;

  -- 4. Neither public role can run this project's functions. Postgres grants EXECUTE on every new
  --    function to PUBLIC by default, so a write-path function like ingest_batch() is callable by
  --    anyone unless it is explicitly revoked. Functions owned by extensions are skipped: they are
  --    not this project's to lock down. has_function_privilege() counts grants via PUBLIC too.
  select string_agg(format('%s can execute %s', r.role, p.oid::regprocedure), E'\n' order by p.proname, r.role)
    into problems
  from pg_proc p
  cross join (values ('anon'), ('authenticated')) as r(role)
  where p.pronamespace = 'public'::regnamespace
    and to_regrole(r.role) is not null
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and has_function_privilege(r.role, p.oid, 'EXECUTE');
  if problems is not null then
    raise exception E'public roles can execute project functions:\n%', problems;
  end if;

  raise notice 'privileges: RLS on every table; anon read-only; authenticated holds nothing; no public function execution';
end $$;
