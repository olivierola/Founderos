-- Assets module: an infinite, modular canvas where every "asset" (a person,
-- client, invoice, payment, good, document, RAG collection, agent, project, …)
-- is a node that references a real row elsewhere in the app, connected by
-- relations and grouped into zones. Built on React Flow on the client.

-- ── Canvases (a project can have several boards) ──────────────────────────────
create table if not exists public.asset_canvases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null default 'Asset map',
  description text,
  viewport jsonb not null default '{"x":0,"y":0,"zoom":1}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_asset_canvases_project on public.asset_canvases(project_id);

-- ── Nodes ─────────────────────────────────────────────────────────────────────
-- kind 'asset'  → references a real row via (asset_type, ref_id)
-- kind 'zone'   → a resizable background group/area
-- kind 'note'   → a free-floating sticky note / label
create table if not exists public.asset_nodes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  canvas_id uuid not null references public.asset_canvases(id) on delete cascade,
  kind text not null default 'asset' check (kind in ('asset','zone','note')),
  asset_type text,                       -- e.g. crm_contact | invoice | agent | project | document | rag_collection | …
  ref_id uuid,                           -- the referenced row id (null for free nodes)
  label text,                            -- cached/override label
  data jsonb not null default '{}'::jsonb,  -- cached fields + free-node content
  pos_x double precision not null default 0,
  pos_y double precision not null default 0,
  width double precision,
  height double precision,
  color text,                            -- accent / zone color
  z_index int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_asset_nodes_canvas on public.asset_nodes(canvas_id);
create index if not exists idx_asset_nodes_ref on public.asset_nodes(asset_type, ref_id);

-- ── Edges (relations between nodes) ───────────────────────────────────────────
create table if not exists public.asset_edges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  canvas_id uuid not null references public.asset_canvases(id) on delete cascade,
  source_node_id uuid not null references public.asset_nodes(id) on delete cascade,
  target_node_id uuid not null references public.asset_nodes(id) on delete cascade,
  label text,
  relation text,                         -- semantic type: owns | billed_to | assigned_to | depends_on | relates_to | …
  animated boolean not null default false,
  color text,
  created_at timestamptz not null default now()
);
create index if not exists idx_asset_edges_canvas on public.asset_edges(canvas_id);

-- ── RLS: workspace members only ───────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['asset_canvases','asset_nodes','asset_edges'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($f$
      create policy "Members manage %1$s"
      on public.%1$s for all
      using (exists (select 1 from public.workspace_members wm
                     where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()))
      with check (exists (select 1 from public.workspace_members wm
                          where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()))
    $f$, t);
  end loop;
end $$;

-- Realtime for collaborative editing of the canvas.
do $$ begin alter publication supabase_realtime add table public.asset_nodes; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.asset_edges; exception when duplicate_object then null; end $$;
