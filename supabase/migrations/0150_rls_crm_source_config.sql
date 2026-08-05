-- RLS audit remediation — the only 3 public tables that never had RLS enabled.
--
-- Audit result (2026-08): of 236 tables, 233 enable RLS (many via the dynamic
-- `foreach t in array[...] execute 'alter table ... enable row level security'`
-- loops, which a naive grep misses). These three slipped through:
--   crm_source_catalog, crm_source_props, crm_source_relations
--
-- They are GLOBAL, non-tenant CONFIGURATION: the mapping of legacy business
-- tables into the CRM object system (slug → source_table, property defs,
-- relation defs). Identical for every workspace, seeded in migrations 0074/
-- 0075/0078, and never written at runtime. So the risk was NOT cross-workspace
-- data leakage (there is no tenant data here) — it was WRITE exposure: with RLS
-- off, any holder of the anon key could INSERT/UPDATE/DELETE these rows through
-- PostgREST and corrupt the CRM mapping for everyone.
--
-- Fix: enable RLS and allow read to all (the rows are non-sensitive global
-- config the frontend mirrors as constants), with NO write policy — so API
-- roles (anon/authenticated) can't mutate them, while service_role and the
-- SECURITY DEFINER sync functions keep working (both bypass RLS).

alter table public.crm_source_catalog   enable row level security;
alter table public.crm_source_props      enable row level security;
alter table public.crm_source_relations  enable row level security;

drop policy if exists "crm_source_catalog readable" on public.crm_source_catalog;
create policy "crm_source_catalog readable"
  on public.crm_source_catalog for select using (true);

drop policy if exists "crm_source_props readable" on public.crm_source_props;
create policy "crm_source_props readable"
  on public.crm_source_props for select using (true);

drop policy if exists "crm_source_relations readable" on public.crm_source_relations;
create policy "crm_source_relations readable"
  on public.crm_source_relations for select using (true);
