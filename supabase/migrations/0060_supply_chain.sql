-- Supply Chain module: inventory, suppliers, purchase orders + lines, shipments.
create table if not exists public.sc_suppliers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  contact_name text,
  email text,
  phone text,
  country text,
  lead_time_days int not null default 7,
  reliability int not null default 90,            -- 0..100
  status text not null default 'active' check (status in ('active','paused','blocked')),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.sc_inventory_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  sku text not null,
  name text not null,
  category text,
  unit text not null default 'unit',
  quantity numeric not null default 0,
  reorder_point numeric not null default 0,
  unit_cost_cents int not null default 0,
  currency text not null default 'eur',
  location text,
  supplier_id uuid references public.sc_suppliers(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sc_inventory_project on public.sc_inventory_items(project_id);

create table if not exists public.sc_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  reference text not null,
  supplier_id uuid references public.sc_suppliers(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','sent','confirmed','received','cancelled')),
  currency text not null default 'eur',
  total_cents int not null default 0,
  expected_at date,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sc_po_project on public.sc_purchase_orders(project_id);

create table if not exists public.sc_purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  po_id uuid not null references public.sc_purchase_orders(id) on delete cascade,
  item_id uuid references public.sc_inventory_items(id) on delete set null,
  description text not null,
  quantity numeric not null default 1,
  unit_cost_cents int not null default 0
);
create index if not exists idx_sc_po_lines_po on public.sc_purchase_order_lines(po_id);

create table if not exists public.sc_shipments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  reference text not null,
  direction text not null default 'inbound' check (direction in ('inbound','outbound')),
  carrier text,
  tracking_number text,
  po_id uuid references public.sc_purchase_orders(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','in_transit','delivered','delayed','cancelled')),
  eta date,
  delivered_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_sc_shipments_project on public.sc_shipments(project_id);

-- RLS: workspace members can read/write rows in their workspaces.
do $$
declare t text;
begin
  foreach t in array array[
    'sc_suppliers','sc_inventory_items','sc_purchase_orders','sc_purchase_order_lines','sc_shipments'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "Members read %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members read %1$s" on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members write %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members write %1$s" on public.%1$s for insert
      with check (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members update %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members update %1$s" on public.%1$s for update
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members delete %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members delete %1$s" on public.%1$s for delete
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
  end loop;
end $$;
