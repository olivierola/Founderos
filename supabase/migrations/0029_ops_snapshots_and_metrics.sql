-- Ops: infra versioning (snapshots) + live node metrics cache.
--
-- Versioning model: each snapshot is an immutable, complete copy of an
-- ops_infra_projects row at a point in time — its plan, all its layer
-- definitions, all bundle files content, and the latest topology. Restoring
-- a snapshot rewrites the current state to match. Two pieces of motivation:
--   1. "Save without deploying" — user is editing, wants a checkpoint
--   2. "Roll back" — a regenerated layer broke something, revert to t-1

create table if not exists public.ops_infra_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  infra_project_id uuid not null references public.ops_infra_projects(id) on delete cascade,
  -- User-facing label + auto-incrementing version number within the infra.
  label text not null,
  version int not null,
  -- Optional message (like a git commit message).
  message text,
  -- The full payload — see SnapshotPayload TS type. Stored as jsonb so we can
  -- diff fields later without parsing the whole blob.
  --   {
  --     "infra": { name, brief, plan, plan_status, metadata },
  --     "layers": [ { layer_key, label, tool, purpose, position, status } ],
  --     "bundles": [ { bundle_id, files: [{ file_path, file_type, content }] } ],
  --     "topologies": [ { bundle_id, summary, topology } ]
  --   }
  payload jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  unique (infra_project_id, version)
);

alter table public.ops_infra_snapshots enable row level security;

drop policy if exists "Members read ops_infra_snapshots" on public.ops_infra_snapshots;
create policy "Members read ops_infra_snapshots"
on public.ops_infra_snapshots for select
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_infra_snapshots.workspace_id and wm.user_id = auth.uid()));

drop policy if exists "Members manage ops_infra_snapshots" on public.ops_infra_snapshots;
create policy "Members manage ops_infra_snapshots"
on public.ops_infra_snapshots for all
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_infra_snapshots.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')))
with check (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_infra_snapshots.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')));

create index if not exists idx_ops_infra_snapshots_infra
  on public.ops_infra_snapshots(infra_project_id, version desc);

-- Helper RPC: returns next version for a given infra (atomic against races).
create or replace function public.next_ops_snapshot_version(p_infra_id uuid)
returns int
language sql
as $$
  select coalesce(max(version), 0) + 1
  from public.ops_infra_snapshots
  where infra_project_id = p_infra_id;
$$;

-- ---------------------------------------------------------------------------
-- Live node metrics — short-lived cache so we don't re-SSH on every glance.
-- Right-click on a node hits ops-node-probe, which runs the SSH probe and
-- writes the result here. The UI polls the same key for ~30s before showing
-- stale data.
-- ---------------------------------------------------------------------------

create table if not exists public.ops_node_metrics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- A node lives inside a topology, identified by its topology id + node id.
  topology_id uuid references public.ops_topologies(id) on delete cascade,
  node_key text not null,                       -- node.id within the topology
  -- The server we actually probed (may differ from the topology's "host" node).
  server_id uuid references public.ops_servers(id) on delete set null,
  -- One row per probe.
  metrics jsonb not null default '{}'::jsonb,   -- structured key/value
  raw text,                                     -- raw command output for the inspector
  status text default 'ok' check (status in ('ok','warn','error','timeout')),
  duration_ms int,
  created_at timestamptz default now()
);

alter table public.ops_node_metrics enable row level security;

drop policy if exists "Members read ops_node_metrics" on public.ops_node_metrics;
create policy "Members read ops_node_metrics"
on public.ops_node_metrics for select
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_node_metrics.workspace_id and wm.user_id = auth.uid()));

drop policy if exists "Members manage ops_node_metrics" on public.ops_node_metrics;
create policy "Members manage ops_node_metrics"
on public.ops_node_metrics for all
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_node_metrics.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')))
with check (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_node_metrics.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')));

create index if not exists idx_ops_node_metrics_node
  on public.ops_node_metrics(topology_id, node_key, created_at desc);
