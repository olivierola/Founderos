-- 0258_resolveai.sql
-- ResolveAI — le tri des demandes reçues par les agents publics.
--
-- Réglé par l'usage `support_triage` de typesafe_settings (off / shadow / on).
-- Chaque message reçu par un agent public est classé par Jev (intention,
-- urgence, besoin d'une personne) ; le code en déduit la priorité, le service
-- et l'éligibilité à une réponse automatique. Une conversation = une demande.
--
-- Trois choses ici :
--   1. `rag_agents.support_config` — les intentions de l'agent (libellé,
--      définition, exemples, réponse auto autorisée, service, consigne), les
--      délais SLA par priorité et le message de relais. Vide = valeurs par
--      défaut du runtime (_shared/resolveai.ts).
--   2. `resolve_tickets` — la file.
--   3. le genre d'outil `support` pour les agents internes (outil
--      support_desk : lire la file, les transcriptions, mettre à jour, chiffres
--      de période pour les rapports).

alter table public.rag_agents
  add column if not exists support_config jsonb not null default '{}'::jsonb;

create table if not exists public.resolve_tickets (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  project_id         uuid references public.projects(id) on delete cascade,
  agent_id           uuid references public.rag_agents(id) on delete cascade,
  conversation_id    uuid not null unique references public.rag_conversations(id) on delete cascade,

  -- widget = un vrai visiteur ; playground = un test depuis l'app. La file
  -- masque les tests par défaut, sans les perdre.
  source             text not null default 'widget',

  intent             text not null,
  intent_label       text not null,
  intent_confidence  real,
  -- 0 information · 1 gêne · 2 bloquant · 3 critique. Ne redescend jamais au
  -- fil d'une conversation.
  urgency            smallint not null default 0 check (urgency between 0 and 3),
  priority           text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  route              text,

  needs_human        boolean not null default false,
  handoff_reason     text,
  -- auto = traitée par l'agent · open = confiée à l'équipe, en attente ·
  -- in_progress = prise en main · closed = close.
  status             text not null default 'auto' check (status in ('auto', 'open', 'in_progress', 'closed')),
  sla_due_at         timestamptz,
  assignee           text,
  notes              jsonb not null default '[]'::jsonb,

  -- shadow = ce que le tri AURAIT décidé, sans effet sur la réponse.
  mode               text not null default 'shadow' check (mode in ('shadow', 'on')),

  first_message      text,
  last_message       text,
  turn_count         int not null default 1,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  closed_at          timestamptz
);

create index if not exists resolve_tickets_queue_idx
  on public.resolve_tickets (project_id, status, priority, updated_at desc);
create index if not exists resolve_tickets_agent_idx
  on public.resolve_tickets (agent_id, created_at desc);

alter table public.resolve_tickets enable row level security;

drop policy if exists "members read resolve tickets" on public.resolve_tickets;
create policy "members read resolve tickets" on public.resolve_tickets for select
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = resolve_tickets.workspace_id and wm.user_id = auth.uid()));

-- Les membres traitent la file (statut, responsable, notes) ; la création
-- reste au service_role, c'est-à-dire à rag-chat.
drop policy if exists "members work resolve tickets" on public.resolve_tickets;
create policy "members work resolve tickets" on public.resolve_tickets for update
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = resolve_tickets.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = resolve_tickets.workspace_id and wm.user_id = auth.uid()));

comment on table public.resolve_tickets is
  'ResolveAI : une demande par conversation d''agent public — intention, urgence, priorité, service, besoin humain, SLA. Écrite par rag-chat, traitée par l''équipe et par les agents internes (outil support_desk).';

-- ── Le genre d'outil `support` ───────────────────────────────────────────────
-- Même règle que 0236 : la liste doit porter TOUS les genres déjà en base.
alter table public.internal_agent_tools
  drop constraint if exists internal_agent_tools_kind_check;

alter table public.internal_agent_tools
  add constraint internal_agent_tools_kind_check check (
    kind in (
      'web_search', 'web_fetch', 'db_read', 'rag_search', 'edge_function',
      'vault_connector', 'connector_action', 'composio_toolkit', 'crm',
      'tracker', 'support',
      'security_scan', 'vibe_code', 'testing', 'simulation', 'custom'
    )
  );

comment on constraint internal_agent_tools_kind_check on public.internal_agent_tools is
  'Les genres d''outils que le runtime sait construire. Toute addition dans internal-agent-tools.ts doit passer ici, sans quoi la capacité est inaccordable.';
