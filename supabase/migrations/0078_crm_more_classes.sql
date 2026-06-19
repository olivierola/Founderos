-- More module classes (Projects, Tasks, Employees, Whiteboards, Inventory,
-- Suppliers) + relation attributes auto-filled from the real foreign keys
-- (Task→Project, Opportunity→Person, Good→Supplier, Employee→Manager).

-- ── New synced classes ────────────────────────────────────────────────────────
insert into public.crm_source_catalog (slug, source_table, title_col, label, label_plural, icon, color) values
  ('projects',   'pm_projects',        'name', 'Project',    'Projects',    'FolderKanban', 'text-blue-500'),
  ('tasks_pm',   'pm_tasks',           'title','Task',       'Tasks',       'CheckSquare',  'text-emerald-500'),
  ('employees',  'hr_employees',       'full_name', 'Team member', 'Team members', 'Users', 'text-teal-500'),
  ('whiteboards','project_whiteboards','title','Whiteboard', 'Whiteboards', 'PenSquare',    'text-orange-500'),
  ('inventory',  'sc_inventory_items', 'name', 'Good',       'Inventory',   'Package',      'text-amber-600'),
  ('suppliers',  'sc_suppliers',       'name', 'Supplier',   'Suppliers',   'Truck',        'text-orange-500')
on conflict (slug) do nothing;

-- Mapped scalar props for the new classes.
insert into public.crm_source_props (object_slug, key, source_col, label, type, options, position, writable) values
  ('projects', 'status', 'status', 'Status', 'select',
    '[{"value":"planning","label":"Planning","color":"#64748b"},{"value":"active","label":"Active","color":"#10b981"},{"value":"on_hold","label":"On hold","color":"#f59e0b"},{"value":"done","label":"Done","color":"#3b82f6"},{"value":"archived","label":"Archived","color":"#64748b"}]', 1, true),
  ('tasks_pm', 'status', 'column_key', 'Status', 'select',
    '[{"value":"backlog","label":"Backlog","color":"#64748b"},{"value":"todo","label":"To do","color":"#64748b"},{"value":"in_progress","label":"In progress","color":"#f59e0b"},{"value":"review","label":"Review","color":"#a855f7"},{"value":"done","label":"Done","color":"#10b981"}]', 1, true),
  ('employees', 'status', 'status', 'Status', 'select',
    '[{"value":"active","label":"Active","color":"#10b981"},{"value":"on_leave","label":"On leave","color":"#f59e0b"},{"value":"terminated","label":"Terminated","color":"#ef4444"},{"value":"candidate","label":"Candidate","color":"#3b82f6"}]', 1, true),
  ('inventory', 'quantity', 'quantity', 'Quantity', 'number', '[]', 1, true),
  ('suppliers', 'status', 'status', 'Status', 'select',
    '[{"value":"active","label":"Active","color":"#10b981"},{"value":"paused","label":"Paused","color":"#f59e0b"},{"value":"blocked","label":"Blocked","color":"#ef4444"}]', 1, true)
on conflict (object_slug, key) do nothing;

-- ── Relation registry: a relation property auto-filled from a real FK column ──
-- key=property key, source_fk_col=column on this class's source table holding the
-- target row id, target_slug=which catalog class the FK points at.
create table if not exists public.crm_source_relations (
  id uuid primary key default gen_random_uuid(),
  object_slug text not null references public.crm_source_catalog(slug) on delete cascade,
  key text not null,
  label text not null,
  source_fk_col text not null,
  target_slug text not null,
  position int not null default 5,
  unique (object_slug, key)
);
insert into public.crm_source_relations (object_slug, key, label, source_fk_col, target_slug, position) values
  ('tasks_pm',      'project',  'Project',  'board_id',    'projects',  5),
  ('opportunities', 'contact',  'Contact',  'contact_id',  'people',    5),
  ('inventory',     'supplier', 'Supplier', 'supplier_id', 'suppliers', 5),
  ('employees',     'manager',  'Manager',  'manager_id',  'employees', 5)
on conflict (object_slug, key) do nothing;

-- ── Helper: (re)build relation links for one object from its source FKs ───────
-- For every record of p_object_id whose source row has a non-null FK, link it to
-- the target object's record (matched by source_id). Skips if the target class
-- isn't instantiated in the project. Idempotent.
create or replace function public.crm_link_relations(p_object_id uuid)
returns void language plpgsql security definer as $$
declare
  o record; rel record; tgt_obj_id uuid; prop_id uuid;
begin
  select id, workspace_id, project_id, slug, source_table into o
  from public.crm_objects where id = p_object_id;
  if o.slug is null then return; end if;

  for rel in select * from public.crm_source_relations where object_slug = o.slug loop
    -- The relation property on this object (created at instantiate).
    select id into prop_id from public.crm_properties
      where object_id = p_object_id and key = rel.key and type = 'relation';
    -- The target object instance in this project.
    select id into tgt_obj_id from public.crm_objects
      where project_id = o.project_id and slug = rel.target_slug;
    if prop_id is null or tgt_obj_id is null then continue; end if;

    -- Insert links: from this object's record → target record, matched via the
    -- source FK = target record's source_id.
    execute format(
      'insert into public.crm_record_links (workspace_id, project_id, property_id, from_record_id, to_record_id)
       select %L, %L, %L, fr.id, tr.id
       from public.crm_records fr
       join public.%I src on src.id = fr.source_id
       join public.crm_records tr on tr.object_id = %L and tr.source_id = src.%I
       where fr.object_id = %L and src.%I is not null
       on conflict (property_id, from_record_id, to_record_id) do nothing',
      o.workspace_id, o.project_id, prop_id, o.source_table, tgt_obj_id, rel.source_fk_col, p_object_id, rel.source_fk_col);
  end loop;
end $$;
