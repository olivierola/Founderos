-- Fix: revenue_records lacked a unique constraint, so the upsert in
-- sync-stripe-data (onConflict project_id,provider,external_id) failed and
-- no revenue rows were ever written. De-duplicate then add the constraint.

-- Remove any duplicate (project_id, provider, external_id) keeping the earliest row.
delete from public.revenue_records a
using public.revenue_records b
where a.ctid > b.ctid
  and a.project_id is not distinct from b.project_id
  and a.provider is not distinct from b.provider
  and a.external_id is not distinct from b.external_id;

alter table public.revenue_records
  add constraint revenue_records_project_provider_external_key
  unique (project_id, provider, external_id);
