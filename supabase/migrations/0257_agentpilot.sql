-- 0257_agentpilot.sql
-- AgentPilot — le journal des décisions de pilotage des runs d'agents.
--
-- Trois nouveaux usages du jugement rapide (typesafe_settings, off/shadow/on) :
--   model_choice      — le modèle de raisonnement se justifie-t-il
--   loop_watch        — boucle déguisée (la même tentative reformulée)
--   human_escalation  — le blocage dépend-il de l'utilisateur
-- et le contrôleur déterministe de la boucle (`decideNext`), dont chaque
-- décision non triviale (replan, finalisation forcée, arrêt) est tracée ici
-- sous kind = 'controller'.
--
-- Pourquoi une table plutôt que typesafe_judgements : celle-ci porte l'AGENT et
-- la DÉCISION prise, lisibles d'un coup d'œil ; typesafe_judgements porte la
-- question et les probabilités brutes. L'écran AgentPilot lit les deux.

create table if not exists public.agentpilot_decisions (
  id            bigserial primary key,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  project_id    uuid references public.projects(id) on delete cascade,
  agent_id      uuid,
  run_id        uuid,

  kind          text not null check (kind in ('model_choice', 'loop_watch', 'human_escalation', 'controller')),
  -- « heavy », « standard », « boucle sémantique », « question à l'utilisateur »,
  -- ou l'action du contrôleur (replan / finalize / abort).
  decision      text not null,
  -- VRAI quand la décision a changé le run (mode on, seuil passé). Faux en
  -- shadow : c'est ce que le modèle AURAIT décidé.
  applied       boolean not null default false,
  probability   real,
  detail        jsonb not null default '{}'::jsonb,

  created_at    timestamptz not null default now()
);

create index if not exists agentpilot_ws_created_idx
  on public.agentpilot_decisions (workspace_id, created_at desc);
create index if not exists agentpilot_run_idx
  on public.agentpilot_decisions (run_id);

alter table public.agentpilot_decisions enable row level security;

drop policy if exists "members read agentpilot" on public.agentpilot_decisions;
create policy "members read agentpilot" on public.agentpilot_decisions for select
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = agentpilot_decisions.workspace_id and wm.user_id = auth.uid()));

comment on table public.agentpilot_decisions is
  'AgentPilot : décisions de pilotage des runs (choix du modèle, boucles déguisées, escalade humaine, décisions du contrôleur). Écriture service_role uniquement.';
