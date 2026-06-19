-- Extend crm_add_from_catalog: also create relation properties (from
-- crm_source_relations) and backfill their links from real FKs. Attach
-- forward-sync triggers for the newly added source tables.

-- Correct the whiteboards source table name (real table = project_whiteboards).
update public.crm_source_catalog set source_table = 'project_whiteboards'
  where slug = 'whiteboards' and source_table = 'whiteboards';
update public.crm_objects set source_table = 'project_whiteboards'
  where slug = 'whiteboards' and source_table = 'whiteboards';

create or replace function public.crm_add_from_catalog(p_workspace uuid, p_project uuid, p_slug text, p_user uuid default null)
returns uuid language plpgsql security definer as $$
declare
  c record; oid uuid; npos int; rel record; tgt_obj_id uuid; other record;
  v_cols text; v_sql text;
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

  -- Relation properties (pointing at the target object if it's instantiated).
  for rel in select * from public.crm_source_relations where object_slug = c.slug loop
    select id into tgt_obj_id from public.crm_objects where project_id = p_project and slug = rel.target_slug;
    insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, relation_object_id, is_system, position)
      values (p_workspace, p_project, oid, rel.key, rel.label, 'relation', tgt_obj_id, true, rel.position);
  end loop;

  insert into public.crm_views (workspace_id, project_id, object_id, name, kind, is_default, position, created_by)
    values (p_workspace, p_project, oid, 'All ' || c.label_plural, 'table', true, 0, p_user);

  -- Backfill scalar values (title + mapped columns) in one pass.
  v_cols := format('jsonb_build_object(%L, src.%I::text', 'name', c.title_col);
  select v_cols || coalesce(string_agg(format(', %L, src.%I::text', key, source_col), ''), '')
    into v_cols from public.crm_source_props where object_slug = c.slug;
  v_cols := v_cols || ')';
  v_sql := format(
    'insert into public.crm_records (workspace_id, project_id, object_id, source_id, data)
       select %L, %L, %L, src.id, %s from public.%I src
       where src.project_id = %L
         and not exists (select 1 from public.crm_records er where er.object_id = %L and er.source_id = src.id)',
    p_workspace, p_project, oid, v_cols, c.source_table, p_project, oid);
  execute v_sql;

  -- Auto-fill this object's relation links from real FKs.
  perform public.crm_link_relations(oid);

  -- Also (re)link OTHER already-instantiated objects whose relations point AT
  -- this new class (e.g. Tasks added before Projects).
  for other in
    select distinct o.id from public.crm_objects o
    join public.crm_source_relations r on r.object_slug = o.slug
    where o.project_id = p_project and r.target_slug = c.slug
  loop
    perform public.crm_link_relations(other.id);
    -- Point their relation property at this new target object too.
    update public.crm_properties pr set relation_object_id = oid
    from public.crm_source_relations r
    where pr.object_id = other.id and pr.key = r.key
      and r.object_slug = (select slug from public.crm_objects where id = other.id)
      and r.target_slug = c.slug and pr.relation_object_id is null;
  end loop;

  return oid;
end $$;

-- Attach forward-sync triggers for all catalog source tables (incl. new ones).
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
