-- Session replay for SaaS Analytics.
--
-- A browser SDK (rrweb) records a full DOM snapshot + incremental mutations and
-- ships them in batches to the `ingest-session-replay` edge function. Events are
-- stored raw (jsonb) so the rrweb player can replay them verbatim. Session-level
-- aggregates (duration, rage clicks, error count) are maintained on each batch so
-- the list view never has to scan the event table.

create table if not exists session_replay_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,

  -- Client-generated stable id for the recording session (one per tab/visit).
  -- Lets the SDK send many batches that all land on the same row.
  client_session_id text not null,

  -- Who / what (best-effort, all optional — the SDK may be anonymous).
  customer_external_id text,
  user_email text,
  device text,                         -- 'desktop' | 'mobile' | 'tablet'
  browser text,
  os text,
  country text,
  entry_url text,
  user_agent text,

  -- Aggregates kept up to date on every batch.
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  duration_ms bigint not null default 0,
  event_count int not null default 0,
  page_count int not null default 1,
  rage_click_count int not null default 0,
  error_count int not null default 0,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  unique (project_id, client_session_id)
);

create index if not exists session_replay_sessions_project_started_idx
  on session_replay_sessions(project_id, started_at desc);

-- Raw rrweb events, batched. `chunk` is a monotonically increasing index per
-- session so the player can stitch batches back in order. `events` is the rrweb
-- eventWithTime[] array exactly as emitted by the recorder.
create table if not exists session_replay_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references session_replay_sessions(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  chunk int not null default 0,
  events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (session_id, chunk)
);

create index if not exists session_replay_events_session_chunk_idx
  on session_replay_events(session_id, chunk);

alter table session_replay_sessions enable row level security;
alter table session_replay_events enable row level security;

create policy "members read session_replay_sessions"
  on session_replay_sessions for select
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = session_replay_sessions.workspace_id
        and wm.user_id = auth.uid()
    )
  );

create policy "service role writes session_replay_sessions"
  on session_replay_sessions for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Events are read through the service-role edge function (get-session-replay),
-- but we also allow members to read directly for flexibility.
create policy "members read session_replay_events"
  on session_replay_events for select
  using (
    exists (
      select 1
      from session_replay_sessions s
      join workspace_members wm on wm.workspace_id = s.workspace_id
      where s.id = session_replay_events.session_id
        and wm.user_id = auth.uid()
    )
  );

create policy "service role writes session_replay_events"
  on session_replay_events for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
