-- "Everything is an object" — wave 3: HR (candidates, job openings, onboardings)
-- + PSA (resources). Timesheets/allocations are skipped (no natural title col);
-- hr_leaves does not exist.

insert into public.crm_source_catalog (slug, source_table, title_col, label, label_plural, icon, color) values
  ('candidates',   'hr_candidates',   'full_name', 'Candidate',   'Candidates',   'UserPlus', 'text-teal-500'),
  ('job_openings', 'hr_job_openings', 'title',     'Job opening', 'Job openings', 'Briefcase','text-teal-500'),
  ('onboardings',  'hr_onboardings',  'name',      'Onboarding',  'Onboardings',  'UserPlus', 'text-teal-500'),
  ('resources',    'psa_resources',   'name',      'Resource',    'Resources',    'Users',    'text-blue-500')
on conflict (slug) do nothing;

insert into public.crm_source_props (object_slug, key, source_col, label, type, options, position, writable) values
  ('job_openings', 'status', 'status', 'Status', 'select',
    '[{"value":"draft","label":"Draft","color":"#64748b"},{"value":"open","label":"Open","color":"#10b981"},{"value":"paused","label":"Paused","color":"#f59e0b"},{"value":"closed","label":"Closed","color":"#64748b"}]', 1, true),
  ('onboardings', 'status', 'status', 'Status', 'select',
    '[{"value":"preboarding","label":"Preboarding","color":"#3b82f6"},{"value":"active","label":"Active","color":"#10b981"},{"value":"complete","label":"Complete","color":"#64748b"},{"value":"stalled","label":"Stalled","color":"#ef4444"}]', 1, true)
on conflict (object_slug, key) do nothing;

insert into public.crm_source_relations (object_slug, key, label, source_fk_col, target_slug, position) values
  ('candidates',  'opening',  'Job opening', 'opening_id',   'job_openings', 5),
  ('onboardings', 'employee', 'Team member', 'employee_id',  'employees',    5),
  ('onboardings', 'candidate','Candidate',   'candidate_id', 'candidates',   6)
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
