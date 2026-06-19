-- Fix: crm_add_from_catalog backfill used `($1).col` against a `record` produced
-- by a dynamic `select *`, which PostgreSQL can't introspect →
-- "could not identify column ... in record data type". Build the jsonb directly
-- in SQL with to_jsonb + jsonb_object_agg over the mapped columns instead.

create or replace function public.crm_add_from_catalog(p_workspace uuid, p_project uuid, p_slug text, p_user uuid default null)
returns uuid language plpgsql security definer as $$
declare
  c record; oid uuid; npos int;
  v_cols text;     -- "jsonb_build_object('name', t.title_col, 'key', t.src_col, …)"
  v_sql text;
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
  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, options, is_system, position)
    select p_workspace, p_project, oid, csp.key, csp.label, csp.type, csp.options, true, csp.position
    from public.crm_source_props csp where csp.object_slug = c.slug;

  insert into public.crm_views (workspace_id, project_id, object_id, name, kind, is_default, position, created_by)
    values (p_workspace, p_project, oid, 'All ' || c.label_plural, 'table', true, 0, p_user);

  -- Build the jsonb expression: title + each mapped column (referenced by name
  -- in the SQL so the planner knows the columns).
  v_cols := format('jsonb_build_object(%L, src.%I::text', 'name', c.title_col);
  select v_cols || coalesce(string_agg(format(', %L, src.%I::text', key, source_col), ''), '')
    into v_cols
    from public.crm_source_props where object_slug = c.slug;
  v_cols := v_cols || ')';

  v_sql := format(
    'insert into public.crm_records (workspace_id, project_id, object_id, source_id, data)
       select %L, %L, %L, src.id, %s
       from public.%I src
       where src.project_id = %L
         and not exists (select 1 from public.crm_records er where er.object_id = %L and er.source_id = src.id)',
    p_workspace, p_project, oid, v_cols, c.source_table, p_project, oid);
  execute v_sql;

  return oid;
end $$;
