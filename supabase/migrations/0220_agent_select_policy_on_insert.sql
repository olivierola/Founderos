-- 0220 · La vraie cause du « new row violates row-level security policy »
--        à la création d'un agent : la policy de LECTURE, pas celle d'écriture.
--
-- ┌─ POURQUOI 0163 PUIS 0219 N'ONT RIEN CHANGÉ ────────────────────────────┐
-- │ Les deux ont réparé la policy INSERT, qui n'était pas coupable. Le      │
-- │ client crée l'agent avec `.insert(...).select("id")`, ce que PostgREST  │
-- │ traduit en `INSERT ... RETURNING id`. Et pour un INSERT ... RETURNING,  │
-- │ PostgreSQL applique AUSSI les policies SELECT à la ligne proposée — en  │
-- │ WITH CHECK, donc avec le MÊME message d'erreur que l'écriture. Deux     │
-- │ vérifications distinctes, un seul message : c'est ce qui a envoyé les   │
-- │ deux migrations précédentes réparer la mauvaise moitié.                 │
-- └────────────────────────────────────────────────────────────────────────┘
--
-- Ce que la policy SELECT de 0160 demande :
--
--   using (public.has_internal_agent_access(id, auth.uid()))
--
-- et cette fonction VA CHERCHER LA LIGNE DANS LA TABLE :
--
--   select exists (select 1 from public.internal_agents a where a.id = p_agent_id and (…))
--
-- Or les WITH CHECK sont évalués sur le tuple proposé, AVANT son écriture dans
-- le tas. À cet instant la ligne n'existe nulle part : le `exists` rend false,
-- la policy refuse, et l'insertion échoue. Le refus est structurel — il ne
-- dépend ni de l'utilisateur, ni de son appartenance, ni de ses droits. Aucune
-- création d'agent depuis le client ne pouvait passer.
--
-- La correction ne change AUCUN droit : elle pose exactement la même question
-- (créateur, ou membre de l'espace de travail, ou inscrit à l'ACL de l'agent)
-- mais sur LES COLONNES DE LA LIGNE qu'on est en train de juger, au lieu
-- d'aller la relire dans une table où elle n'est pas encore.

-- La branche ACL, en SECURITY DEFINER — l'`exists` en clair s'exécuterait sous
-- la RLS de internal_agent_members et pourrait rendre false pour de mauvaises
-- raisons. C'est précisément le piège que documentait 0163.
create or replace function public.is_agent_acl_member(p_agent uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.internal_agent_members m
     where m.agent_id = p_agent and m.user_id = p_user
  );
$$;

grant execute on function public.is_agent_acl_member(uuid, uuid) to authenticated;

-- ── La lecture, jugée sur la ligne elle-même ────────────────────────────────
drop policy if exists "Internal agents: read by creator or member" on public.internal_agents;
create policy "Internal agents: read by creator or member"
on public.internal_agents for select
using (
  created_by = auth.uid()
  or public.is_workspace_member(workspace_id)
  or public.is_agent_acl_member(id, auth.uid())
);

-- ── La mise à jour, pour la même raison ─────────────────────────────────────
-- Le USING porte sur la ligne existante : le détour par la table y aboutissait.
-- Mais le WITH CHECK porte sur la ligne d'APRÈS, et une fonction `stable` lit
-- l'instantané d'avant la commande — elle validait donc l'ancienne version de
-- la ligne, pas la nouvelle. Un agent déplacé vers un autre espace de travail
-- serait passé sans que personne ne vérifie le nouveau. Même formulation des
-- deux côtés, et le trou se referme.
drop policy if exists "Internal agents: creator or editor can update" on public.internal_agents;
create policy "Internal agents: creator or editor can update"
on public.internal_agents for update
using (
  created_by = auth.uid()
  or public.is_workspace_member(workspace_id)
  or public.is_agent_acl_member(id, auth.uid())
)
with check (
  created_by = auth.uid()
  or public.is_workspace_member(workspace_id)
  or public.is_agent_acl_member(id, auth.uid())
);

-- `has_internal_agent_access` reste en place, inchangée : elle est juste pour
-- toutes les tables ENFANTS (outils, missions, runs, livrables, conversations),
-- où la ligne d'agent qu'elle relit existe bel et bien. Le défaut n'était pas
-- dans la fonction, il était dans l'endroit où on l'appelait.

comment on function public.is_agent_acl_member(uuid, uuid) is
  'Branche ACL de has_internal_agent_access, isolée pour être appelable depuis une policy qui juge une ligne PROPOSÉE (INSERT ... RETURNING) et ne peut donc pas relire la table.';
