-- 0159_org_invitations.sql
-- Organisation (workspace) invitations, end to end.
--
-- The moving parts already existed — `team_invitations` (0006) plus the
-- invite-member / accept-invite edge functions — but nothing could drive them
-- from the app:
--   * the only SELECT policy on workspace_members is `user_id = auth.uid()`,
--     so a client listing the roster only ever saw itself (which also made the
--     service dashboard's "invite your teammates" step impossible to complete);
--   * team_invitations had a read policy and no write policy, so a pending
--     invite could never be revoked from the UI;
--   * emails_for_users (0022) resolves people through PROJECT membership, so
--     org members who share no project came back nameless.
--
-- Policies on workspace_members cannot query workspace_members directly — that
-- recurses — so access goes through SECURITY DEFINER helpers.

-- ── Helpers ──────────────────────────────────────────────────────────────────
create or replace function public.is_workspace_member(p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members wm
     where wm.workspace_id = p_workspace
       and wm.user_id = auth.uid()
  );
$$;

create or replace function public.workspace_role(p_workspace uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select wm.role
    from public.workspace_members wm
   where wm.workspace_id = p_workspace
     and wm.user_id = auth.uid()
   limit 1;
$$;

grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.workspace_role(uuid) to authenticated;

-- ── The roster is visible to the whole workspace ─────────────────────────────
drop policy if exists "Members read the workspace roster" on public.workspace_members;
create policy "Members read the workspace roster"
on public.workspace_members for select
using (public.is_workspace_member(workspace_id));

-- Owners/admins change roles. The `with check` keeps a row inside its own
-- workspace (no moving a membership to another org).
drop policy if exists "Owners change member roles" on public.workspace_members;
create policy "Owners change member roles"
on public.workspace_members for update
using (public.workspace_role(workspace_id) in ('owner', 'admin'))
with check (public.workspace_role(workspace_id) in ('owner', 'admin'));

-- Owners/admins remove people; anyone may remove themselves (leave the org).
drop policy if exists "Owners remove members" on public.workspace_members;
create policy "Owners remove members"
on public.workspace_members for delete
using (public.workspace_role(workspace_id) in ('owner', 'admin') or user_id = auth.uid());

-- ── Invitations are managed by owners/admins ─────────────────────────────────
drop policy if exists "Owners manage team_invitations" on public.team_invitations;
create policy "Owners manage team_invitations"
on public.team_invitations for all
using (public.workspace_role(workspace_id) in ('owner', 'admin'))
with check (public.workspace_role(workspace_id) in ('owner', 'admin'));

create index if not exists idx_team_invitations_workspace
  on public.team_invitations(workspace_id, status, created_at desc);

-- ── Never leave an org without an owner ──────────────────────────────────────
-- A UI guard is not enough: demoting or removing the last owner would strand
-- the workspace with nobody able to invite, bill or delete it.
create or replace function public.assert_workspace_keeps_an_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_workspace uuid := coalesce(old.workspace_id, new.workspace_id);
  remaining int;
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;
  select count(*) into remaining
    from public.workspace_members wm
   where wm.workspace_id = target_workspace
     and wm.role = 'owner'
     and wm.id <> old.id;
  if remaining = 0 and (tg_op = 'DELETE' or new.role <> 'owner') then
    raise exception 'A workspace must keep at least one owner';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_workspace_keeps_an_owner on public.workspace_members;
create trigger trg_workspace_keeps_an_owner
before update or delete on public.workspace_members
for each row execute function public.assert_workspace_keeps_an_owner();

-- ── Emails for a workspace roster ────────────────────────────────────────────
-- The 0022 helper resolves people through shared PROJECT membership; org
-- members who share no project came back empty.
create or replace function public.emails_for_workspace(p_workspace uuid)
returns table (id uuid, email text)
language sql
stable
security definer
set search_path = public, auth
as $$
  select u.id, u.email
    from auth.users u
    join public.workspace_members wm on wm.user_id = u.id
   where wm.workspace_id = p_workspace
     and public.is_workspace_member(p_workspace);
$$;

grant execute on function public.emails_for_workspace(uuid) to authenticated;
