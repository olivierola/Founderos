-- Creating a workspace from the client needs two inserts (workspaces, then
-- workspace_members) but workspace_members has no INSERT policy for regular
-- users — the only path that ever wrote to it was the security-definer
-- on_auth_user_created trigger. Give authenticated users a matching
-- security-definer RPC so "New organisation" works outside that trigger.

create or replace function public.create_workspace_with_owner(p_name text, p_slug text)
returns public.workspaces
language plpgsql
security definer
set search_path = public
as $$
declare
  ws public.workspaces;
begin
  insert into public.workspaces (name, slug, owner_id)
  values (p_name, p_slug, auth.uid())
  returning * into ws;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (ws.id, auth.uid(), 'owner');

  return ws;
end;
$$;

grant execute on function public.create_workspace_with_owner(text, text) to authenticated;
