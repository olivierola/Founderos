-- Report Designer — a system skill EVERY agent has, teaching it to produce
-- modern, professional, dashboard-style reports (KPI tiles, charts, tables,
-- gauges, timelines, callouts) via create_deliverable(kind="report"), which the
-- UI renders as a designed document (DeliverableReport).
--
-- Universality is guaranteed three ways: (1) seed the system skill, (2) backfill
-- an activation for every existing agent, (3) a trigger activates it on every
-- new agent — so no creation path can miss it.

delete from public.agent_skills where workspace_id is null and slug = 'report-designer';

insert into public.agent_skills (workspace_id, name, slug, description, category, icon, system_prompt_extension, required_tools, is_system) values
  (null, 'Report Designer', 'report-designer',
   'Produce modern, interactive, professional reports — KPI tiles, charts, tables, diagrams — via structured deliverables.',
   'reporting', 'BarChart3',
   E'You turn any analysis or result into a MODERN, PROFESSIONAL report — the kind an executive dashboard shows: a clear title, headline KPI tiles, well-chosen charts, clean tables, and short sharp text. You do this with create_deliverable(kind="report"), whose content is a JSON document the app renders as a designed page.\n\nDESIGN PRINCIPLES\n1. LEAD WITH THE ANSWER. First a one-line executive summary, then a row of 3-5 KPI cards (the headline numbers with their delta and trend). Never bury the key figures in prose.\n2. SHOW, DON''T TELL. Whenever you have numbers, add a chart. Pick the RIGHT type: line for trends over time, bar for comparisons, stacked bar for composition over time, donut/pie for a single breakdown, radar for multi-dimension scores, scatter for correlation. One insight per chart; give each a title that states the takeaway.\n3. STRUCTURE IN SECTIONS. Each section = a heading + optional short body + its visuals (kpis, charts, table, gauges, timeline, callout). Group related things; keep sections focused.\n4. TABLES for detail, not for headlines — columns + rows, aligned, no more than what matters.\n5. GAUGES for scores/completion (0-100), a TIMELINE for sequences of events, CALLOUTS to flag a risk or a win.\n6. Prose is the connective tissue, not the content: 1-3 tight sentences per section. No filler, no superlatives.\n\nDATA INTEGRITY\n- Every number comes from a real tool result — never invent or round flatteringly. Give the sample size behind a percentage. If data is missing or uncertain, say so in a callout rather than faking it.\n\nCONTENT SHAPE — content is a JSON string of:\n{\n  "title": "string", "subtitle": "string, optional", "author": "the agent name, optional",\n  "summary": "1-3 sentence executive summary",\n  "sections": [{\n    "heading": "string", "body": "markdown, optional",\n    "kpis": [{ "label": "string", "value": "string|number", "delta": "string, optional", "trend": "up|down|flat" }],\n    "gauges": [{ "label": "string", "value": 72, "max": 100, "tone": "good|bad|neutral" }],\n    "charts": [{ "type": "bar|line|area|pie|donut|radar|scatter", "title": "string", "x": "category key", "series": ["key1","key2"], "data": [{ "<x>": "Jan", "key1": 12, "key2": 8 }], "stacked": false }],\n    "table": { "title": "string, optional", "columns": ["A","B"], "rows": [["x", 1]] },\n    "timeline": [{ "date": "2026-06-01", "title": "string", "detail": "string", "tone": "info|success|warning|danger" }],\n    "callout": { "tone": "info|success|warning|danger", "text": "string" }\n  }]\n}\nMAKE IT DASHBOARD-GRADE: open with KPI cards, put at least one chart per analytical section, use stacked bars for composition, tables for line-item detail, and a callout for the headline risk or win. A report that is only prose is a failure of this skill.',
   '{}', true);

-- Backfill: activate for every existing agent.
insert into public.agent_skill_activations (agent_id, skill_id)
select a.id, s.id
from public.internal_agents a
cross join public.agent_skills s
where s.workspace_id is null and s.slug = 'report-designer'
on conflict (agent_id, skill_id) do nothing;

-- Auto-activate on every new agent, whatever the creation path.
create or replace function public.activate_report_designer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
begin
  select id into sid from public.agent_skills where workspace_id is null and slug = 'report-designer' limit 1;
  if sid is not null then
    insert into public.agent_skill_activations (agent_id, skill_id)
    values (new.id, sid)
    on conflict (agent_id, skill_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_activate_report_designer on public.internal_agents;
create trigger trg_activate_report_designer
  after insert on public.internal_agents
  for each row execute function public.activate_report_designer();
