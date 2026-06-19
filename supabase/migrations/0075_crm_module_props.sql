-- Multi-column live sync for module object classes + the Missions class.
-- 0074 synced only the title. Here each synced class declares several default
-- properties mapped to real source columns (crm_source_props), and the sync
-- triggers mirror ALL mapped columns both ways.

-- ── Add the Missions class (unified: agent + employee assignees) ──────────────
insert into public.crm_source_catalog (slug, source_table, title_col, label, label_plural, icon, color) values
  ('missions', 'internal_agent_missions', 'title', 'Mission', 'Missions', 'Target', 'text-amber-500')
on conflict (slug) do nothing;

-- ── Registry of mapped properties per class (beyond the title) ────────────────
create table if not exists public.crm_source_props (
  id uuid primary key default gen_random_uuid(),
  object_slug text not null references public.crm_source_catalog(slug) on delete cascade,
  key text not null,                     -- json key in crm_records.data
  source_col text not null,              -- column on the source table
  label text not null,
  type text not null default 'text',
  options jsonb not null default '[]'::jsonb,
  position int not null default 1,
  writable boolean not null default false,  -- reverse-sync this column on edit
  unique (object_slug, key)
);

insert into public.crm_source_props (object_slug, key, source_col, label, type, options, position, writable) values
  -- Autonomous agents
  ('autonomous_agents', 'description', 'description', 'Description', 'long_text', '[]', 1, true),
  ('autonomous_agents', 'model', 'model', 'Model', 'select',
    '[{"value":"groq","label":"Groq","color":"#f59e0b"},{"value":"deepseek","label":"DeepSeek","color":"#3b82f6"}]', 2, true),
  ('autonomous_agents', 'archived', 'is_archived', 'Archived', 'checkbox', '[]', 3, false),
  -- Public agents
  ('public_agents', 'description', 'description', 'Description', 'long_text', '[]', 1, true),
  ('public_agents', 'model', 'model', 'Model', 'text', '[]', 2, true),
  ('public_agents', 'enabled', 'enabled', 'Enabled', 'checkbox', '[]', 3, true),
  -- Documents
  ('documents', 'kind', 'kind', 'Type', 'select',
    '[{"value":"document","label":"Document","color":"#3b82f6"},{"value":"spreadsheet","label":"Spreadsheet","color":"#10b981"},{"value":"presentation","label":"Presentation","color":"#a855f7"}]', 1, false),
  -- Simulations
  ('simulations', 'status', 'status', 'Status', 'select',
    '[{"value":"draft","label":"Draft","color":"#64748b"},{"value":"running","label":"Running","color":"#f59e0b"},{"value":"done","label":"Done","color":"#10b981"}]', 1, false),
  -- Missions
  ('missions', 'brief', 'brief', 'Brief', 'long_text', '[]', 1, true),
  ('missions', 'status', 'status', 'Status', 'select',
    '[{"value":"draft","label":"Draft","color":"#64748b"},{"value":"active","label":"Active","color":"#10b981"},{"value":"archived","label":"Archived","color":"#64748b"}]', 2, true)
on conflict (object_slug, key) do nothing;

-- ── Forward sync: mirror ALL mapped columns (title + crm_source_props) ────────
create or replace function public.crm_sync_from_source()
returns trigger language plpgsql security definer as $$
declare
  v_title_col text := tg_argv[0];
  v_slug text;
  v_obj record;
  v_data jsonb;
  v_val text;
  p record;
begin
  if current_setting('crm.syncing', true) = '1' then return coalesce(new, old); end if;

  if (tg_op = 'DELETE') then
    delete from public.crm_records r using public.crm_objects o
      where r.object_id = o.id and o.source_table = tg_table_name and r.source_id = old.id;
    return old;
  end if;

  select slug into v_slug from public.crm_source_catalog where source_table = tg_table_name limit 1;

  -- Build the data jsonb from the title + each mapped property.
  execute format('select ($1).%I::text', v_title_col) into v_val using new;
  v_data := jsonb_build_object('name', v_val);
  for p in select key, source_col from public.crm_source_props where object_slug = v_slug loop
    execute format('select ($1).%I::text', p.source_col) into v_val using new;
    v_data := v_data || jsonb_build_object(p.key, v_val);
  end loop;

  for v_obj in
    select id, workspace_id, project_id from public.crm_objects
    where source_table = tg_table_name and project_id = new.project_id
  loop
    perform set_config('crm.syncing', '1', true);
    if exists (select 1 from public.crm_records where object_id = v_obj.id and source_id = new.id) then
      update public.crm_records set data = coalesce(data, '{}'::jsonb) || v_data, updated_at = now()
        where object_id = v_obj.id and source_id = new.id;
    else
      insert into public.crm_records (workspace_id, project_id, object_id, source_id, data)
        values (v_obj.workspace_id, v_obj.project_id, v_obj.id, new.id, v_data);
    end if;
    perform set_config('crm.syncing', '0', true);
  end loop;
  return new;
