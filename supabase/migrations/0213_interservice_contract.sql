-- 0213_interservice_contract.sql
-- Le contrat inter-services : rendre l'isolation VRAIE, et la collaboration
-- EXPLICITE. Aujourd'hui elle n'est ni l'une ni l'autre.
--
-- Ce que l'audit a trouvé, en lisant le code plutôt que l'intention :
--
--   1. L'isolation des dashboards de service (0133) est une isolation d'UI.
--      Au runtime, `list_team_agents`, `send_message_to_agent` et
--      `delegate_mission` filtrent sur project_id — pas sur
--      service_dashboard_id. Un agent Marketing pouvait donc déjà déléguer à
--      un agent Finance, sans qu'aucun écran ne le montre ni qu'aucune règle
--      ne l'encadre. Ni cloisonné, ni gouverné : juste invisible.
--
--   2. La mémoire d'équipe est un pot commun plat. `internal_agent_team_memories`
--      n'a que project_id : les 15 lignes les mieux notées du PROJET partent
--      dans le prompt de n'importe quel agent. Le savoir Finance occupe le
--      contexte d'un agent Marketing, et le savoir vraiment transverse (« notre
--      client type », « on ne s'engage jamais sur un délai sans le Studio »)
--      n'a aucun rang particulier.
--
--   3. Il n'existe aucun organigramme. `internal_agents` a `is_orchestrator`
--      (booléen) et `role` (texte libre) — pas de lien manager → subordonné.
--      La hiérarchie n'existe que le temps d'une room.
--
-- Cette migration pose les trois pièces manquantes :
--
--   • parent_agent_id       — l'organigramme, persisté.
--   • collaboration         — la politique de chaque service : qui peut lui
--                             déléguer du travail, et à quelles conditions.
--   • service_dashboard_id  — sur la mémoire d'équipe, ce qui la transforme en
--     mémoire À TROIS ÉTAGES sans nouvelle table :
--
--         agent      → internal_agent_memories        (déjà là)
--         service    → internal_agent_team_memories, service_dashboard_id = X
--         entreprise → internal_agent_team_memories, service_dashboard_id NULL
--
--     NULL veut dire « ça vaut pour toute l'entreprise ». C'est aussi
--     exactement l'état des lignes existantes, donc la migration ne casse rien :
--     tout ce qui a été appris jusqu'ici devient de la connaissance d'entreprise,
--     ce qui est le défaut le plus sûr (on ne perd rien, on ne cloisonne pas
--     rétroactivement du savoir que quelqu'un utilisait peut-être).

-- ── 1. L'organigramme ───────────────────────────────────────────────────────
-- Un agent peut avoir un responsable : celui à qui il rend compte, et celui
-- dont les objectifs se décomposent dans les siens. Volontairement un simple
-- parent (pas une table de liens) — une organisation à plusieurs managers par
-- personne est une organisation qu'on ne sait pas dessiner.
alter table public.internal_agents
  add column if not exists parent_agent_id uuid references public.internal_agents(id) on delete set null;
create index if not exists idx_internal_agents_parent
  on public.internal_agents(parent_agent_id) where parent_agent_id is not null;

comment on column public.internal_agents.parent_agent_id is
  'Le responsable de cet agent dans l''organigramme. NULL = rattaché directement au service.';

-- ── 2. La politique de collaboration d'un service ───────────────────────────
-- Trois positions, et pas une de plus, parce qu'un curseur de permissions fin
-- ne se règle jamais :
--   open       — n'importe quel agent du projet peut déléguer ici (défaut :
--                c'est le comportement ACTUEL, on ne change rien sans le dire).
--   on_request — une délégation venue d'un autre service passe en approbation.
--   closed     — le service ne prend de travail que de l'intérieur.
alter table public.service_dashboards
  add column if not exists mission text,
  add column if not exists collaboration text not null default 'open'
    check (collaboration in ('open','on_request','closed'));

comment on column public.service_dashboards.mission is
  'À quoi sert ce service, en une phrase. Envoyée aux agents du service et visible des autres services dans l''annuaire.';
comment on column public.service_dashboards.collaboration is
  'Qui peut déléguer du travail à ce service : open (tout le projet) · on_request (approbation) · closed (interne uniquement).';

-- ── 3. La mémoire à trois étages ────────────────────────────────────────────
alter table public.internal_agent_team_memories
  add column if not exists service_dashboard_id uuid
    references public.service_dashboards(id) on delete cascade;

create index if not exists idx_team_memories_scope
  on public.internal_agent_team_memories(project_id, service_dashboard_id, importance desc);

comment on column public.internal_agent_team_memories.service_dashboard_id is
  'NULL = connaissance d''ENTREPRISE (tous les agents la voient). Renseigné = connaissance de SERVICE (seuls ses agents la voient).';

-- ── 4. La trace des délégations inter-services ──────────────────────────────
-- Une délégation qui traverse une frontière de service n'est pas la même chose
-- qu'une délégation interne : c'est elle qu'un dirigeant veut pouvoir relire.
-- On la marque à l'écriture plutôt que de la recalculer après coup, parce que
-- l'agent peut avoir changé de service entre-temps.
alter table public.internal_agent_a2a_messages
  add column if not exists from_dashboard_id uuid references public.service_dashboards(id) on delete set null,
  add column if not exists to_dashboard_id   uuid references public.service_dashboards(id) on delete set null,
  add column if not exists cross_service boolean not null default false;

create index if not exists idx_a2a_cross_service
  on public.internal_agent_a2a_messages(project_id, created_at desc) where cross_service;

comment on column public.internal_agent_a2a_messages.cross_service is
  'La demande a franchi une frontière de service. Calculé à l''écriture : l''agent peut être déplacé ensuite.';
