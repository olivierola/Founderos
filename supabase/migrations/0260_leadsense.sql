-- 0260_leadsense.sql
-- LeadSense — la qualification des prospects par les agents internes.
--
-- Réglé par l'usage `lead_scoring` de typesafe_settings. L'outil `lead_sense`
-- (genre `leads`) qualifie un prospect sur la grille de l'entreprise en un
-- appel Jev (type de demande, un score 0-3 par critère, prospect chaud,
-- commercial), après l'avoir enrichi par ce que le CRM sait déjà. Le code
-- calcule le score pondéré 0-100 et le rang A-D. L'agent publie ensuite le
-- tableau prédéfini (livrable de type `lead_board`), construit à partir des
-- lignes ci-dessous — il n'en écrit que le titre, la lecture et les
-- recommandations.

-- ── La grille, une par projet ────────────────────────────────────────────────
create table if not exists public.leadsense_config (
  project_id    uuid primary key references public.projects(id) on delete cascade,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  -- { ideal_customer, criteria:[{key,label,what,levels[4],weight}],
  --   lead_types:[{key,label,what,not_for,examples,qualify}], hot_rule,
  --   reps:[{id,name,email,covers}], tiers:{a,b,c} } — vide = défauts du runtime.
  config        jsonb not null default '{}'::jsonb,
  updated_by    uuid references auth.users(id) on delete set null,
  updated_at    timestamptz not null default now()
);

alter table public.leadsense_config enable row level security;

-- La grille est un réglage commercial, pas de gouvernance : les membres la
-- tiennent (un responsable commercial n'est pas forcément admin de l'espace).
drop policy if exists "members manage leadsense config" on public.leadsense_config;
create policy "members manage leadsense config" on public.leadsense_config for all
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = leadsense_config.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = leadsense_config.workspace_id and wm.user_id = auth.uid()));

-- ── Les prospects ────────────────────────────────────────────────────────────
create table if not exists public.leadsense_leads (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  project_id       uuid not null references public.projects(id) on delete cascade,
  agent_id         uuid,
  run_id           uuid,

  -- public_agent (demande avant-vente d'un agent public, source_ref = la
  -- demande ResolveAI), crm (source_ref = la fiche), form, email, agent…
  source           text not null default 'agent',
  source_ref       text,

  name             text,
  email            text,
  company          text,
  role             text,
  message          text,
  -- Ce que l'agent a trouvé lui-même, et ce que le CRM savait déjà.
  context          text,
  enrichment       jsonb not null default '{}'::jsonb,

  lead_type        text not null,
  lead_type_label  text not null,
  -- Faux pour un candidat, un fournisseur, un spam, un client existant : pas
  -- de score, pas de rang — ce n'est pas un « mauvais prospect », ce n'en est
  -- pas un.
  qualifies        boolean not null default true,
  criteria         jsonb not null default '{}'::jsonb,
  score            smallint check (score between 0 and 100),
  tier             text check (tier in ('A', 'B', 'C', 'D')),
  hot              boolean not null default false,
  hot_p            real,

  rep_id           text,
  rep_name         text,
  status           text not null default 'new'
                   check (status in ('new', 'contacted', 'qualified', 'disqualified', 'won', 'lost')),
  notes            jsonb not null default '[]'::jsonb,

  mode             text not null default 'on' check (mode in ('shadow', 'on')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists leadsense_leads_project_idx
  on public.leadsense_leads (project_id, created_at desc);
create index if not exists leadsense_leads_queue_idx
  on public.leadsense_leads (project_id, hot desc, score desc);
-- Une source n'est qualifiée qu'une fois (la requalifier met la ligne à jour).
create unique index if not exists leadsense_leads_source_uidx
  on public.leadsense_leads (project_id, source, source_ref)
  where source_ref is not null;

alter table public.leadsense_leads enable row level security;

drop policy if exists "members read leadsense leads" on public.leadsense_leads;
create policy "members read leadsense leads" on public.leadsense_leads for select
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = leadsense_leads.workspace_id and wm.user_id = auth.uid()));

-- Les membres font avancer un prospect (statut, commercial, notes) ; la
-- qualification elle-même reste au service_role (l'outil des agents).
drop policy if exists "members work leadsense leads" on public.leadsense_leads;
create policy "members work leadsense leads" on public.leadsense_leads for update
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = leadsense_leads.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = leadsense_leads.workspace_id and wm.user_id = auth.uid()));

comment on table public.leadsense_leads is
  'LeadSense : un prospect qualifié par un agent interne — type, niveaux par critère, score 0-100, rang A-D, chaud, commercial, statut. Le livrable lead_board est construit à partir de ces lignes.';

-- ── Le genre d'outil `leads` (outil lead_sense) ──────────────────────────────
alter table public.internal_agent_tools
  drop constraint if exists internal_agent_tools_kind_check;

alter table public.internal_agent_tools
  add constraint internal_agent_tools_kind_check check (
    kind in (
      'web_search', 'web_fetch', 'db_read', 'rag_search', 'edge_function',
      'vault_connector', 'connector_action', 'composio_toolkit', 'crm',
      'tracker', 'support', 'governance', 'leads',
      'security_scan', 'vibe_code', 'testing', 'simulation', 'custom'
    )
  );

comment on constraint internal_agent_tools_kind_check on public.internal_agent_tools is
  'Les genres d''outils que le runtime sait construire. Toute addition dans internal-agent-tools.ts doit passer ici, sans quoi la capacité est inaccordable.';
