-- 0129_agent_generative_ui.sql
-- Paliers UI générative / workspace composable / objets typés :
--   P1. ui_blocks jsonb sur internal_agent_messages (blocs typés rendus par le
--       chat : kpi_grid, chart, table, link_card, options…) + event kind 'ui'
--       (l'outil render_ui logge chaque bloc ; le finalize les attache au
--       message assistant).
--   P2. internal_agents.workspace_widgets jsonb — la liste des widgets du
--       "bureau" composable de l'agent (onglet Workspace, registre partagé).
--   P3. classe CRM 'deliverables' miroir de internal_agent_deliverables
--       (catalogue + props + relations agent/mission + trigger de sync).

-- ── P1 ────────────────────────────────────────────────────────────────────────
alter table public.internal_agent_messages
  add column if not exists ui_blocks jsonb;

alter table public.internal_agent_run_events
  drop constraint if exists internal_agent_run_events_kind_check;
alter table public.internal_agent_run_events
  add constraint internal_agent_run_events_kind_check
  check (kind in (
    'llm_call','tool_call','tool_result','status','log','error',
    'plan','plan_step','tool_error','question','todos','ui'
  ));

-- ── P2 ────────────────────────────────────────────────────────────────────────
alter table public.internal_agents
  add column if not exists workspace_widgets jsonb;

-- ── P3 ────────────────────────────────────────────────────────────────────────
insert into public.crm_source_catalog (slug, source_table, title_col, label, label_plural, icon, color) values
  ('deliverables', 'internal_agent_deliverables', 'name', 'Deliverable', 'Deliverables', 'FileText', 'text-violet-500')
on conflict (slug) do nothing;

insert into public.crm_source_props (object_slug, key, source_col, label, type, options, position, writable) values
  ('deliverables', 'kind', 'kind', 'Kind', 'select',
    '[{"value":"report","label":"Report","color":"#8b5cf6"},{"value":"markdown","label":"Markdown","color":"#64748b"},{"value":"json","label":"JSON","color":"#f59e0b"},{"value":"code","label":"Code","color":"#10b981"},{"value":"url","label":"URL","color":"#3b82f6"}]', 1, false),
  ('deliverables', 'summary', 'summary', 'Summary', 'text', '[]', 2, false)
on conflict (object_slug, key) do nothing;

insert into public.crm_source_relations (object_slug, key, label, source_fk_col, target_slug, position) values
  ('deliverables', 'agent',   'Agent',   'agent_id',   'autonomous_agents', 5),
  ('deliverables', 'mission', 'Mission', 'mission_id', 'missions',          6)
on conflict (object_slug, key) do nothing;

-- Forward-sync trigger on the source table (même mécanique que 0074).
drop trigger if exists trg_crm_sync_deliverables on public.internal_agent_deliverables;
create trigger trg_crm_sync_deliverables
  after insert or update or delete on public.internal_agent_deliverables
  for each row execute function public.crm_sync_from_source('name');
