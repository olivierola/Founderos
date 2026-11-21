-- 0302 — Dashboards : l'épingle de l'accueil et l'état d'alerte des composants.
--
-- L'accueil du tableau de service (le « cockpit ») montre les dashboards
-- épinglés et les composants passés en alerte. L'état d'alerte est calculé au
-- remplissage, d'après les seuils du composant (ou l'état que l'agent donne) :
-- ok, warn, critical. `alert_since` dit depuis quand il est dans cet état.

alter table public.agent_dashboards
  add column if not exists pinned boolean not null default false;

alter table public.agent_dashboard_widgets
  add column if not exists alert_level text check (alert_level in ('ok', 'warn', 'critical')),
  add column if not exists alert_since timestamptz;

create index if not exists agent_dashboard_widgets_alert_idx
  on public.agent_dashboard_widgets (workspace_id, alert_level)
  where alert_level in ('warn', 'critical');
