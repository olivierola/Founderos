-- 0177_connector_scopes.sql
-- Connectors become SCOPED. Until now a connection was one row per
-- (workspace, project, provider, source): connecting Gmail once made it
-- available to every agent of every service dashboard, under a single shared
-- account. Two things were impossible:
--
--   1. Giving each service dashboard its OWN connections (the Support space
--      and the Finance space sharing one mailbox is not a feature).
--   2. Letting a person connect their OWN account so an agent can reach THEM
--      — "ping me on my mailbox" — without that account becoming a shared
--      credential the whole workspace can act through.
--
-- Three scopes, ordered from broadest to narrowest:
--
--   project    service_dashboard_id NULL, owner_user_id NULL
--              The legacy rows. Workspace-wide fallback, still honoured.
--   dashboard  service_dashboard_id SET,  owner_user_id NULL
--              The team connection of one service dashboard. What agents use
--              by default.
--   personal   service_dashboard_id SET,  owner_user_id SET
--              One person's own account, inside one dashboard. Never used
--              implicitly: an agent must ask for it explicitly.
--
-- Personal connections are per (user, dashboard) on purpose: a mailbox
-- connected in "Support" stays invisible from "Finance", so the wall between
-- spaces holds.

-- ── 1. Scope columns ─────────────────────────────────────────────────────────
alter table public.connectors
  add column if not exists service_dashboard_id uuid references public.service_dashboards(id) on delete cascade,
  add column if not exists owner_user_id        uuid references auth.users(id) on delete cascade,
  add column if not exists scope                text not null default 'project';

alter table public.connectors
  drop constraint if exists connectors_scope_check;
alter table public.connectors
  add constraint connectors_scope_check check (
    (scope = 'project'   and service_dashboard_id is null and owner_user_id is null) or
    (scope = 'dashboard' and service_dashboard_id is not null and owner_user_id is null) or
    (scope = 'personal'  and service_dashboard_id is not null and owner_user_id is not null)
  );

comment on column public.connectors.scope is
  'project | dashboard | personal — see 0177. Agents resolve dashboard → project; personal is opt-in per call.';

-- ── 2. Uniqueness per scope ──────────────────────────────────────────────────
-- The old key allowed exactly one row per provider per project. Now the same
-- provider may be connected once per dashboard and once per person within it.
-- NULLs are distinct in a Postgres unique index, so the scope columns are
-- coalesced to a sentinel — otherwise the key would not constrain anything for
-- the project-scoped rows (the same trap as agent_skills in 0165).
alter table public.connectors
  drop constraint if exists connectors_workspace_id_project_id_provider_source_key;

create unique index if not exists idx_connectors_scoped_unique
  on public.connectors (
    workspace_id, project_id, provider, source,
    coalesce(service_dashboard_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(owner_user_id,        '00000000-0000-0000-0000-000000000000'::uuid)
  );

create index if not exists idx_connectors_dashboard on public.connectors(service_dashboard_id) where service_dashboard_id is not null;
create index if not exists idx_connectors_owner     on public.connectors(owner_user_id)        where owner_user_id is not null;

-- ── 3. RLS — a personal connection is nobody else's business ─────────────────
-- The existing "Workspace members read connectors" policy would expose every
-- teammate's personal account to the whole workspace. Replace it with one that
-- hides personal rows from everyone but their owner. Writes stay service-role
-- (the connect/disconnect edge functions), as before.
drop policy if exists "Workspace members read connectors" on public.connectors;

create policy "Members read shared connectors, owners read their own"
on public.connectors for select
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = connectors.workspace_id and wm.user_id = auth.uid()
  )
  and (connectors.owner_user_id is null or connectors.owner_user_id = auth.uid())
);
