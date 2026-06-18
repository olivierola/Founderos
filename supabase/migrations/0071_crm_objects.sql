-- CRM re-imagined as a generic object system (Attio/Notion-style).
-- Everything is an "object" (People, Companies, Opportunities, Tasks, Notes,
-- Dashboards, Software, …) with typed "properties" (columns). Records are rows
-- whose values live in JSONB keyed by property key. Objects can relate to each
-- other, and users define custom objects + properties at runtime (no migration).
--
-- System objects are seeded per project and can be backed by a real table
-- (synced, read-mostly) — e.g. People ↔ crm_contacts — or be native EAV.

-- ── Objects (a "table" definition) ────────────────────────────────────────────
create table if not exists public.crm_objects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  slug text not null,                       -- unique per project: people | companies | opportunities | <custom>
  label text not null,
  label_plural text,
  icon text default 'Boxes',                -- lucide icon name
  color text default 'text-emerald-500',
  is_system boolean not null default false, -- seeded; cannot be deleted
  source_table text,                        -- when set, records mirror this real table (read sync)
  title_property text default 'name',       -- which property is the record title
  position int not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (project_id, slug)
);
create index if not exists idx_crm_objects_project on public.crm_objects(project_id, position);

-- ── Properties (typed columns) ────────────────────────────────────────────────
create table if not exists public.crm_properties (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  object_id uuid not null references public.crm_objects(id) on delete cascade,
  key text not null,                        -- json key in record.data
  label text not null,
  type text not null default 'text'
    check (type in ('text','long_text','number','currency','percent','checkbox',
                    'select','multi_select','date','datetime','email','phone','url','relation','user','rating')),
  options jsonb not null default '[]'::jsonb,  -- for select/multi_select: [{value,label,color}]
  relation_object_id uuid references public.crm_objects(id) on delete set null, -- for type=relation
  is_title boolean not null default false,
  is_system boolean not null default false,  -- core property of a system object
  required boolean not null default false,
  position int not null default 0,
  width int,                                  -- column width (px)
  created_at timestamptz not null default now(),
  unique (object_id, key)
);
create index if not exists idx_crm_properties_object on public.crm_properties(object_id, position);

-- ── Records (rows) ────────────────────────────────────────────────────────────
-- For native objects, data holds all values. For source-backed system objects,
-- source_id points to the mirrored row and data caches a snapshot.
create table if not exists public.crm_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  object_id uuid not null references public.crm_objects(id) on delete cascade,
  source_id uuid,                            -- when mirroring a real row
  data jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_crm_records_object on public.crm_records(object_id, created_at desc);
create index if not exists idx_crm_records_source on public.crm_records(object_id, source_id);
create index if not exists idx_crm_records_data on public.crm_records using gin (data jsonb_path_ops);

-- ── Relations between records (for type=relation properties) ──────────────────
create table if not exists public.crm_record_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  property_id uuid not null references public.crm_properties(id) on delete cascade,
  from_record_id uuid not null references public.crm_records(id) on delete cascade,
  to_record_id uuid not null references public.crm_records(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (property_id, from_record_id, to_record_id)
);
create index if not exists idx_crm_links_from on public.crm_record_links(from_record_id);
create index if not exists idx_crm_links_to on public.crm_record_links(to_record_id);

