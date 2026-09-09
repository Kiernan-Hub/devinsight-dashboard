-- DevInsight — full Supabase/Postgres schema for the Ascent telemetry pipeline.
--
-- This file is the source of truth for the backend half of the project. Running it on a
-- fresh Supabase project reproduces the entire database: table, constraints, row-level
-- security policies, indexes, and the aggregate view the CI performance gate reads.
--
-- Apply with:  supabase db execute --file supabase/schema.sql
--        or:   paste into the Supabase dashboard SQL editor and run.
--
-- Safe to re-run: every statement is idempotent.

-- ---------------------------------------------------------------------------
-- Sessions
--
-- One row per play session. Before this existed every sample was an isolated point with no
-- notion of which run it belonged to, so no question of the form "what happened during THAT
-- session" could be asked at all.
--
-- The important column is the absence of one: a session with a last_seen_at but no ended_at
-- stopped reporting without saying goodbye — a crash, a force-quit, or a closed laptop. That
-- is inferred from missing data, never written by the client, which is exactly why a client
-- that dies mid-frame cannot lie about it.
-- ---------------------------------------------------------------------------

create table if not exists public.sessions (
  id            uuid primary key,
  build_version text        not null,
  platform      text,
  started_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  ended_at      timestamptz,
  ended_cleanly boolean
);

create index if not exists sessions_build_started_idx
  on public.sessions (build_version, started_at desc);

create index if not exists sessions_open_idx
  on public.sessions (last_seen_at desc) where ended_at is null;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.system_logs (
  id             bigint generated always as identity primary key,
  created_at     timestamptz  not null default now(),
  app_name       text         not null,
  build_version  text         not null,
  fps_rate       integer      not null,
  memory_used_mb numeric(10, 2) not null,
  session_notes  text,

  -- True per-frame timing, measured over every frame in the reporting interval
  -- rather than derived from a once-per-interval FPS reading. Nullable so rows
  -- written by pre-0.4.0 builds (which never measured these) remain valid.
  frame_time_p95_ms numeric(8, 3),
  frame_time_max_ms numeric(8, 3),
  frames_sampled    integer
);

-- Columns added after the table first shipped; `add column if not exists` makes this
-- file safe to run against an existing 0.3.0-era database as a migration.
alter table public.system_logs add column if not exists frame_time_p95_ms numeric(8, 3);
alter table public.system_logs add column if not exists frame_time_max_ms numeric(8, 3);
alter table public.system_logs add column if not exists frames_sampled    integer;

-- Links each sample to the play session it came from. Nullable because every row written
-- before sessions existed has no session to point at, and deleting history to add a column
-- would be a poor trade. on delete set null keeps orphaned samples rather than cascading a
-- session deletion into the measurements themselves.
alter table public.system_logs add column if not exists session_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'system_logs_session_fk') then
    alter table public.system_logs
      add constraint system_logs_session_fk
      foreign key (session_id) references public.sessions (id) on delete set null;
  end if;
end $$;

create index if not exists system_logs_session_idx
  on public.system_logs (session_id, created_at asc);

-- ---------------------------------------------------------------------------
-- Constraints
--
-- The anon key can insert (that is how the game reports), and the anon key is public
-- by necessity — it ships inside the game binary and the dashboard's JavaScript. These
-- constraints are therefore the only thing standing between a stranger with the key and
-- arbitrary garbage in the table that the CI gate would then treat as real measurements.
-- They cannot stop a determined attacker writing *plausible* rows; see README for why
-- the CI gate reads with the service-role key instead.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'system_logs_fps_sane') then
    alter table public.system_logs
      add constraint system_logs_fps_sane check (fps_rate >= 0 and fps_rate <= 1000);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'system_logs_memory_sane') then
    alter table public.system_logs
      add constraint system_logs_memory_sane check (memory_used_mb >= 0 and memory_used_mb <= 1048576);
  end if;

  -- Bounds the stored-XSS surface: build_version is rendered in the dashboard, so keep it
  -- to the shape a real version string actually has. The dashboard also escapes on render;
  -- this is the belt to that suspenders.
  if not exists (select 1 from pg_constraint where conname = 'system_logs_build_version_shape') then
    alter table public.system_logs
      add constraint system_logs_build_version_shape
      check (build_version ~ '^[A-Za-z0-9._+-]{1,40}$');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'system_logs_app_name_shape') then
    alter table public.system_logs
      add constraint system_logs_app_name_shape
      check (app_name ~ '^[A-Za-z0-9 ._-]{1,60}$');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'system_logs_notes_length') then
    alter table public.system_logs
      add constraint system_logs_notes_length check (session_notes is null or length(session_notes) <= 500);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'system_logs_frame_time_sane') then
    alter table public.system_logs
      add constraint system_logs_frame_time_sane check (
        (frame_time_p95_ms is null or (frame_time_p95_ms >= 0 and frame_time_p95_ms <= 60000)) and
        (frame_time_max_ms is null or (frame_time_max_ms >= 0 and frame_time_max_ms <= 60000)) and
        (frames_sampled    is null or (frames_sampled    >= 0 and frames_sampled    <= 1000000))
      );
  end if;

  -- Rows dated far in the future would permanently pin themselves to the top of every
  -- "most recent" query, including the dashboard's live view.
  if not exists (select 1 from pg_constraint where conname = 'system_logs_created_at_sane') then
    alter table public.system_logs
      add constraint system_logs_created_at_sane check (created_at <= now() + interval '1 day');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- The dashboard's hot query: a time window, optionally filtered to one build, newest first.
