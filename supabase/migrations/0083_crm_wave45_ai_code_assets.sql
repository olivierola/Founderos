-- "Everything is an object" — waves 4+5: AI (RAG collections), Code/Ops
-- (repositories, servers), Assets (asset canvases). Skipped: agent runs /
-- deliverables (no project_id or no title), scan_results (no title), ops_jobs
-- (no title), asset_nodes (label nullable / very high volume).

insert into public.crm_source_catalog (slug, source_table, title_col, label, label_plural, icon, color) values
  ('rag_collections', 'rag_collections', 'name', 'RAG collection', 'RAG collections', 'Library',  'text-violet-500'),
  ('repositories',    'repositories',    'name', 'Repository',     'Repositories',    'GitBranch','text-zinc-400'),
  ('servers',         'ops_servers',     'name', 'Server',         'Servers',         'AppWindow','text-sky-500'),
  ('asset_canvases',  'asset_canvases',  'name', 'Asset map',      'Asset maps',      'Shapes',   'text-indigo-500')
on conflict (slug) do nothing;

insert into public.crm_source_props (object_slug, key, source_col, label, type, options, position, writable) values
  ('servers', 'os', 'os_name', 'OS', 'text', '[]', 1, false),
  ('servers', 'status', 'status', 'Status', 'select',
    '[{"value":"online","label":"Online","color":"#10b981"},{"value":"offline","label":"Offline","color":"#64748b"},{"value":"degraded","label":"Degraded","color":"#f59e0b"},{"value":"error","label":"Error","color":"#ef4444"},{"value":"provisioning","label":"Provisioning","color":"#3b82f6"},{"value":"unknown","label":"Unknown","color":"#64748b"}]', 2, false),
  ('repositories', 'full_name', 'full_name', 'Full name', 'text', '[]', 1, false)
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
