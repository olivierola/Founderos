-- Add a "Dashboards" system object to the CRM object set (matches the essential
-- objects: Companies, People, Opportunities, Tasks, Notes, Dashboards, Software).
-- Updates the seeder for new projects AND backfills already-seeded projects.

-- 1) Backfill: add a Dashboards object (+ default props + view) to every project
--    that already has CRM objects but no 'dashboards' object yet.
do $$
declare r record; oid uuid;
begin
  for r in
    select distinct o.workspace_id, o.project_id
    from public.crm_objects o
    where not exists (
      select 1 from public.crm_objects d
      where d.project_id = o.project_id and d.slug = 'dashboards'
    )
  loop
    insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position)
      values (r.workspace_id, r.project_id, 'dashboards', 'Dashboard', 'Dashboards', 'LayoutDashboard', 'text-indigo-500', true, 'name', 6)
      returning id into oid;
    insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, is_title, is_system, position) values
      (r.workspace_id, r.project_id, oid, 'name', 'Title', 'text', true, true, 0),
      (r.workspace_id, r.project_id, oid, 'description', 'Description', 'long_text', false, false, 1);
    insert into public.crm_views (workspace_id, project_id, object_id, name, kind, is_default, position)
      values (r.workspace_id, r.project_id, oid, 'All Dashboards', 'table', true, 0);
  end loop;
end $$;

-- 2) Update the seeder so future projects get Dashboards too. (Full redefinition.)
create or replace function public.crm_seed_project(p_workspace uuid, p_project uuid, p_user uuid default null)
returns void language plpgsql security definer as $$
declare oid uuid;
begin
  if exists (select 1 from public.crm_objects where project_id = p_project) then
    return;
  end if;

  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position, created_by)
    values (p_workspace, p_project, 'people', 'Person', 'People', 'Users', 'text-violet-500', true, 'name', 0, p_user) returning id into oid;
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Name', 'text', true, true, 0),
    (p_workspace, p_project, oid, 'email', 'Email', 'email', false, true, 1),
    (p_workspace, p_project, oid, 'phone', 'Phone', 'phone', false, false, 2),
    (p_workspace, p_project, oid, 'job_title', 'Job Title', 'text', false, false, 3),
    (p_workspace, p_project, oid, 'linkedin', 'LinkedIn', 'url', false, false, 4);

  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position, created_by)
    values (p_workspace, p_project, 'companies', 'Company', 'Companies', 'Building2', 'text-blue-500', true, 'name', 1, p_user) returning id into oid;
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Name', 'text', true, true, 0),
    (p_workspace, p_project, oid, 'domain', 'Domain', 'url', false, false, 1),
    (p_workspace, p_project, oid, 'employees', 'Employees', 'number', false, false, 2),
    (p_workspace, p_project, oid, 'industry', 'Industry', 'text', false, false, 3);

  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position, created_by)
    values (p_workspace, p_project, 'opportunities', 'Opportunity', 'Opportunities', 'Target', 'text-rose-500', true, 'name', 2, p_user) returning id into oid;
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, options, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Name', 'text', '[]', true, true, 0),
    (p_workspace, p_project, oid, 'amount', 'Amount', 'currency', '[]', false, false, 1),
    (p_workspace, p_project, oid, 'stage', 'Stage', 'select',
      '[{"value":"new","label":"New","color":"#64748b"},{"value":"qualified","label":"Qualified","color":"#3b82f6"},{"value":"proposal","label":"Proposal","color":"#a855f7"},{"value":"won","label":"Won","color":"#10b981"},{"value":"lost","label":"Lost","color":"#ef4444"}]', false, false, 2),
    (p_workspace, p_project, oid, 'close_date', 'Close date', 'date', '[]', false, false, 3);

  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position, created_by)
    values (p_workspace, p_project, 'tasks', 'Task', 'Tasks', 'CheckSquare', 'text-emerald-500', true, 'name', 3, p_user) returning id into oid;
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, options, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Title', 'text', '[]', true, true, 0),
    (p_workspace, p_project, oid, 'done', 'Done', 'checkbox', '[]', false, false, 1),
    (p_workspace, p_project, oid, 'due', 'Due', 'date', '[]', false, false, 2),
    (p_workspace, p_project, oid, 'priority', 'Priority', 'select',
      '[{"value":"low","label":"Low","color":"#64748b"},{"value":"medium","label":"Medium","color":"#f59e0b"},{"value":"high","label":"High","color":"#ef4444"}]', false, false, 3);

  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position, created_by)
    values (p_workspace, p_project, 'notes', 'Note', 'Notes', 'StickyNote', 'text-amber-500', true, 'name', 4, p_user) returning id into oid;
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Title', 'text', true, true, 0),
    (p_workspace, p_project, oid, 'body', 'Body', 'long_text', false, false, 1);

  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position, created_by)
    values (p_workspace, p_project, 'dashboards', 'Dashboard', 'Dashboards', 'LayoutDashboard', 'text-indigo-500', true, 'name', 5, p_user) returning id into oid;
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Title', 'text', true, true, 0),
    (p_workspace, p_project, oid, 'description', 'Description', 'long_text', false, false, 1);

  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color, is_system, title_property, position, created_by)
    values (p_workspace, p_project, 'software', 'Software', 'Software', 'AppWindow', 'text-cyan-500', true, 'name', 6, p_user) returning id into oid;
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Name', 'text', true, true, 0),
    (p_workspace, p_project, oid, 'url', 'URL', 'url', false, false, 1),
    (p_workspace, p_project, oid, 'stack', 'Stack', 'text', false, false, 2),
    (p_workspace, p_project, oid, 'status', 'Status', 'select',
      '[{"value":"live","label":"Live","color":"#10b981"},{"value":"building","label":"Building","color":"#f59e0b"},{"value":"sunset","label":"Sunset","color":"#64748b"}]', false, false, 3);

  insert into public.crm_views (workspace_id, project_id, object_id, name, kind, is_default, position, created_by)
    select p_workspace, p_project, o.id, 'All ' || coalesce(o.label_plural, o.label), 'table', true, 0, p_user
    from public.crm_objects o where o.project_id = p_project;
end $$;
