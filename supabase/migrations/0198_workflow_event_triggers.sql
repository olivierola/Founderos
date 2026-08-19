-- 0198_workflow_event_triggers.sql
-- Workflows that fire on what happens in a connected tool.
--
-- Until now a workflow could only start manually or on a clock. The interesting
-- ones start on an EVENT — a mail lands, a Slack message mentions the team, a
-- deal moves. Composio already emits those (its catalogue counts triggers per
-- toolkit); nothing in the product subscribed to them.
--
-- Three pieces:
--   1. agent_workflow_triggers — the subscription registry: which workflow
--      listens to which toolkit event, and the Composio trigger instance behind
--      it. One row per (workflow, event) so a workflow can listen to several,
--      and several workflows can listen to the same one.
--   2. workflow_event_deliveries — every event we received, with the provider's
--      own id. This is the DEDUPLICATION ledger: webhooks are at-least-once, so
--      without it a retried delivery starts the workflow twice.
--   3. A filter expression, evaluated before starting anything — "only mails
--      from @client.com", "only when the label is urgent". Firing a whole
--      workflow to discover the event was irrelevant is the expensive way to
--      answer that question.

create table if not exists public.agent_workflow_triggers (
  id                uuid primary key default gen_random_uuid(),
  workflow_id       uuid not null references public.agent_workflows(id) on delete cascade,
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  project_id        uuid not null references public.projects(id) on delete cascade,
  -- The connected app, as the connector layer names it ("gmail", "slack"…).
  provider          text not null,
  -- The provider's event slug ("GMAIL_NEW_GMAIL_MESSAGE", "SLACK_NEW_MESSAGE"…).
  event_slug        text not null,
  -- Whatever the provider needs to scope the subscription (a label, a channel).
  config            jsonb not null default '{}'::jsonb,
  -- Plain-language condition, evaluated on the payload before the workflow
  -- starts. Empty = every event fires it.
  filter            text,
  -- Composio's own trigger instance id, so we can pause/delete it upstream.
  external_id       text,
  status            text not null default 'pending'
                    check (status in ('pending','active','paused','error')),
  status_detail     text,
  last_event_at     timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workflow_id, provider, event_slug)
);
create index if not exists idx_wf_triggers_workflow on public.agent_workflow_triggers(workflow_id);
-- The lookup the callback does on every delivery.
create index if not exists idx_wf_triggers_route on public.agent_workflow_triggers(provider, event_slug)
  where status = 'active';
create index if not exists idx_wf_triggers_external on public.agent_workflow_triggers(external_id);

-- ── Delivery ledger — the deduplication key ─────────────────────────────────
-- `external_event_id` is the provider's id for the event. The UNIQUE index is
-- the whole mechanism: a duplicate delivery loses the insert race and is
-- dropped, rather than starting a second run of the same workflow.
create table if not exists public.workflow_event_deliveries (
  id                uuid primary key default gen_random_uuid(),
  trigger_id        uuid not null references public.agent_workflow_triggers(id) on delete cascade,
  workflow_id       uuid not null references public.agent_workflows(id) on delete cascade,
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  external_event_id text not null,
  payload           jsonb not null default '{}'::jsonb,
  -- 'started' → a run was created; 'filtered' → the condition said no;
  -- 'skipped' → the workflow was inactive; 'failed' → we could not start it.
  outcome           text not null default 'started'
                    check (outcome in ('started','filtered','skipped','failed')),
  detail            text,
  run_id            uuid references public.agent_workflow_runs(id) on delete set null,
  received_at       timestamptz not null default now()
);
create unique index if not exists uq_wf_delivery_event
  on public.workflow_event_deliveries(trigger_id, external_event_id);
create index if not exists idx_wf_deliveries_workflow
  on public.workflow_event_deliveries(workflow_id, received_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.agent_workflow_triggers    enable row level security;
alter table public.workflow_event_deliveries  enable row level security;

drop policy if exists "members manage workflow triggers" on public.agent_workflow_triggers;
create policy "members manage workflow triggers" on public.agent_workflow_triggers for all
  using  (exists (select 1 from public.workspace_members wm where wm.workspace_id = agent_workflow_triggers.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = agent_workflow_triggers.workspace_id and wm.user_id = auth.uid()));

-- Deliveries are a machine-written audit trail: members READ them, only the
-- service role writes.
drop policy if exists "members read workflow deliveries" on public.workflow_event_deliveries;
create policy "members read workflow deliveries" on public.workflow_event_deliveries for select
  using (exists (select 1 from public.workspace_members wm where wm.workspace_id = workflow_event_deliveries.workspace_id and wm.user_id = auth.uid()));
