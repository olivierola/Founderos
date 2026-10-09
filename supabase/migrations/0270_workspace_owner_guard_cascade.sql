-- 0270_workspace_owner_guard_cascade.sql
-- La garde « un espace garde toujours un owner » (0159) bloquait aussi la
-- SUPPRESSION de l'espace : la cascade workspaces → workspace_members retire le
-- dernier owner, la garde lève « A workspace must keep at least one owner », et
-- toute la suppression est annulée. delete-workspace échouait pour tout le monde.
--
-- La garde protège un espace qui CONTINUE d'exister. Quand la ligne de l'espace
-- a déjà disparu (on est dans sa cascade), il n'y a plus rien à protéger.
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
  if tg_op = 'DELETE' and not exists (select 1 from public.workspaces w where w.id = target_workspace) then
    return old;
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
