-- Reverse-sync must not try to UPDATE a GENERATED title column (e.g. PSA
-- timesheets/allocations use a generated crm_title) — that raises
-- "column can only be updated to DEFAULT". Skip the title write when the source
-- title column is generated; writable mapped columns still sync.

create or replace function public.crm_sync_to_source()
returns trigger language plpgsql security definer as $$
declare
  v_obj record; p record; v_val text;
  v_sets text := '';
  v_title_generated boolean := false;
begin
  if current_setting('crm.syncing', true) = '1' then return new; end if;
  if new.source_id is null then return new; end if;

  select source_table, source_title_col, slug into v_obj
  from public.crm_objects where id = new.object_id;
  if v_obj.source_table is null then return new; end if;

  -- Is the title column generated? (Can't be updated.)
  if v_obj.source_title_col is not null then
    select (is_generated <> 'NEVER') into v_title_generated
    from information_schema.columns
    where table_schema = 'public' and table_name = v_obj.source_table and column_name = v_obj.source_title_col;
  end if;

  -- Title column (only if present, not generated).
  if v_obj.source_title_col is not null and coalesce(v_title_generated, false) = false and (new.data ? 'name') then
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
