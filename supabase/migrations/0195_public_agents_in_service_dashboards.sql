-- 0195_public_agents_in_service_dashboards.sql
-- Public (customer-facing) agents move into the service dashboards, where the
-- internal ones already live (0133). A service now owns its whole workforce:
-- public agents are CREATED there and CONFIGURED there (Playground / Knowledge
-- / Widget / Analytics / Onboarding / Settings) instead of in a separate
-- module page whose only job was to host those six tabs.

alter table public.rag_agents
  add column if not exists service_dashboard_id uuid references public.service_dashboards(id) on delete set null;
create index if not exists idx_rag_agents_service_dashboard on public.rag_agents(service_dashboard_id);

-- Backfill: an existing public agent attaches to its project's first dashboard
-- so nothing becomes unreachable the moment its pages move. Projects without a
-- dashboard keep NULL — the workforce roster still lists those agents and sends
-- you to create a dashboard for them.
update public.rag_agents a
set service_dashboard_id = (
  select sd.id
  from public.service_dashboards sd
  where sd.project_id = a.project_id
  order by sd.position, sd.created_at
  limit 1
)
where a.service_dashboard_id is null;
