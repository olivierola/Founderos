-- 0219 · Réparer la policy d'insertion des agents — encore.
--
-- Symptôme : « new row violates row-level security policy for table
-- internal_agents » à la création d'un agent, alors que le diagnostic côté app
-- vérifie et confirme deux choses avant de rendre la main :
--   - la session est valide (auth.getUser rend bien un utilisateur) ;
--   - `is_workspace_member(workspace_id)` rend TRUE, demandé à la base
--     elle-même par une fonction SECURITY DEFINER.
--
-- Or la policy installée par 0163 ne demande rien d'autre que ces deux
-- conditions, et les deux chemins de création du client posent `created_by`
-- depuis la session vivante. Si l'insertion est malgré tout refusée, c'est que
-- la policy réellement présente en base N'EST PAS celle de 0163 : soit elle a
-- été supprimée (aucune policy permissive en INSERT ⇒ Postgres rend ce même
-- message), soit une ancienne définition a été réinstallée par-dessus — le
-- fichier 0025 se ré-exécute sans erreur, et il ré-installe la version à
-- sous-requête qui, elle, peut rendre FALSE.
--
-- On ne cherche donc pas une condition manquante : on RÉTABLIT l'état connu
-- comme bon. Le fichier est écrit pour être rejouable sans conséquence.

-- Le prérequis de la policy : la fonction doit exister ET être appelable par
-- le rôle authenticated. Une policy qui appelle une fonction sans droit
-- d'exécution échoue exactement comme un refus d'accès.
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

grant execute on function public.is_workspace_member(uuid) to authenticated;

-- ── La policy, dans sa forme de 0163 ────────────────────────────────────────
-- `created_by = auth.uid()` : on n'attribue pas un agent à quelqu'un d'autre.
-- `is_workspace_member(...)` : la question de l'appartenance est posée à une
-- fonction SECURITY DEFINER, pas à une sous-requête — une sous-requête dans une
-- policy s'exécute SOUS la RLS de la table qu'elle lit, et rend FALSE dès que
-- l'appelant ne peut pas lire cette ligne-là.
drop policy if exists "Internal agents: workspace members can create" on public.internal_agents;
create policy "Internal agents: workspace members can create"
on public.internal_agents for insert
with check (
  created_by = auth.uid()
  and public.is_workspace_member(workspace_id)
);

-- Même exposition sur la table d'ACL de l'agent, écrite juste après lui.
drop policy if exists "Insert internal_agent_members via agent access" on public.internal_agent_members;
create policy "Insert internal_agent_members via agent access"
on public.internal_agent_members for insert
with check (public.has_internal_agent_access(agent_id, auth.uid()));

-- La RLS doit être active : si elle avait été coupée puis remise, les policies
-- auraient pu partir avec.
alter table public.internal_agents        enable row level security;
alter table public.internal_agent_members enable row level security;
