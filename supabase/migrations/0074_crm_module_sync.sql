-- Module classes as CRM objects with LIVE bidirectional sync.
-- Real app tables (office_documents, internal_agents, rag_agents, sim_simulations,
-- project_channels…) become CRM object classes whose records mirror the source
-- rows. Forward sync: source row change → upsert/delete the matching crm_record.
-- Reverse sync: editing a source-backed record's title writes back to the source.
-- A loop guard (set_config) prevents triggers from re-triggering each other.

-- ── Provenance: which source column is the title ──────────────────────────────
alter table public.crm_objects add column if not exists source_title_col text;

-- ── Registry of synced module classes (source table → title column + slug) ────
-- The catalog the app exposes as "Add object from template". Static metadata.
create table if not exists public.crm_source_catalog (
  slug text primary key,                 -- people | documents | discussions | …
  source_table text not null,
  title_col text not null,
  label text not null,
  label_plural text not null,
  icon text not null,
  color text not null
);
insert into public.crm_source_catalog (slug, source_table, title_col, label, label_plural, icon, color) values
  ('documents',     'office_documents', 'title', 'Document',         'Documents',         'FileText',  'text-zinc-400'),
  ('discussions',   'project_channels', 'name',  'Discussion',       'Discussions',       'MessageSquare', 'text-sky-500'),
  ('simulations',   'sim_simulations',  'name',  'Simulation',       'Simulations',       'FlaskConical', 'text-purple-500'),
  ('autonomous_agents', 'internal_agents', 'name', 'Autonomous agent', 'Autonomous agents', 'Bot',     'text-fuchsia-500'),
  ('public_agents', 'rag_agents',       'name',  'Public agent',     'Public agents',     'Bot',       'text-emerald-500')
on conflict (slug) do nothing;

-- ── Forward sync: a source row changed → mirror into crm_records ──────────────
-- Generic: reads TG_ARGV[0]=title column. Finds the crm_object for this project
-- whose source_table = TG_TABLE_NAME, then upserts the record by source_id.
create or replace function public.crm_sync_from_source()
returns trigger language plpgsql security definer as $$
declare
  v_title_col text := tg_argv[0];
  v_obj record;
  v_title text;
  v_row record;
begin
  if current_setting('crm.syncing', true) = '1' then return coalesce(new, old); end if;

  if (tg_op = 'DELETE') then
    delete from public.crm_records r
      using public.crm_objects o
      where r.object_id = o.id and o.source_table = tg_table_name and r.source_id = old.id;
    return old;
  end if;

  v_row := new;
  execute format('select ($1).%I::text', v_title_col) into v_title using v_row;

  for v_obj in
    select id, workspace_id, project_id from public.crm_objects
    where source_table = tg_table_name and project_id = new.project_id
  loop
    perform set_config('crm.syncing', '1', true);
    if exists (select 1 from public.crm_records where object_id = v_obj.id and source_id = new.id) then
      update public.crm_records
        set data = jsonb_set(coalesce(data, '{}'::jsonb), '{name}', to_jsonb(v_title)), updated_at = now()
        where object_id = v_obj.id and source_id = new.id;
    else
      insert into public.crm_records (workspace_id, project_id, object_id, source_id, data)
        values (v_obj.workspace_id, v_obj.project_id, v_obj.id, new.id, jsonb_build_object('name', v_title));
    end if;
    perform set_config('crm.syncing', '0', true);
  end loop;
  return new;
end $$;

-- ── Reverse sync: a source-backed crm_record's title changed → write back ─────
create or replace function public.crm_sync_to_source()
returns trigger language plpgsql security definer as $$
declare
  v_obj record;
  v_title text;
begin
  if current_setting('crm.syncing', true) = '1' then return new; end if;
  if new.source_id is null then return new; end if;

  select source_table, source_title_col into v_obj
  from public.crm_objects where id = new.object_id;
  if v_obj.source_table is null or v_obj.source_title_col is null then return new; end if;

  v_title := new.data->>'name';
  if v_title is null then return new; end if;

  perform set_config('crm.syncing', '1', true);
  execute format('update public.%I set %I = $1 where id = $2', v_obj.source_table, v_obj.source_title_col)
    using v_title, new.source_id;
  perform set_config('crm.syncing', '0', true);
  return new;
end $$;

drop trigger if exists trg_crm_to_source on public.crm_records;
create trigger trg_crm_to_source after update of data on public.crm_records
  for each row execute function public.crm_sync_to_source();

-- ── Instantiate a catalog template as a CRM object (+ backfill existing rows) ──
-- Called by the app when the user picks a module class from the "New object"
-- template catalog. Idempotent per (project, slug).
create or replace function public.crm_add_from_catalog(p_workspace uuid, p_project uuid, p_slug text, p_user uuid default null)
returns uuid language plpgsql security definer as $$
declare c record; oid uuid; npos int; v_title text; r record;
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

  insert into public.crm_properties (workspace_id, project_id, object_id, key, label, type, is_title, is_system, position) values
    (p_workspace, p_project, oid, 'name', 'Name', 'text', true, true, 0);
  insert into public.crm_views (workspace_id, project_id, object_id, name, kind, is_default, position, created_by)
    values (p_workspace, p_project, oid, 'All ' || c.label_plural, 'table', true, 0, p_user);

  -- Backfill existing source rows for this project into crm_records.
  for r in execute format(
    'select id, %1$I::text as title from public.%2$I where project_id = $1', c.title_col, c.source_table
  ) using p_project
  loop
    if not exists (select 1 from public.crm_records where object_id = oid and source_id = r.id) then
      insert into public.crm_records (workspace_id, project_id, object_id, source_id, data)
        values (p_workspace, p_project, oid, r.id, jsonb_build_object('name', r.title));
    end if;
  end loop;

  return oid;
end $$;

-- People & Opportunities (backfilled in 0073) join live sync too: set their
-- title column + register them in the catalog so triggers attach below.
update public.crm_objects set source_title_col = 'full_name' where slug = 'people'        and source_title_col is null;
update public.crm_objects set source_title_col = 'title'     where slug = 'opportunities' and source_title_col is null;
insert into public.crm_source_catalog (slug, source_table, title_col, label, label_plural, icon, color) values
  ('people',        'crm_contacts', 'full_name', 'Person',      'People',         'Users',  'text-violet-500'),
  ('opportunities', 'crm_deals',    'title',     'Opportunity', 'Opportunities',  'Target', 'text-rose-500')
on conflict (slug) do nothing;

-- ── Attach forward-sync triggers to each source table ─────────────────────────
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