end $$;

-- ── Reverse sync: write back the title + every WRITABLE mapped column ─────────
create or replace function public.crm_sync_to_source()
returns trigger language plpgsql security definer as $$
declare
  v_obj record; v_slug text; p record; v_val text;
  v_sets text := '';
begin
  if current_setting('crm.syncing', true) = '1' then return new; end if;
  if new.source_id is null then return new; end if;

  select source_table, source_title_col, slug into v_obj
  from public.crm_objects where id = new.object_id;
  if v_obj.source_table is null then return new; end if;

  -- Title column.
  if v_obj.source_title_col is not null and (new.data ? 'name') then
    v_sets := format('%I = %L', v_obj.source_title_col, new.data->>'name');
  end if;
  -- Writable mapped columns.
  for p in select key, source_col, type from public.crm_source_props where object_slug = v_obj.slug and writable loop
    if new.data ? p.key then
      v_val := new.data->>p.key;
      if p.type = 'checkbox' then
        v_sets := v_sets || case when v_sets = '' then '' else ', ' end || format('%I = %L', p.source_col, (v_val = 'true'));
      else
        v_sets := v_sets || case when v_sets = '' then '' else ', ' end || format('%I = %L', p.source_col, v_val);
      end if;
    end if;
  end loop;

  if v_sets = '' then return new; end if;
  perform set_config('crm.syncing', '1', true);
  execute format('update public.%I set %s where id = %L', v_obj.source_table, v_sets, new.source_id);
  perform set_config('crm.syncing', '0', true);
  return new;
end $$;

-- ── Extend the instantiation RPC: create mapped props + backfill all columns ──
create or replace function public.crm_add_from_catalog(p_workspace uuid, p_project uuid, p_slug text, p_user uuid default null)
returns uuid language plpgsql security definer as $$
declare c record; oid uuid; npos int; r record; sp record; v_data jsonb; v_val text;
begin
  select * into c from public.crm_source_catalog where slug = p_slug;
  if c is null then raise exception 'Unknown catalog slug %', p_slug; end if;

  select id into oid from public.crm_objects where project_id = p_project and slug = c.slug;
  if oid is not null then return oid; end if;

  select coalesce(max(position) + 1, 0) into npos from public.crm_objects where project_id = p_project;
  insert into public.crm_objects (workspace_id, project_id, slug, label, label_plural, icon, color,
                                  is_system, source_table, source_title_col, title_property, position, created_by)
    values (p_workspace, p_project, c.slug, c.label, c.label_plural, c.icon, c.color,
            true, c.source_table, c.title_col, 'name', npos, p_user)
    returning id into oid;

  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, is_title, is_system, position)
    values (p_workspace, p_project, oid, 'name', 'Name', 'text', true, true, 0);
  -- Mapped properties from the registry.
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, options, is_system, position)
    select p_workspace, p_project, oid, sp.key, sp.label, sp.type, sp.options, true, sp.position
    from public.crm_source_props sp where sp.object_slug = c.slug;

  insert into public.crm_views (workspace_id, project_id, object_id, name, kind, is_default, position, created_by)
    values (p_workspace, p_project, oid, 'All ' || c.label_plural, 'table', true, 0, p_user);

  -- Backfill existing source rows (title + mapped columns).
  for r in execute format('select * from public.%I where project_id = $1', c.source_table) using p_project
  loop
    if not exists (select 1 from public.crm_records where object_id = oid and source_id = r.id) then
      execute format('select ($1).%I::text', c.title_col) into v_val using r;
      v_data := jsonb_build_object('name', v_val);
      for sp in select key, source_col from public.crm_source_props where object_slug = c.slug loop
        execute format('select ($1).%I::text', sp.source_col) into v_val using r;
        v_data := v_data || jsonb_build_object(sp.key, v_val);
      end loop;
      insert into public.crm_records (workspace_id, project_id, object_id, source_id, data)
        values (p_workspace, p_project, oid, r.id, v_data);
    end if;
  end loop;

  return oid;
end $$;

-- ── Attach the forward-sync trigger for the new Missions source table ─────────
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
