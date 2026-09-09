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
-- anon may insert (the game) and select (the dashboard). It may never update or delete —
-- omitting those policies denies them, because RLS denies anything not explicitly allowed.
-- ---------------------------------------------------------------------------

alter table public.system_logs enable row level security;

drop policy if exists "anon can insert telemetry" on public.system_logs;
create policy "anon can insert telemetry"
  on public.system_logs for insert to anon
  with check (true);

drop policy if exists "anon can read telemetry" on public.system_logs;
create policy "anon can read telemetry"
  on public.system_logs for select to anon
  using (true);

-- ---------------------------------------------------------------------------
-- Aggregate view — read by the dashboard and by scripts/check-regression.mjs
-- ---------------------------------------------------------------------------

create or replace view public.build_fps_summary as
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
