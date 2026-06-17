-- Supply Chain & Logistics — advanced layer: warehouses, lot/FEFO batches,
-- stock movements & cycle counts, sales orders (OMS) + RMA, shipment carbon &
-- delay risk, and a control-tower exceptions table.

-- ── Inventory: safety stock + warehouse + FEFO support ────────────────────────
alter table public.sc_inventory_items
  add column if not exists safety_stock numeric not null default 0,
  add column if not exists warehouse_id uuid;

create table if not exists public.sc_warehouses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  code text,
  country text,
  city text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Lot / batch tracking with expiry (FEFO) + serial.
create table if not exists public.sc_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  item_id uuid not null references public.sc_inventory_items(id) on delete cascade,
  warehouse_id uuid references public.sc_warehouses(id) on delete set null,
  lot_code text not null,
  serial text,
  quantity numeric not null default 0,
  expiry_date date,
  received_at date,
  created_at timestamptz not null default now()
);
create index if not exists idx_sc_batches_item on public.sc_batches(item_id);
create index if not exists idx_sc_batches_expiry on public.sc_batches(expiry_date);

-- Stock movements + cycle counts (audit trail of quantity changes).
create table if not exists public.sc_stock_movements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  item_id uuid not null references public.sc_inventory_items(id) on delete cascade,
  batch_id uuid references public.sc_batches(id) on delete set null,
  kind text not null default 'adjustment'
    check (kind in ('receipt','issue','transfer','adjustment','cycle_count')),
  quantity_delta numeric not null default 0,   -- signed
  reason text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_sc_moves_item on public.sc_stock_movements(item_id, created_at);

-- ── OMS: sales orders + lines + returns (RMA) ─────────────────────────────────
create table if not exists public.sc_sales_orders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  reference text not null,
  customer text,
  status text not null default 'pending'
    check (status in ('pending','allocated','backordered','picking','shipped','delivered','cancelled')),
  currency text not null default 'eur',
  total_cents int not null default 0,
  promised_at date,                 -- promised delivery date (for OTIF)
  shipped_at timestamptz,
  delivered_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sc_so_project on public.sc_sales_orders(project_id);

create table if not exists public.sc_sales_order_lines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  order_id uuid not null references public.sc_sales_orders(id) on delete cascade,
  item_id uuid references public.sc_inventory_items(id) on delete set null,
  description text not null,
  quantity numeric not null default 1,
  allocated numeric not null default 0,    -- how much stock is reserved
  unit_price_cents int not null default 0
);
create index if not exists idx_sc_so_lines_order on public.sc_sales_order_lines(order_id);

create table if not exists public.sc_returns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  reference text not null,
  order_id uuid references public.sc_sales_orders(id) on delete set null,
  item_id uuid references public.sc_inventory_items(id) on delete set null,
  quantity numeric not null default 1,
  reason text,
  status text not null default 'requested'
    check (status in ('requested','approved','received','refunded','rejected')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_sc_returns_project on public.sc_returns(project_id);

-- ── Shipments: carbon footprint + delay risk (EU CSRD-lite) ───────────────────
alter table public.sc_shipments
  add column if not exists carbon_kg numeric not null default 0,
  add column if not exists delay_risk text;   -- low | medium | high

-- ── Control-tower exceptions (managed-by-exception feed) ──────────────────────
create table if not exists public.sc_exceptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null,                 -- stockout | overdue_po | shipment_delay | expiry | backorder | return
  severity text not null default 'medium' check (severity in ('low','medium','high')),
  title text not null,
  detail text,
  entity_kind text,                   -- item | purchase_order | shipment | sales_order | return
  entity_id uuid,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_sc_exceptions_project on public.sc_exceptions(project_id, resolved);

-- RLS — workspace members.
do $$
declare t text;
begin
  foreach t in array array[
    'sc_warehouses','sc_batches','sc_stock_movements','sc_sales_orders',
    'sc_sales_order_lines','sc_returns','sc_exceptions'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "m read %1$s" on public.%1$s;', t);
    execute format($f$create policy "m read %1$s" on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
    execute format('drop policy if exists "m write %1$s" on public.%1$s;', t);
    execute format($f$create policy "m write %1$s" on public.%1$s for insert
      with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
    execute format('drop policy if exists "m update %1$s" on public.%1$s;', t);
    execute format($f$create policy "m update %1$s" on public.%1$s for update
      using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
    execute format('drop policy if exists "m delete %1$s" on public.%1$s;', t);
    execute format($f$create policy "m delete %1$s" on public.%1$s for delete
      using (exists (select 1 from public.workspace_members wm where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));$f$, t);
  end loop;
end $$;

alter publication supabase_realtime add table public.sc_exceptions;
