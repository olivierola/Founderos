-- 0237_issue_agent_work.sql
-- Ce qu'un agent doit faire sur un work item, et le droit de s'y mettre seul.
--
-- Jusqu'ici, confier un work item à un agent demandait un geste humain à chaque
-- fois : ouvrir la fiche, écrire un brief, lancer. L'agent ne « travaillait »
-- que si quelqu'un le poussait. C'est la différence entre un exécutant qu'on
-- appelle et un collègue à qui l'on confie un sujet.
--
-- Trois colonnes suffisent à combler l'écart.
--
--   · agent_brief — LE TRAVAIL À FAIRE, dit à la machine.
--   · agent_autorun — le droit de démarrer seul.
--   · agent_last_run_at — la trace qui empêche de recommencer en boucle.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Le travail à faire
-- ────────────────────────────────────────────────────────────────────────────
-- Un champ SÉPARÉ de la description, et c'est tout l'intérêt.
--
-- La description s'adresse à l'équipe : elle dit le contexte, l'historique, ce
-- qui a été tenté. Le brief s'adresse à la MACHINE : il dit ce qu'il y a à
-- produire et à quoi on reconnaîtra que c'est fait. Les confondre obligerait à
-- écrire une description en langage d'instructions — illisible pour les
-- humains — ou à laisser l'agent deviner sa tâche dans un texte qui ne lui est
-- pas destiné, ce qui est exactement la façon dont un agent part de travers.
alter table public.pj_issues
  add column if not exists agent_brief text;

comment on column public.pj_issues.agent_brief is
  'Le travail à faire, adressé à l''agent. Distinct de la description, qui s''adresse à l''équipe : l''un dit le contexte, l''autre la commande.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Le droit de démarrer seul
-- ────────────────────────────────────────────────────────────────────────────
-- Faux par défaut, et ce n'est pas une timidité de conception : un agent qui
-- démarre sans qu'on l'ait voulu consomme un budget, écrit dans un projet et
-- produit des livrables. Le défaut doit être l'inaction, et l'autonomie une
-- décision prise item par item, en connaissance du brief qu'on vient d'écrire.
alter table public.pj_issues
  add column if not exists agent_autorun boolean not null default false;

comment on column public.pj_issues.agent_autorun is
  'Autorise les agents assignés à se mettre au travail sans qu''on les lance. Faux par défaut : l''autonomie se donne item par item.';

-- La trace du dernier démarrage automatique. Sans elle, chaque tour de
-- l'ordonnanceur relancerait le même item : un agent qui travaille n'a pas
-- encore terminé, donc l'item reste « à faire », donc on le relance — et l'on
-- se retrouve avec quinze exécutions concurrentes sur la même tâche.
alter table public.pj_issues
  add column if not exists agent_last_run_at timestamptz;

-- L'index sert l'unique requête de l'ordonnanceur : les items ouverts, armés,
-- non archivés. Partiel, parce que la quasi-totalité des lignes ont
-- `agent_autorun` à faux et n'ont rien à faire dans cet index.
create index if not exists idx_pj_issues_autorun
  on public.pj_issues (agent_last_run_at)
  where agent_autorun and completed_at is null and archived_at is null;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. La file de travail autonome
