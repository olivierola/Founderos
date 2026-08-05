-- 0163_fix_agent_insert_policy.sql
-- "new row violates row-level security policy for table internal_agents" when
-- creating an agent (from a template or blank).
--
-- The 0025 INSERT policy tests membership with an inline sub-select:
--
--   exists (select 1 from workspace_members wm
--            where wm.workspace_id = internal_agents.workspace_id
--              and wm.user_id = auth.uid())
--
-- A sub-select inside a policy runs UNDER the target table's own RLS, so this
-- check silently returns false whenever the caller cannot read that particular
-- workspace_members row — which is exactly the kind of thing that shifts as
-- membership policies evolve (0159 added roster/update/delete policies there).
--
-- Every other policy added since goes through `is_workspace_member`, a
-- SECURITY DEFINER helper that answers the membership question directly
-- instead of depending on what the caller may read. This aligns the INSERT
-- policy with the rest, and restores a known-good definition in case a stray
-- policy was edited outside the migration history.

drop policy if exists "Internal agents: workspace members can create" on public.internal_agents;
create policy "Internal agents: workspace members can create"
on public.internal_agents for insert
with check (
  created_by = auth.uid()
  and public.is_workspace_member(workspace_id)
);

-- Same inline sub-select, same exposure, on the agent's own ACL table.
drop policy if exists "Insert internal_agent_members via agent access" on public.internal_agent_members;
create policy "Insert internal_agent_members via agent access"
on public.internal_agent_members for insert
with check (public.has_internal_agent_access(agent_id, auth.uid()));
