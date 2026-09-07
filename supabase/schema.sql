-- DevInsight Dashboard — Supabase/Postgres schema.
--
-- This is the source of truth for the database side of the pipeline. Every
-- column here is written by godot/system_logger.gd and read by index.html or
-- scripts/check-regression.mjs, so changing a name or type in one place means
-- changing it in the others.
--
-- Apply with the Supabase SQL editor, or:
--   psql "$SUPABASE_DB_URL" -f supabase/schema.sql
--
-- The script is written to be re-runnable: running it twice is not an error and
-- will not drop existing telemetry.

-- ---------------------------------------------------------------------------
-- Table: system_logs
-- ---------------------------------------------------------------------------
-- One row per sample. The Godot client posts one every 5 seconds while the
-- game is running, and posts a backlog as a single array body after an outage.

create table if not exists public.system_logs (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),

  app_name       text        not null,
  -- Whole frames per second. Deliberately an integer: the client casts to int
  -- before sending, including after a round-trip through its on-disk retry
  -- queue, because Godot's JSON parser turns every number into a float.
  -- PostgREST feeds JSON values to this column as text, and text-to-integer
  -- parsing rejects "60.0" outright (error 22P02) -- unlike a SQL literal
  -- 60.0, which would be cast down silently. That asymmetry is why the bug
  -- only ever appeared on rows replayed from the client's queue.
  fps_rate       integer     not null,
  -- Megabytes, snapped to 2 decimal places by the client.
  memory_used_mb numeric(10, 2) not null,
  session_notes  text,
  -- Set from BUILD_VERSION in the Godot client. This is what the CI gate
  -- groups by, so a build that ships without bumping it is invisible to the
  -- regression check.
  build_version  text
);

-- The dashboard's main query is "rows newer than T, in time order", and it
-- optionally filters by build. These two indexes cover both shapes.
create index if not exists system_logs_created_at_idx
  on public.system_logs (created_at desc);

create index if not exists system_logs_build_version_created_at_idx
  on public.system_logs (build_version, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- The anon key is embedded in the shipped game client and in the dashboard, so
-- it is public by design. RLS is what actually limits it: the anon role may
-- add samples and read them back, and nothing else. There is deliberately no
-- update or delete policy, so a leaked key cannot rewrite or erase history.

alter table public.system_logs enable row level security;

drop policy if exists "anon can insert telemetry" on public.system_logs;
create policy "anon can insert telemetry"
  on public.system_logs for insert
  to anon
  with check (true);

drop policy if exists "anon can read telemetry" on public.system_logs;
create policy "anon can read telemetry"
  on public.system_logs for select
  to anon
  using (true);

-- ---------------------------------------------------------------------------
-- View: build_fps_summary
-- ---------------------------------------------------------------------------
-- One row per build. This is what the CI performance gate reads
-- (scripts/regression-core.mjs) and what the dashboard's build panel shows.
--
-- sample_count is not decoration: the gate refuses to judge a build with fewer
-- than 30 samples behind its average, because at one sample per 5 seconds that
-- is under 2.5 minutes of play and the average is noise.
--
-- security_invoker makes the view run with the querying role's permissions, so
-- the RLS policies above still apply through it rather than being bypassed by
-- the view owner's rights. It requires Postgres 15+; drop the WITH clause on
-- an older instance, but understand that the view then reads the table as its
-- owner.

drop view if exists public.build_fps_summary;
create view public.build_fps_summary
with (security_invoker = true)
as
select
  build_version,
  round(avg(fps_rate)::numeric, 2) as avg_fps,
  min(fps_rate)                    as min_fps,
  max(fps_rate)                    as max_fps,
  round(avg(memory_used_mb), 2)    as avg_memory_used_mb,
  count(*)                         as sample_count,
  min(created_at)                  as first_seen,
  max(created_at)                  as last_seen
from public.system_logs
where build_version is not null
group by build_version;

-- PostgREST reads the table and view through these roles; without this the
-- REST endpoints return a permission error even with the policies in place.
grant select, insert on public.system_logs to anon;
grant usage, select on sequence public.system_logs_id_seq to anon;
grant select on public.build_fps_summary to anon;
