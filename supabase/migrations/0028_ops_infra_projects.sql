-- Ops infra projects: a redesign of "Workflows" around a user-described,
-- multi-tool infrastructure (Terraform + Ansible + Docker + K8s) instead of a
-- single one-shot bundle.
--
-- Concept: the user writes a free-text brief ("I want Terraform on Hetzner, 2
-- VPS, Ansible to harden + install Docker, app delivered as docker-compose,
-- workers on a small K8s cluster…"). The AI produces a Plan that breaks the
-- ask into Layers (one per tool/concern), the user approves, then the
-- generator emits N bundles — one per layer — all linked under one
-- ops_infra_project umbrella. Each bundle stays in ops_generated_files and can
-- be regenerated independently.

create table if not exists public.ops_infra_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- User-facing label + free-text brief that drove the plan.
  name text not null,
  brief text,
  -- The plan as the AI proposed (and the user may have edited before generating).
  --   plan: {
  --     summary: string,
  --     layers: [{
  --       id: string,                 -- "tf-provision", "ansible-bootstrap", ...
  --       label: string,
  --       tool: "terraform"|"ansible"|"docker_compose"|"kubernetes"|"helm"|"script",
  --       purpose: string,            -- one-line "what this layer does"
  --       inputs: string[],           -- what the layer needs from previous layers
  --       outputs: string[],          -- what it produces for next layers
  --       depends_on: string[],       -- ids of layers that must run first
  --       risk_level: "low"|"medium"|"high",
  --       notes: string
  --     }],
  --     execution_order: string[],    -- ordered list of layer ids
  --     assumptions: string[],
  --     open_questions: string[]
  --   }
  plan jsonb not null default '{}'::jsonb,
  plan_status text default 'draft' check (plan_status in ('draft','generating','generated','partially_failed','failed')),
  plan_model text,                              -- which AI model produced the plan
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  -- Free-form metadata for the UI (selected target cloud, default domain, etc.).
  metadata jsonb default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- One row per layer the agent generated. Links the umbrella project to the
-- concrete file bundle stored in ops_generated_files (bundle_id).
create table if not exists public.ops_infra_layers (
  id uuid primary key default gen_random_uuid(),
  infra_project_id uuid not null references public.ops_infra_projects(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Stable id from the plan ("tf-provision") so the UI can match plan ↔ layer.
  layer_key text not null,
  label text not null,
  tool text not null check (tool in ('terraform','ansible','docker_compose','kubernetes','helm','script','other')),
  purpose text,
  -- The bundle of files this layer produced (NULL while generating / failed).
  bundle_id uuid,
  -- Per-layer status so partial-failure is observable in the UI.
  status text default 'pending' check (status in ('pending','generating','ready','failed','superseded')),
  error_message text,
  -- Ordering inside the infra project — used for sidebar display.
  position int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (infra_project_id, layer_key)
);

-- ---- RLS ------------------------------------------------------------------

alter table public.ops_infra_projects enable row level security;
alter table public.ops_infra_layers enable row level security;

drop policy if exists "Members read ops_infra_projects" on public.ops_infra_projects;
create policy "Members read ops_infra_projects"
on public.ops_infra_projects for select
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_infra_projects.workspace_id and wm.user_id = auth.uid()));

drop policy if exists "Members manage ops_infra_projects" on public.ops_infra_projects;
create policy "Members manage ops_infra_projects"
on public.ops_infra_projects for all
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_infra_projects.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')))
with check (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_infra_projects.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')));

drop policy if exists "Members read ops_infra_layers" on public.ops_infra_layers;
create policy "Members read ops_infra_layers"
on public.ops_infra_layers for select
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_infra_layers.workspace_id and wm.user_id = auth.uid()));

drop policy if exists "Members manage ops_infra_layers" on public.ops_infra_layers;
create policy "Members manage ops_infra_layers"
on public.ops_infra_layers for all
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_infra_layers.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')))
with check (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = ops_infra_layers.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')));

-- ---- Bundle → layer link (so the Architecture tab can navigate the umbrella).
-- We don't add a FK from ops_generated_files since old bundles don't belong to
-- any infra project; the layer points to the bundle via bundle_id and that's
-- enough to round-trip.

create index if not exists idx_ops_infra_projects_project on public.ops_infra_projects(project_id, created_at desc);
create index if not exists idx_ops_infra_layers_infra on public.ops_infra_layers(infra_project_id, position);
create index if not exists idx_ops_infra_layers_bundle on public.ops_infra_layers(bundle_id);
