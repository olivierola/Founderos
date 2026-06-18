-- Sync system objects to the real tables: mark provenance via source_table and
-- backfill existing rows (crm_contacts → People, crm_deals → Opportunities) into
-- crm_records so the new object CRM shows real data. Idempotent (skips rows that
-- already have a matching crm_record by source_id).

-- 1) Provenance: point the system objects at their source tables.
update public.crm_objects set source_table = 'crm_contacts' where slug = 'people' and source_table is null;
update public.crm_objects set source_table = 'crm_deals'    where slug = 'opportunities' and source_table is null;

-- 2) Backfill People from crm_contacts.
do $$
declare r record; oid uuid;
begin
  for r in
    select o.id as object_id, o.workspace_id, o.project_id
    from public.crm_objects o where o.slug = 'people'
  loop
    insert into public.crm_records (workspace_id, project_id, object_id, source_id, data, created_at)
    select c.workspace_id, c.project_id, r.object_id, c.id,
           jsonb_strip_nulls(jsonb_build_object(
             'name', c.full_name,
             'email', c.email,
             'phone', c.phone,
             'job_title', c.title
           )),
           c.created_at
    from public.crm_contacts c
    where c.project_id = r.project_id
      and not exists (
        select 1 from public.crm_records er
        where er.object_id = r.object_id and er.source_id = c.id
      );
  end loop;
end $$;

-- 3) Backfill Opportunities from crm_deals.
do $$
declare r record;
begin
  for r in
    select o.id as object_id, o.workspace_id, o.project_id
    from public.crm_objects o where o.slug = 'opportunities'
  loop
    insert into public.crm_records (workspace_id, project_id, object_id, source_id, data, created_at)
    select d.workspace_id, d.project_id, r.object_id, d.id,
           jsonb_strip_nulls(jsonb_build_object(
             'name', d.title,
             'amount', (d.amount_cents::numeric / 100.0),
             'stage', d.stage,
             'close_date', to_char(d.expected_close, 'YYYY-MM-DD')
           )),
           d.created_at
    from public.crm_deals d
    where d.project_id = r.project_id
      and not exists (
        select 1 from public.crm_records er
        where er.object_id = r.object_id and er.source_id = d.id
      );
  end loop;
end $$;
