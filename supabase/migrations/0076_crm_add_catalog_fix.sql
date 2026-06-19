-- Fix: in crm_add_from_catalog the "insert ... select ... from crm_source_props sp"
-- used the alias `sp`, which collides with the declared record variable `sp`
-- → "record sp is not assigned yet". Use a distinct table alias (csp).

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
  -- Mapped properties from the registry (alias csp avoids the `sp` variable clash).
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, options, is_system, position)
    select p_workspace, p_project, oid, csp.key, csp.label, csp.type, csp.options, true, csp.position
    from public.crm_source_props csp where csp.object_slug = c.slug;

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
