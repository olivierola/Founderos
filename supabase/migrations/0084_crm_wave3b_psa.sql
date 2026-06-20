-- Wave 3b — complete PSA in the CRM object system: Timesheets and Allocations.
-- These tables have no natural title column, so we add a generated title column
-- (crm_title) derived from their fields, then register them like any other class.

-- ── Generated title columns ───────────────────────────────────────────────────
-- NB: generated expressions must be IMMUTABLE. to_char(date,…) is STABLE and
-- date::text depends on DateStyle (also STABLE), so build YYYY-MM-DD from the
-- IMMUTABLE extract() of the date parts.
create or replace function public.crm_date_iso(d date)
returns text language sql immutable as $$
  select lpad(extract(year from d)::int::text, 4, '0') || '-'
      || lpad(extract(month from d)::int::text, 2, '0') || '-'
      || lpad(extract(day from d)::int::text, 2, '0')
$$;

alter table public.psa_timesheets
  add column if not exists crm_title text
  generated always as (public.crm_date_iso(work_date) || ' · ' || round(hours, 2)::text || 'h') stored;

alter table public.psa_allocations
  add column if not exists crm_title text
  generated always as ('Week of ' || public.crm_date_iso(week_start) || ' · ' || round(hours, 2)::text || 'h') stored;

-- ── Classes ───────────────────────────────────────────────────────────────────
insert into public.crm_source_catalog (slug, source_table, title_col, label, label_plural, icon, color) values
  ('timesheets',  'psa_timesheets',  'crm_title', 'Timesheet',  'Timesheets',  'Clock',    'text-blue-500'),
  ('allocations', 'psa_allocations', 'crm_title', 'Allocation', 'Allocations', 'Calendar', 'text-blue-500')
on conflict (slug) do nothing;

insert into public.crm_source_props (object_slug, key, source_col, label, type, options, position, writable) values
  ('timesheets', 'hours', 'hours', 'Hours', 'number', '[]', 1, true),
  ('timesheets', 'billable', 'billable', 'Billable', 'checkbox', '[]', 2, true),
  ('timesheets', 'status', 'status', 'Status', 'select',
    '[{"value":"draft","label":"Draft","color":"#64748b"},{"value":"submitted","label":"Submitted","color":"#3b82f6"},{"value":"approved","label":"Approved","color":"#10b981"},{"value":"rejected","label":"Rejected","color":"#ef4444"},{"value":"billed","label":"Billed","color":"#a855f7"}]', 3, true),
  ('allocations', 'hours', 'hours', 'Hours', 'number', '[]', 1, true),
  ('allocations', 'kind', 'kind', 'Type', 'select',
    '[{"value":"firm","label":"Firm","color":"#10b981"},{"value":"soft","label":"Pipeline","color":"#f59e0b"}]', 2, true)
on conflict (object_slug, key) do nothing;

insert into public.crm_source_relations (object_slug, key, label, source_fk_col, target_slug, position) values
  ('timesheets',  'resource', 'Resource', 'resource_id',   'resources', 5),
  ('timesheets',  'project',  'Project',  'pm_project_id', 'projects',  6),
  ('timesheets',  'task',     'Task',     'task_id',       'tasks_pm',  7),
  ('allocations', 'resource', 'Resource', 'resource_id',   'resources', 5),
  ('allocations', 'project',  'Project',  'pm_project_id', 'projects',  6)
on conflict (object_slug, key) do nothing;

do $$
declare c record;
begin
  for c in select distinct source_table, title_col, slug from public.crm_source_catalog loop
    execute format('drop trigger if exists trg_crm_sync_%1$s on public.%2$I', c.slug, c.source_table);
    execute format(
      'create trigger trg_crm_sync_%1$s after insert or update or delete on public.%2$I
       for each row execute function public.crm_sync_from_source(%3$L)',
      c.slug, c.source_table, c.title_col);
  end loop;
end $$;
