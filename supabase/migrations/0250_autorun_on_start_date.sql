-- 0250_autorun_on_start_date.sql
-- Un agent assigné se met au travail quand la DATE DE DÉBUT de l'item arrive.
--
-- Jusqu'ici la file autonome (0242 → 0245) ne prenait que les items dont
-- l'interrupteur « Travail autonome » était activé. Or planifier un item — lui
-- poser une date de début — et le confier à un agent disait déjà tout : « fais
-- ceci à partir de ce jour-là ». Exiger en plus un interrupteur, c'était demander
-- deux fois la même chose, et laisser dormir des items que personne n'avait pensé
-- à armer.
--
-- La fonction est reprise telle quelle depuis 0245 ; seules les conditions de
-- déclenchement changent. Tous les garde-fous restent : dépendances ouvertes,
-- run déjà en cours, disjoncteur, agent autorisé en écriture sur le projet.

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
  -- L'état COURANT de l'item. Jointure à gauche : un item sans état (rare, mais
  -- la colonne est nullable) reste éligible plutôt que de disparaître en silence.
  left join public.pj_states st on st.id = i.state_id
  where i.completed_at is null
    and i.archived_at is null
    -- (1) Terminé OU annulé : dans les deux cas, il n'y a plus rien à faire.
    and coalesce(st."group", 'backlog') not in ('completed', 'cancelled')
    and (i.start_date is null or i.start_date <= current_date)
    and (
      -- (A) ARMÉ — « Travail autonome » est activé. L'agent s'y met dès que
      -- possible, et se relance après un échec, dans la limite du disjoncteur.
      -- Le brief est exigé : c'est une commande donnée explicitement.
      (
        i.agent_autorun
        and nullif(btrim(i.agent_brief), '') is not null
        and (i.agent_last_run_at is null or i.agent_last_run_at < now() - p_cooldown)
      )
      or
      -- (B) PLANIFIÉ — la date de début est arrivée. Poser une date de début
      -- sur un item confié à un agent, c'est dire « commence ce jour-là » ; il
      -- n'y a pas à le redire par un interrupteur.
      --
      -- Trois bornes, chacune contre un défaut précis :
      --   · UNE fois par date de début : lancé depuis la date, il ne repart pas.
      --     Un échec ne se rejoue donc pas en boucle — c'est le rôle de (A) ;
      --   · une date RÉCENTE (trois jours au plus, le temps de rattraper une
      --     panne ou un week-end). Sans elle, ce déclencheur aurait lancé d'un
      --     coup tous les items dont la date est passée depuis des mois — autant
      --     d'exécutions payantes que personne n'a demandées ;
      --   · quelque chose à faire : le travail à faire, ou à défaut la
      --     description. Un titre seul n'est pas une commande.
      (
        i.start_date is not null
        and i.start_date >= current_date - 3
        and (i.agent_last_run_at is null or i.agent_last_run_at < i.start_date::timestamptz)
        and (
          nullif(btrim(i.agent_brief), '') is not null
          or nullif(btrim(i.description_text), '') is not null
        )
      )
    )
    and not exists (
      select 1
      from public.internal_agent_missions m
      join public.internal_agent_runs r on r.mission_id = m.id
      where m.pj_issue_id = i.id and r.status in ('queued', 'running')
    )
    -- (3) Aucune dépendance ouverte. Un item « bloqué par » un autre qui n'est
    -- ni terminé ni annulé attend : le travailler maintenant, c'est produire
    -- quelque chose sur des fondations qui n'existent pas encore.
    --
    -- Les DEUX sens sont vérifiés. L'interface écrit la relation et son miroir,
    -- mais une relation posée par un autre chemin (l'outil d'un agent, un
    -- import) peut n'en porter qu'un — et c'est justement celui qu'on n'aurait
    -- pas regardé.
    --
    -- Un bloqueur ARCHIVÉ ne bloque plus : il est sorti du jeu, et le laisser
    -- retenir l'item le figerait pour toujours sans que personne ne sache
    -- pourquoi.
    and not exists (
      select 1
      from public.pj_issue_relations rel
      join public.pj_issues blocker
        on blocker.id = case
             when rel.issue_id = i.id then rel.related_id
             else rel.issue_id
           end
      left join public.pj_states bst on bst.id = blocker.state_id
      where (
              (rel.issue_id = i.id and rel.relation_type = 'blocked_by')
           or (rel.related_id = i.id and rel.relation_type = 'blocks')
            )
        and blocker.archived_at is null
        and coalesce(bst."group", 'backlog') not in ('completed', 'cancelled')
    )
    -- (2) Le disjoncteur : les trois DERNIERS runs terminés de cet item ont tous
    -- échoué. « Terminés » seulement — un run annulé à la main n'est pas un
    -- échec de l'agent, et le compter ferait sauter le disjoncteur pour une
    -- décision humaine.
    and not (
      select count(*) = 3 and bool_and(last3.status = 'failed')
      from (
        select r.status
        from public.internal_agent_missions m
        join public.internal_agent_runs r on r.mission_id = m.id
        where m.pj_issue_id = i.id
          and r.status in ('succeeded', 'failed')
        order by r.created_at desc
        limit 3
      ) last3
    )
  order by i.id, ia.created_at asc
  limit p_limit;
$$;

comment on function public.pj_agent_autorun_queue is
  'Les work items qu''un agent assigné prend en charge seul : armés (Travail autonome) ou planifiés (date de début arrivée, une fois par date, trois jours de rattrapage au plus), sans dépendance ouverte, avec un agent autorisé en écriture, rien qui tourne déjà, et moins de trois échecs d''affilée.';
