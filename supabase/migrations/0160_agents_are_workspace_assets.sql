-- 0160_agents_are_workspace_assets.sql
-- An invited teammate could join an organisation and see nothing in it.
--
-- Cause: the whole internal_agents family (agents + members/tools/missions/
-- runs/run_events/deliverables/conversations/messages) gates on
-- `has_internal_agent_access`, which passed only for the agent's CREATOR or
-- someone explicitly added to internal_agent_members (0025). Every other module
-- — service_dashboards (0133), service_rooms (0135), office_documents (0040),
-- repositories, CRM — is scoped to workspace membership, so a new member saw
-- those but not a single agent, which is most of the product.
--
-- Agents are workspace assets: anyone in the workspace reads and configures
-- them, the per-agent ACL stays available for finer grants, and deletion stays
-- with the creator or a workspace owner/admin.

create or replace function public.has_internal_agent_access(p_agent_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.internal_agents a
     where a.id = p_agent_id
       and (
         a.created_by = p_user_id
         or exists (
           select 1 from public.workspace_members wm
            where wm.workspace_id = a.workspace_id
              and wm.user_id = p_user_id
         )
       )
  ) or exists (
    select 1 from public.internal_agent_members m
     where m.agent_id = p_agent_id
       and m.user_id = p_user_id
  );
$$;

-- The two policies on internal_agents itself inlined the old rule instead of
-- calling the helper, so widening the helper alone would not have reached them.
drop policy if exists "Internal agents: read by creator or member" on public.internal_agents;
create policy "Internal agents: read by creator or member"
on public.internal_agents for select
using (public.has_internal_agent_access(id, auth.uid()));

drop policy if exists "Internal agents: creator or editor can update" on public.internal_agents;
create policy "Internal agents: creator or editor can update"
on public.internal_agents for update
using (public.has_internal_agent_access(id, auth.uid()))
with check (public.has_internal_agent_access(id, auth.uid()));

-- Deletion stays narrow: the creator, or someone who administers the workspace.
drop policy if exists "Internal agents: creator can delete" on public.internal_agents;
create policy "Internal agents: creator can delete"
on public.internal_agents for delete
using (
  created_by = auth.uid()
  or public.workspace_role(workspace_id) in ('owner', 'admin')
);