create index if not exists system_logs_created_at_desc_idx
  on public.system_logs (created_at desc);

create index if not exists system_logs_build_created_idx
  on public.system_logs (build_version, created_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- anon is now READ-ONLY. Writes arrive exclusively through /api/ingest, which authenticates
-- with the service-role key held in server-side environment variables.
--
-- This is the change that closes the original hole. The anon key is public by necessity — it
-- is in the dashboard's JavaScript — so for as long as it could insert, any stranger could
-- write rows into the table that the CI performance gate reads, and either fail builds at will
-- or mask a real regression. Constraints could bound how *absurd* those rows were; they could
-- never stop plausible ones. Taking the write grant away is what actually fixes it.
--
-- RLS denies anything not explicitly allowed, so dropping the insert policy is sufficient:
-- there is no update or delete policy either.
-- ---------------------------------------------------------------------------

alter table public.system_logs enable row level security;
alter table public.sessions    enable row level security;

-- Removes the grant that let anyone holding the public key write telemetry.
drop policy if exists "anon can insert telemetry" on public.system_logs;

drop policy if exists "anon can read telemetry" on public.system_logs;
create policy "anon can read telemetry"
  on public.system_logs for select to anon
  using (true);

drop policy if exists "anon can read sessions" on public.sessions;
create policy "anon can read sessions"
  on public.sessions for select to anon
  using (true);

revoke insert, update, delete on public.system_logs from anon;
revoke insert, update, delete on public.sessions    from anon;
grant select on public.system_logs to anon;
grant select on public.sessions    to anon;

-- ---------------------------------------------------------------------------
-- Aggregate view — read by the dashboard and by scripts/check-regression.mjs
--
-- Dropped and recreated rather than CREATE OR REPLACE: the very first version of this view
-- (created before this file existed) had columns in a different order, and Postgres refuses
-- to reorder or rename a view's existing columns in place ("cannot change name of view column").
-- Dropping first sidesteps that; nothing here holds data, so there is nothing to lose.
-- ---------------------------------------------------------------------------

drop view if exists public.build_fps_summary;
create view public.build_fps_summary as
select
  build_version,
  round(avg(fps_rate)::numeric, 2)                                              as avg_fps,
  count(*)                                                                      as sample_count,
  min(created_at)                                                               as first_seen,
  max(created_at)                                                               as last_seen,
  percentile_cont(0.01) within group (order by fps_rate)                        as fps_1pct_low,
  round(avg(frame_time_p95_ms)::numeric, 3)                                     as avg_frame_time_p95_ms,
  max(frame_time_max_ms)                                                        as worst_frame_time_ms,
  count(frame_time_p95_ms)                                                      as frame_timed_samples
from public.system_logs
group by build_version;

-- Views run with the privileges of their owner by default, which would bypass the RLS
-- policies above. security_invoker makes the view respect the caller's own permissions.
alter view public.build_fps_summary set (security_invoker = on);

grant select on public.build_fps_summary to anon;

-- Per-session rollup. `outcome` is the interesting column: a session that stopped reporting
-- without ever announcing an ending is one the player did not close normally. A crash rate per
-- build is a far sharper quality signal than an average frame rate, and it costs nothing extra
-- to collect — it falls out of data the client could not have faked on its way down.
--
-- Dropped and recreated for the same reason as build_fps_summary above: this view is new, but
-- being consistent here means a future column reorder won't hit the same wall.
drop view if exists public.session_summary;
create view public.session_summary as
select
  s.id,
  s.build_version,
  s.platform,
  s.started_at,
  s.last_seen_at,
  s.ended_at,
  s.ended_cleanly,
  -- Clamped at zero because the two ends of this subtraction come from different clocks:
  -- started_at is filled by Postgres's now() default, last_seen_at is stamped by the ingest
  -- function before the request reaches the database. A few hundred milliseconds of skew
  -- between them is normal and produced negative durations on short sessions.
  greatest(
    0::numeric,
    extract(epoch from (coalesce(s.ended_at, s.last_seen_at) - s.started_at))::numeric
  ) as duration_seconds,
  count(l.id)                                              as sample_count,
  round(avg(l.fps_rate)::numeric, 2)                       as avg_fps,
  min(l.fps_rate)                                          as min_fps,
  max(l.frame_time_max_ms)                                 as worst_frame_time_ms,
  max(l.memory_used_mb) - min(l.memory_used_mb)            as memory_growth_mb,
  case
    when s.ended_at is not null and s.ended_cleanly then 'clean'
    when s.ended_at is not null then 'ended_unclean'
    -- Still reporting, or only just stopped: not yet evidence of anything.
    when s.last_seen_at > now() - interval '2 minutes' then 'active'
    else 'abandoned'
  end                                                      as outcome
from public.sessions s
left join public.system_logs l on l.session_id = s.id
group by s.id;

alter view public.session_summary set (security_invoker = on);

grant select on public.session_summary to anon;
