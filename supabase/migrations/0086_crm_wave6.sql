-- "Everything is an object" — wave 6: the remaining tables that have a project_id
-- but lacked a clean title column. Support channels/articles/voice calls, agent
-- runs, code scans, ops jobs. (Tables WITHOUT project_id — fin_bank_txns,
-- internal_agent_deliverables — still need a derived project_id and are left out.)

-- ── Generated title columns where missing (immutable expressions only) ────────
alter table public.support_voice_calls
  add column if not exists crm_title text
  generated always as (coalesce(nullif(from_number, ''), 'Call') || ' · ' || status) stored;

alter table public.internal_agent_runs
  add column if not exists crm_title text
  generated always as ('Run · ' || status) stored;

-- created_at::date is timezone-dependent (STABLE), not immutable → use the id.
alter table public.scan_results
  add column if not exists crm_title text
  generated always as ('Scan ' || left(id::text, 8)) stored;

-- ── Classes ───────────────────────────────────────────────────────────────────
insert into public.crm_source_catalog (slug, source_table, title_col, label, label_plural, icon, color) values
  ('support_channels', 'support_channels',     'name',      'Channel',     'Channels',      'MessageSquare', 'text-sky-500'),
  ('kb_articles',      'support_articles',     'title',     'KB article',  'KB articles',   'FileText',  'text-sky-500'),
  ('voice_calls',      'support_voice_calls',  'crm_title', 'Voice call',  'Voice calls',   'Phone',     'text-emerald-500'),
  ('agent_runs',       'internal_agent_runs',  'crm_title', 'Agent run',   'Agent runs',    'Bot',       'text-fuchsia-500'),
  ('code_scans',       'scan_results',         'crm_title', 'Code scan',   'Code scans',    'GitBranch', 'text-zinc-400'),
  ('ops_jobs',         'ops_jobs',             'job_type',  'Ops job',     'Ops jobs',      'AppWindow', 'text-sky-500')
on conflict (slug) do nothing;

insert into public.crm_source_props (object_slug, key, source_col, label, type, options, position, writable) values
  ('support_channels', 'kind', 'kind', 'Kind', 'text', '[]', 1, false),
  ('kb_articles', 'status', 'status', 'Status', 'select',
    '[{"value":"draft","label":"Draft","color":"#64748b"},{"value":"published","label":"Published","color":"#10b981"},{"value":"archived","label":"Archived","color":"#64748b"}]', 1, true),
  ('voice_calls', 'status', 'status', 'Status', 'text', '[]', 1, false),
  ('agent_runs', 'status', 'status', 'Status', 'select',
    '[{"value":"queued","label":"Queued","color":"#64748b"},{"value":"running","label":"Running","color":"#3b82f6"},{"value":"succeeded","label":"Succeeded","color":"#10b981"},{"value":"failed","label":"Failed","color":"#ef4444"},{"value":"cancelled","label":"Cancelled","color":"#64748b"}]', 1, false),
  ('ops_jobs', 'status', 'status', 'Status', 'text', '[]', 1, false)
on conflict (object_slug, key) do nothing;

insert into public.crm_source_relations (object_slug, key, label, source_fk_col, target_slug, position) values
  ('voice_calls', 'ticket',  'Ticket',     'ticket_id',     'tickets',         5),
  ('voice_calls', 'channel', 'Channel',    'channel_id',    'support_channels',6),
  ('agent_runs',  'mission', 'Mission',    'mission_id',    'missions',        5),
  ('agent_runs',  'agent',   'Agent',      'agent_id',      'autonomous_agents',6),
  ('code_scans',  'repo',    'Repository', 'repository_id', 'repositories',    5),
  ('ops_jobs',    'server',  'Server',     'server_id',     'servers',         5)
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