-- ── Saved views (table / kanban / board) ──────────────────────────────────────
create table if not exists public.crm_views (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  object_id uuid not null references public.crm_objects(id) on delete cascade,
  name text not null default 'All',
  kind text not null default 'table' check (kind in ('table','kanban','gallery')),
  config jsonb not null default '{}'::jsonb,  -- {filters:[], sorts:[], group_by, hidden:[], column_order:[]}
  is_default boolean not null default false,
  position int not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_crm_views_object on public.crm_views(object_id, position);

-- ── RLS: workspace members ────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['crm_objects','crm_properties','crm_records','crm_record_links','crm_views'] loop
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

-- Realtime for collaborative editing of records.
do $$ begin alter publication supabase_realtime add table public.crm_records; exception when duplicate_object then null; end $$;

-- ── Seeder: create the default system objects + properties for a project ──────
-- Idempotent; safe to call on first visit. Native EAV objects (no source_table)
-- so the user can immediately edit/add columns. Existing crm_contacts/crm_deals
-- stay as-is; the new People/Opportunities objects are the go-forward model.
create or replace function public.crm_seed_project(p_workspace uuid, p_project uuid, p_user uuid default null)
returns void language plpgsql security definer as $$
declare
  oid uuid;
begin
  -- Guard: only seed once.
  if exists (select 1 from public.crm_objects where project_id = p_project) then
    return;
  end if;

  -- helper inline via a temp function pattern: insert object then properties.
  -- People
  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position, created_by)
    values (p_workspace, p_project, 'people', 'Person', 'People', 'Users', 'text-violet-500', true, 'name', 0, p_user)
    returning id into oid;
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Name', 'text', true, true, 0),
    (p_workspace, p_project, oid, 'email', 'Email', 'email', false, true, 1),
    (p_workspace, p_project, oid, 'phone', 'Phone', 'phone', false, false, 2),
    (p_workspace, p_project, oid, 'job_title', 'Job Title', 'text', false, false, 3),
    (p_workspace, p_project, oid, 'linkedin', 'LinkedIn', 'url', false, false, 4);

  -- Companies
  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position, created_by)
    values (p_workspace, p_project, 'companies', 'Company', 'Companies', 'Building2', 'text-blue-500', true, 'name', 1, p_user)
    returning id into oid;
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Name', 'text', true, true, 0),
    (p_workspace, p_project, oid, 'domain', 'Domain', 'url', false, false, 1),
    (p_workspace, p_project, oid, 'employees', 'Employees', 'number', false, false, 2),
    (p_workspace, p_project, oid, 'industry', 'Industry', 'text', false, false, 3);

  -- Opportunities
  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position, created_by)
    values (p_workspace, p_project, 'opportunities', 'Opportunity', 'Opportunities', 'Target', 'text-rose-500', true, 'name', 2, p_user)
    returning id into oid;
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, options, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Name', 'text', '[]', true, true, 0),
    (p_workspace, p_project, oid, 'amount', 'Amount', 'currency', '[]', false, false, 1),
    (p_workspace, p_project, oid, 'stage', 'Stage', 'select',
      '[{"value":"new","label":"New","color":"#64748b"},{"value":"qualified","label":"Qualified","color":"#3b82f6"},{"value":"proposal","label":"Proposal","color":"#a855f7"},{"value":"won","label":"Won","color":"#10b981"},{"value":"lost","label":"Lost","color":"#ef4444"}]',
      false, false, 2),
    (p_workspace, p_project, oid, 'close_date', 'Close date', 'date', '[]', false, false, 3);

  -- Tasks
  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position, created_by)
    values (p_workspace, p_project, 'tasks', 'Task', 'Tasks', 'CheckSquare', 'text-emerald-500', true, 'name', 3, p_user)
    returning id into oid;
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, options, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Title', 'text', '[]', true, true, 0),
    (p_workspace, p_project, oid, 'done', 'Done', 'checkbox', '[]', false, false, 1),
    (p_workspace, p_project, oid, 'due', 'Due', 'date', '[]', false, false, 2),
    (p_workspace, p_project, oid, 'priority', 'Priority', 'select',
      '[{"value":"low","label":"Low","color":"#64748b"},{"value":"medium","label":"Medium","color":"#f59e0b"},{"value":"high","label":"High","color":"#ef4444"}]',
      false, false, 3);

  -- Notes
  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position, created_by)
    values (p_workspace, p_project, 'notes', 'Note', 'Notes', 'StickyNote', 'text-amber-500', true, 'name', 4, p_user)
    returning id into oid;
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Title', 'text', true, true, 0),
    (p_workspace, p_project, oid, 'body', 'Body', 'long_text', false, false, 1);

  -- Software (the SaaS products tracked in the workspace)
  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position, created_by)
    values (p_workspace, p_project, 'software', 'Software', 'Software', 'AppWindow', 'text-cyan-500', true, 'name', 5, p_user)
    returning id into oid;
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Name', 'text', true, true, 0),
    (p_workspace, p_project, oid, 'url', 'URL', 'url', false, false, 1),
    (p_workspace, p_project, oid, 'stack', 'Stack', 'text', false, false, 2),
    (p_workspace, p_project, oid, 'status', 'Status', 'select',
      '[{"value":"live","label":"Live","color":"#10b981"},{"value":"building","label":"Building","color":"#f59e0b"},{"value":"sunset","label":"Sunset","color":"#64748b"}]',
      false, false, 3);

  -- A default "table" view per object.
  insert into public.crm_views (workspace_id, project_id, object_id, name, kind, is_default, position, created_by)
    select p_workspace, p_project, o.id, 'All ' || coalesce(o.label_plural, o.label), 'table', true, 0, p_user
    from public.crm_objects o where o.project_id = p_project;
end $$;
