-- 0216_automations.sql
-- Deux natures de workflow, et la distinction n'est pas cosmétique.
--
-- Jusqu'ici tout ce que cet écran produisait était une PROCÉDURE : un playbook
-- markdown qu'un agent lit au déclenchement et exécute en décidant lui-même qui
-- fait quoi. C'est ce qu'on veut pour « traiter une réclamation client » — le
-- travail demande du jugement, et on écrit des instructions, pas un programme.
--
-- Ce n'est PAS ce qu'on veut pour « chaque lundi 9 h, récupérer les deals et les
-- poster dans Slack ». Là, rien n'est à juger. Confier ce travail à un modèle,
-- c'est payer un raisonnement pour obtenir une exécution, accepter qu'elle varie
-- d'un run à l'autre, et perdre la seule chose qui compte pour ce genre de
-- tâche : la certitude qu'elle fait exactement la même chose à chaque fois.
--
-- D'où deux natures :
--
--   procedure   — des instructions. Un agent les lit et les exécute.
--                 Déterministe : non. Souple : oui.
--   automation  — une suite d'appels. Le moteur les exécute lui-même, dans
--                 l'ordre, sans modèle. Déterministe : oui. Souple : non.
--
-- Une automatisation peut appeler un agent pour l'étape qui, elle, demande du
-- jugement (« résume ces tickets ») : c'est un bloc explicite, pas le mode par
-- défaut. C'est ce qui évite le faux dilemme — on ne choisit pas entre tout
-- automatiser et tout déléguer, on dit à quel endroit précis le jugement entre.

alter table public.agent_workflows
  add column if not exists kind text not null default 'procedure'
    check (kind in ('procedure', 'automation'));

comment on column public.agent_workflows.kind is
  'procedure = un playbook qu''un agent lit et exécute · automation = une suite d''appels que le moteur exécute lui-même, sans modèle.';

-- ── La trace d'une exécution automatique ────────────────────────────────────
-- Une procédure laisse une trace lisible : le run de l'agent, ses outils, son
-- rapport. Une automatisation n'a rien de tout ça — sans journal par étape, un
-- échec se résume à « failed » et il n'existe aucun moyen de savoir laquelle des
-- six actions a cassé, avec quels arguments, ni ce que l'API a répondu.
--
-- C'est donc la contrepartie obligatoire du déterminisme : ce qui n'est pas
-- raconté par un agent doit être enregistré par le moteur.
create table if not exists public.agent_workflow_run_steps (
  id            bigserial primary key,
  run_id        uuid not null references public.agent_workflow_runs(id) on delete cascade,
  workflow_id   uuid not null references public.agent_workflows(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,

  -- L'ordre réel d'exécution, pas celui du document : une condition fait sauter
  -- des étapes, et c'est le chemin PARCOURU qu'on relit.
  position      int not null,
  block_id      text not null,
  block_kind    text not null,
  label         text,

  status        text not null default 'running'
                check (status in ('running', 'succeeded', 'failed', 'skipped')),
  -- Ce qui a été envoyé et ce qui est revenu. Tronqués à l'écriture : un
  -- journal qui stocke la réponse entière d'une API de listing remplit la base
  -- sans rien apprendre de plus.
  input         jsonb not null default '{}'::jsonb,
  output        jsonb,
  error_message text,

  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index if not exists idx_wf_run_steps on public.agent_workflow_run_steps(run_id, position);

alter table public.agent_workflow_run_steps enable row level security;

drop policy if exists "members read workflow run steps" on public.agent_workflow_run_steps;
create policy "members read workflow run steps" on public.agent_workflow_run_steps for select
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = agent_workflow_run_steps.workspace_id and wm.user_id = auth.uid()));

-- Écriture réservée au moteur (service_role) : une étape de journal modifiable
-- depuis le client ne prouve plus rien de ce qui s'est passé.

-- ── Le run peut désormais s'arrêter à mi-chemin ─────────────────────────────
-- Une condition fausse n'est pas un échec : c'est une exécution qui se termine
-- normalement sans aller au bout. Les confondre ferait sonner l'alerte à chaque
-- fois qu'un filtre fait son travail.
alter table public.agent_workflow_runs
  drop constraint if exists agent_workflow_runs_status_check;
alter table public.agent_workflow_runs
  add constraint agent_workflow_runs_status_check
  check (status in ('running', 'succeeded', 'failed', 'cancelled', 'stopped'));

comment on column public.agent_workflow_runs.status is
  'stopped = une condition a arrêté la suite. Ce n''est pas un échec : c''est le filtre qui a fait son travail.';
