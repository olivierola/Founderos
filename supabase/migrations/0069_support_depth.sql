-- Support depth: omnichannel inbox, SLA policies + routing, AI resolution wired
-- to the RAG Center, public help-center/portal, and a Twilio+Deepgram voice call
-- center. Builds on 0053/0054/0067 support_* tables.

-- ── Tickets: omnichannel + AI resolution + voice + requester identity ─────────
alter table public.support_tickets
  add column if not exists channel_id uuid,                 -- → support_channels (loose)
  add column if not exists requester_name text,
  add column if not exists requester_phone text,
  add column if not exists external_ref text,               -- provider thread/message id
  add column if not exists sla_policy_id uuid,              -- → support_sla_policies
  add column if not exists sla_breached boolean not null default false,
  add column if not exists assigned_team text,              -- routing target (team/queue)
  add column if not exists ai_handled boolean not null default false,
  add column if not exists reopened_count int not null default 0;

-- Allow new channels (voice, social, sms) on the existing constraint.
do $$
begin
  alter table public.support_tickets drop constraint if exists support_tickets_channel_check;
  alter table public.support_tickets add constraint support_tickets_channel_check
    check (channel in ('email','chat','phone','voice','web','api','sms','social'));
exception when others then null;
end $$;

-- Messages: voice transcript turns + attachments.
alter table public.support_messages
  add column if not exists kind text not null default 'text'
    check (kind in ('text','voice','system')),
  add column if not exists attachments jsonb not null default '[]'::jsonb;

-- ── Channels (omnichannel sources) ────────────────────────────────────────────
create table if not exists public.support_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null check (kind in ('email','chat','web','voice','sms','social','api')),
  name text not null,
  address text,                                  -- inbox email / phone number / widget key
  config jsonb not null default '{}'::jsonb,      -- provider creds-ref, routing defaults
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_support_channels_project on public.support_channels(project_id);

-- ── SLA policies ──────────────────────────────────────────────────────────────
create table if not exists public.support_sla_policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  -- First-response + resolution targets (minutes) per priority.
  targets jsonb not null default
    '{"low":{"frt":480,"res":2880},"normal":{"frt":240,"res":1440},"high":{"frt":60,"res":480},"urgent":{"frt":15,"res":240}}'::jsonb,
  business_hours jsonb not null default '{}'::jsonb,   -- {tz, days, start, end} — empty = 24/7
  is_default boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_support_sla_project on public.support_sla_policies(project_id);

-- ── Routing rules (priority-ordered) ──────────────────────────────────────────
create table if not exists public.support_routing_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  position int not null default 0,
  -- Match: channel/priority/keyword conditions.
  conditions jsonb not null default '{}'::jsonb,        -- {channel?, priority?, keywords?:[]}
  -- Then: assign to team / agent / SLA, set priority, auto AI-resolve.
  actions jsonb not null default '{}'::jsonb,           -- {team?, assignee_id?, priority?, sla_policy_id?, ai_resolve?}
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_support_routing_project on public.support_routing_rules(project_id, position);

-- ── Voice calls (Twilio Media Streams + Deepgram STT/TTS) ─────────────────────
create table if not exists public.support_voice_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  ticket_id uuid references public.support_tickets(id) on delete set null,
  channel_id uuid references public.support_channels(id) on delete set null,
  direction text not null default 'inbound' check (direction in ('inbound','outbound')),
  from_number text,
  to_number text,
  provider_call_sid text,                       -- Twilio CallSid
  status text not null default 'ringing'
    check (status in ('ringing','in_progress','ai_handling','escalated','completed','failed','no_answer')),
  transcript jsonb not null default '[]'::jsonb, -- [{role:'caller'|'agent', text, ts}]
  recording_url text,
  summary text,
  resolution text check (resolution in ('ai_resolved','escalated','voicemail','dropped') or resolution is null),
  duration_sec int,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists idx_support_voice_project on public.support_voice_calls(project_id, started_at desc);
create index if not exists idx_support_voice_sid on public.support_voice_calls(provider_call_sid);

-- ── Public help center / portal ───────────────────────────────────────────────
-- A per-project portal config with a public token (anon read of published
-- articles + ticket submission), mirroring the rag-widget public pattern.
create table if not exists public.support_portals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  public_key text unique not null default replace(gen_random_uuid()::text, '-', ''),
  title text not null default 'Help Center',
  brand_color text default '#e0457b',
  welcome text,
  ai_enabled boolean not null default true,      -- answer from KB before opening a ticket
  rag_collection_id uuid,                         -- → rag_collections (knowledge to answer from)
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_support_portals_project on public.support_portals(project_id);

-- Articles: publish for the portal + slug + helpful votes + AI-indexable.
alter table public.support_articles
  add column if not exists slug text,
  add column if not exists helpful_yes int not null default 0,
  add column if not exists helpful_no int not null default 0,
  add column if not exists rag_collection_id uuid;   -- mirror into a RAG collection for the resolver

-- ── RLS: workspace members manage; voice/portal also readable by service role ──
do $$
declare t text;
begin
  foreach t in array array[
    'support_channels','support_sla_policies','support_routing_rules',
    'support_voice_calls','support_portals'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($f$
      create policy "Members manage %1$s"
      on public.%1$s for all
      using (exists (select 1 from public.workspace_members wm
                     where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()))
      with check (exists (select 1 from public.workspace_members wm
                          where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()))
    $f$, t);
  end loop;
end $$;

-- Realtime for the live inbox queue + voice call status.
do $$
begin
  alter publication supabase_realtime add table public.support_tickets;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table public.support_voice_calls;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table public.support_messages;
exception when duplicate_object then null; end $$;