-- ────────────────────────────────────────────────────────────────────────────
-- Ce que l'ordonnanceur doit lancer, et rien d'autre. La fonction porte toutes
-- les conditions au même endroit, plutôt que de les éparpiller dans le worker :
-- une règle d'éligibilité écrite à deux endroits finit toujours par diverger, et
-- le désaccord se paie ici en exécutions fantômes.
--
-- Les conditions, dans l'ordre où elles écartent le plus de lignes :
--
--   1. l'item est ARMÉ (agent_autorun), ouvert et non archivé ;
--   2. il porte un BRIEF — sans quoi l'agent n'aurait que le titre, et un titre
--      n'est pas une commande ;
--   3. sa date de début est passée, s'il en a une : un item planifié pour la
--      semaine prochaine ne se travaille pas aujourd'hui ;
--   4. un agent lui est ASSIGNÉ, et cet agent est autorisé EN ÉCRITURE sur le
--      projet (pj_project_agents, 0232) — l'assignation dit qui s'en occupe, le
--      périmètre dit qui en a le droit, et il faut les deux ;
--   5. l'agent n'est pas archivé et accepte les missions ;
--   6. rien ne tourne déjà pour cet item — ni run en file, ni run en cours ;
--   7. on a laissé passer un délai depuis le dernier démarrage, pour qu'un
--      échec immédiat ne se rejoue pas en boucle.
create or replace function public.pj_agent_autorun_queue(
  p_cooldown interval default interval '30 minutes',
  p_limit int default 5
)
returns table (
  issue_id      uuid,
  agent_id      uuid,
  pj_project_id uuid,
  workspace_id  uuid,
  project_id    uuid,
  issue_name    text,
  issue_ref     text,
  brief         text,
  description   text
) language sql stable as $$
  select distinct on (i.id)
         i.id, ia.agent_id, i.pj_project_id, i.workspace_id, p.project_id,
         i.name, p.identifier || '-' || i.sequence_id,
         i.agent_brief, i.description_text
  from public.pj_issues i
  join public.pj_projects p on p.id = i.pj_project_id
  join public.pj_issue_agents ia on ia.issue_id = i.id
  join public.pj_project_agents pa
    on pa.pj_project_id = i.pj_project_id
   and pa.agent_id = ia.agent_id
   and pa.role <> 'observer'
  join public.internal_agents a
    on a.id = ia.agent_id
   and a.is_archived = false
   and a.mission_enabled = true
  where i.agent_autorun
    and i.completed_at is null
    and i.archived_at is null
    and coalesce(nullif(btrim(i.agent_brief), ''), null) is not null
    and (i.start_date is null or i.start_date <= current_date)
    and (i.agent_last_run_at is null or i.agent_last_run_at < now() - p_cooldown)
    and not exists (
      select 1
      from public.internal_agent_missions m
      join public.internal_agent_runs r on r.mission_id = m.id
      where m.pj_issue_id = i.id and r.status in ('queued', 'running')
    )
  -- Un item peut porter plusieurs agents ; on n'en lance qu'UN par tour. Deux
  -- machines sur la même tâche produisent deux livrables concurrents et se
  -- marchent dessus dans le suivi.
  order by i.id, ia.created_at asc
  limit p_limit;
$$;

comment on function public.pj_agent_autorun_queue is
  'Les work items qu''un agent assigné peut prendre en charge seul : armés, briefés, échus, avec un agent autorisé en écriture et rien qui tourne déjà.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4. L'état bouge quand la machine s'y met
-- ────────────────────────────────────────────────────────────────────────────
-- Passer l'item « en cours » au démarrage n'est pas cosmétique : sur un board,
-- un item qu'une machine travaille et un item que personne n'a ouvert doivent
-- se distinguer. Sans ce déplacement, on relance à la main une tâche déjà en
-- train d'être faite.
--
-- On ne descend jamais un état : si quelqu'un a déjà mis l'item plus loin, on
-- le laisse. La fonction ne fait donc quelque chose que depuis backlog ou
-- « à faire ».
create or replace function public.pj_issue_mark_started(p_issue uuid, p_agent uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_state   uuid;
begin
  select pj_project_id into v_project from public.pj_issues where id = p_issue;
  if v_project is null then return; end if;

  select s.id into v_state
  from public.pj_states s
  where s.pj_project_id = v_project and s."group" = 'started'
  order by s.sequence asc
  limit 1;

  if v_state is null then return; end if;

  update public.pj_issues i
     set state_id = v_state,
         updated_at = now()
   where i.id = p_issue
     and exists (
       select 1 from public.pj_states cur
       where cur.id = i.state_id and cur."group" in ('backlog', 'unstarted')
     );

  -- La trace, dans le journal de l'item : c'est là qu'on cherche « pourquoi
  -- est-ce passé en cours ? », et « le système » n'y répondrait pas.
  insert into public.pj_issue_activity
    (issue_id, pj_project_id, workspace_id, agent_id, verb, field, new_value)
  select p_issue, i.pj_project_id, i.workspace_id, p_agent, 'updated', 'state',
         'En cours (démarré par l''agent)'
  from public.pj_issues i where i.id = p_issue;
exception when undefined_table or undefined_column then
  -- Le journal est un confort, pas une condition : s'il n'a pas cette forme,
  -- l'état a quand même bougé, et c'est le principal.
  null;
end $$;

comment on function public.pj_issue_mark_started is
  'Passe un work item en « en cours » quand un agent s''y met — jamais en arrière, et jamais depuis un état déjà avancé.';
