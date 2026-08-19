-- 0199_workflows_to_playbooks.sql
-- Brings agent_workflows (0196) from the FRONTIER-GRAPH design to the PLAYBOOK
-- design the product actually shipped.
--
-- Why a corrective migration rather than editing 0196: it was already applied
-- remotely, and Supabase tracks migrations by version number, not by content.
-- A rewritten 0196 is a file nobody will ever run again — the only honest way
-- to change an applied migration is a new one that states the delta.
--
-- What changed, and why:
--   • `graph` → `blocks`. The canvas no longer describes an execution graph
--     the backend walks node by node; it describes a PROCEDURE whose blocks
--     compile into a markdown playbook.
--   • `document` (new). That playbook — the thing the assistant actually reads
--     and executes, and which is editable by hand.
--   • runs: `node_states` out, `agent_run_id` / `agent_id` / `document` in. A
--     workflow run is now a POINTER to the agent run that executed it; keeping
--     per-node state here duplicated the agent's own timeline, and the two
--     copies disagreed within the first minute.

-- ── Workflows ────────────────────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_workflows' and column_name = 'graph'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_workflows' and column_name = 'blocks'
  ) then
    alter table public.agent_workflows rename column graph to blocks;
  end if;
end $$;

alter table public.agent_workflows
  add column if not exists blocks jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  add column if not exists document text not null default '';

-- ── Runs ─────────────────────────────────────────────────────────────────────
alter table public.agent_workflow_runs
  add column if not exists agent_run_id uuid references public.internal_agent_runs(id) on delete set null,
  add column if not exists agent_id uuid references public.internal_agents(id) on delete set null,
  add column if not exists document text;

-- Per-node state belonged to an engine that no longer exists.
alter table public.agent_workflow_runs drop column if exists node_states;

create index if not exists idx_agent_workflow_runs_agent
  on public.agent_workflow_runs(agent_run_id);

-- The status CHECK still accepts 'awaiting_approval' from the old design. It is
-- left in place deliberately: the new code never writes it, and narrowing a
-- constraint would fail on any row that already holds the value — a stricter
-- constraint is not worth breaking a deploy over.

-- ── Scheduler ────────────────────────────────────────────────────────────────
-- 0197 shipped with a second pass that woke runs parked on a `delay` node. A
-- playbook does not park: the assistant that received it owns it start to
-- finish, and the agent tick engine already keeps that run alive. The old body
-- also read node_states, which the drop above just removed — so it must be
-- replaced, not merely simplified.
create or replace function public.tick_workflow_scheduler()
  returns int language plpgsql security definer set search_path = public, net, vault as
$$
declare
  svc text;
  r record;
  n int := 0;
begin
  select decrypted_secret into svc from vault.decrypted_secrets where name = 'agent_service_key' limit 1;
  if svc is null then return 0; end if;

  for r in
    select id from public.agent_workflows
    where status = 'active' and next_run_at is not null and next_run_at <= now()
    limit 20
  loop
    -- Clear the due date BEFORE firing: a slow edge call must not let the next
    -- minute launch the same workflow again. run-workflow re-arms it.
    update public.agent_workflows set next_run_at = null where id = r.id;
    perform net.http_post(
      url     := 'https://scugmxahflsjabglodyv.supabase.co/functions/v1/run-workflow',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||svc),
      body    := jsonb_build_object('workflow_id', r.id, 'trigger_payload', jsonb_build_object('trigger','schedule'))
    );
    n := n + 1;
  end loop;

  return n;
end $$;

revoke all on function public.tick_workflow_scheduler() from public;
grant execute on function public.tick_workflow_scheduler() to service_role;
