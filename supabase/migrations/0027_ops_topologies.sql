-- Ops topology: a structured, machine-readable description of the
-- infrastructure represented by a generated files bundle.
--
-- Lives next to ops_generated_files but is separate so we can regenerate /
-- enrich the topology without rewriting all files (and vice versa).

create table if not exists public.ops_topologies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- One topology per bundle (latest wins; older versions kept for diffing later).
  bundle_id uuid not null,
  -- Free-text summary of the architecture, displayed above the diagram.
  summary text,
  -- The structured topology:
  --   nodes: [{ id, kind, label, group?, ports?, env?, image?, command?, healthcheck?, volumes?, meta? }]
  --     kind in: server | container | service | database | cache | queue
  --              | reverse_proxy | load_balancer | cdn | object_storage
  --              | external | dns | secret_store | scheduler | network
  --   edges: [{ id, source, target, kind, label?, port?, protocol?, encrypted?, meta? }]
  --     kind in: http | https | tcp | ssh | env | webhook | volume_mount | depends_on | network_link
  --   groups: [{ id, label, kind, contains: [node_ids] }]   -- e.g. "VPS prod-01" containing containers
  --   notes: [{ node_id?, edge_id?, text, severity? }]      -- AI commentary
  topology jsonb not null default '{}'::jsonb,
  -- Bookkeeping
  source text default 'ai' check (source in ('ai','parsed','manual')),
  created_at timestamptz default now()
);

alter table public.ops_topologies enable row level security;

drop policy if exists "Members read ops_topologies" on public.ops_topologies;
create policy "Members read ops_topologies"
on public.ops_topologies for select
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_topologies.workspace_id and wm.user_id = auth.uid()));

drop policy if exists "Members manage ops_topologies" on public.ops_topologies;
create policy "Members manage ops_topologies"
on public.ops_topologies for all
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_topologies.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')))
with check (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_topologies.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')));

create index if not exists idx_ops_topologies_bundle on public.ops_topologies(bundle_id, created_at desc);
create index if not exists idx_ops_topologies_project on public.ops_topologies(project_id, created_at desc);
