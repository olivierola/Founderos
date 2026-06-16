-- Support module v2: SLA, CSAT satisfaction, canned responses (macros),
-- richer ticket metadata. Builds on 0053's support_* tables.

-- ---- Tickets: SLA + CSAT + category --------------------------------------

alter table public.support_tickets
  add column if not exists category text,
  add column if not exists channel text default 'email'
    check (channel in ('email','chat','phone','web','api')),
  -- SLA deadlines (computed on create from priority).
  add column if not exists first_response_due timestamptz,
  add column if not exists resolution_due timestamptz,
  -- Customer satisfaction collected after solving.
  add column if not exists csat int check (csat between 1 and 5),
  add column if not exists csat_comment text,
  -- Denormalised last-activity timestamp for queue sorting.
  add column if not exists last_activity_at timestamptz default now();

create index if not exists idx_support_tickets_assignee
  on public.support_tickets(assignee_id) where assignee_id is not null;
create index if not exists idx_support_tickets_sla
  on public.support_tickets(first_response_due)
  where status in ('open','pending');

-- ---- Messages: internal notes + AI provenance ----------------------------

alter table public.support_messages
  -- Internal notes are visible to agents only, not the customer.
  add column if not exists is_internal boolean not null default false,
  -- Mark replies drafted/sent with AI assistance.
  add column if not exists via_ai boolean not null default false;

-- ---- Canned responses (macros) -------------------------------------------

create table if not exists public.support_macros (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  title text not null,
  body text not null,
  category text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

alter table public.support_macros enable row level security;
do $$
declare t text := 'support_macros';
begin
  execute format('drop policy if exists "Members read %1$s" on public.%1$s;', t);
  execute format($f$create policy "Members read %1$s" on public.%1$s for select
    using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
  execute format('drop policy if exists "Members write %1$s" on public.%1$s;', t);
  execute format($f$create policy "Members write %1$s" on public.%1$s for insert
    with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
  execute format('drop policy if exists "Members update %1$s" on public.%1$s;', t);
  execute format($f$create policy "Members update %1$s" on public.%1$s for update
    using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
  execute format('drop policy if exists "Members delete %1$s" on public.%1$s;', t);
  execute format($f$create policy "Members delete %1$s" on public.%1$s for delete
    using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
end $$;

create index if not exists idx_support_macros_project on public.support_macros(project_id);
