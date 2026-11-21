-- 0301 — Les dashboards d'agents.
--
-- Un dashboard est un modèle écrit par un humain (ou par l'assistant) : des
-- composants (KPI, jauge, courbe, barres, anneau, tableau, alertes, texte)
-- placés sur une grille, chacun avec les INSTRUCTIONS que l'agent suit pour le
-- remplir, et le CONTEXTE D'UTILISATION du dashboard. Un collaborateur le
-- remplit à la demande ou selon une cadence : c'est une mission
-- (internal_agent_missions.dashboard_id), que le planificateur relance comme
-- les autres. Chaque remplissage laisse un instantané.
--
-- Le format des données de chaque composant et les modèles prêts à l'emploi
-- sont dans supabase/functions/_shared/dashboard-spec.ts.

create table if not exists public.agent_dashboards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  service_dashboard_id uuid references public.service_dashboards(id) on delete set null,
  name text not null,
  description text,
  -- Qui lit ce dashboard, quand, pour décider quoi.
  usage_context text,
  -- Le collaborateur qui le remplit.
  agent_id uuid references public.internal_agents(id) on delete set null,
  -- Un modèle réutilisable (« Enregistrer comme modèle ») plutôt qu'un dashboard vivant.
  is_template boolean not null default false,
  -- Le modèle du catalogue dont il vient, le cas échéant.
  template_key text,
  -- [{ key, label, value }] : les {{paramètres}} des instructions.
  parameters jsonb not null default '[]'::jsonb,
  -- manual | hourly | daily | weekly | monthly (la mission porte l'échéance).
  refresh text not null default 'manual' check (refresh in ('manual', 'hourly', 'daily', 'weekly', 'monthly')),
  last_filled_at timestamptz,
  last_summary text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_dashboards_scope_idx on public.agent_dashboards (project_id, service_dashboard_id);
create index if not exists agent_dashboards_agent_idx on public.agent_dashboards (agent_id);

create table if not exists public.agent_dashboard_widgets (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references public.agent_dashboards(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('kpi', 'gauge', 'line', 'area', 'bar', 'donut', 'table', 'alerts', 'text')),
  title text not null default '',
  -- Ce que l'agent doit afficher ici, avec quoi, comment.
  instructions text not null default '',
  sources text[] not null default '{}',
  -- { unit, decimals, thresholds: { warn, critical, direction }, max, stacked }
  config jsonb not null default '{}'::jsonb,
  -- { x, y, w, h } sur une grille de 12 colonnes.
  layout jsonb not null default '{}'::jsonb,
  -- Le dernier remplissage.
  data jsonb,
  note text,
  fill_status text check (fill_status in ('ok', 'no_data', 'error')),
  filled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_dashboard_widgets_dashboard_idx on public.agent_dashboard_widgets (dashboard_id);

create table if not exists public.agent_dashboard_snapshots (
  id uuid primary key default gen_random_uuid(),
  dashboard_id uuid not null references public.agent_dashboards(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid references public.internal_agent_runs(id) on delete set null,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  summary text,
  -- { widget_id: { data, note, status } }
  data jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists agent_dashboard_snapshots_dashboard_idx on public.agent_dashboard_snapshots (dashboard_id, started_at desc);
create unique index if not exists agent_dashboard_snapshots_run_idx on public.agent_dashboard_snapshots (dashboard_id, run_id) where run_id is not null;

-- La mission qui remplit un dashboard : le planificateur la relance selon la
-- cadence, « Actualiser » la lance tout de suite.
alter table public.internal_agent_missions
  add column if not exists dashboard_id uuid references public.agent_dashboards(id) on delete cascade;
create index if not exists internal_agent_missions_dashboard_idx on public.internal_agent_missions (dashboard_id) where dashboard_id is not null;

-- Accès : les membres de l'espace (même règle que le reste du tableau de service).
alter table public.agent_dashboards enable row level security;
alter table public.agent_dashboard_widgets enable row level security;
alter table public.agent_dashboard_snapshots enable row level security;

do $$
declare t text;
begin
  foreach t in array array['agent_dashboards', 'agent_dashboard_widgets', 'agent_dashboard_snapshots'] loop
    execute format('drop policy if exists "workspace members access %s" on public.%I', t, t);
    execute format($p$
      create policy "workspace members access %s" on public.%I for all
        using (exists (select 1 from public.workspace_members wm
                        where wm.workspace_id = %I.workspace_id and wm.user_id = auth.uid()))
        with check (exists (select 1 from public.workspace_members wm
                             where wm.workspace_id = %I.workspace_id and wm.user_id = auth.uid()))
    $p$, t, t, t, t);
  end loop;
end $$;

-- Le direct : la page d'un dashboard suit ses composants qui se remplissent.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.agent_dashboard_widgets;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.agent_dashboard_snapshots;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
