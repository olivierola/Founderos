-- Multi-tenant RBAC: per-project members + roles + permissions.
-- A project (a client SaaS) has its own membership list. Each member holds a
-- role within that project. Roles are either built-in (system) or custom to a
-- workspace. Roles carry a set of permissions; permissions are keyed strings
-- like `finance.revenue.view`.

/* ============================================================ */
/*  Catalogue                                                   */
/* ============================================================ */

create table if not exists public.permissions (
  key text primary key,                        -- e.g. "finance.revenue.view"
  module text not null,                        -- e.g. "finance"
  feature text not null,                       -- e.g. "revenue"
  action text not null,                        -- e.g. "view" / "execute" / "manage"
  description text,
  is_destructive boolean default false,        -- true for refund, delete, ban...
  created_at timestamptz default now()
);

/* ============================================================ */
/*  Roles                                                       */
/* ============================================================ */

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade, -- NULL = built-in
  slug text not null,                          -- "owner", "admin", "viewer", "custom_slug"
  name text not null,                          -- human label
  description text,
  is_system boolean default false,             -- built-in roles are read-only
  color text,                                  -- optional: for the UI chip
  position int default 0,                      -- ordering in UI
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (workspace_id, slug)
);

create table if not exists public.role_permissions (
  role_id uuid references public.roles(id) on delete cascade,
  permission_key text references public.permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

/* ============================================================ */
/*  Project membership                                          */
/* ============================================================ */

create table if not exists public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  invited_by uuid references auth.users(id),
  created_at timestamptz default now(),
  unique (project_id, user_id)
);

create index if not exists project_members_user_idx
  on public.project_members(user_id);
create index if not exists project_members_project_idx
  on public.project_members(project_id);

create table if not exists public.project_invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role_id uuid not null references public.roles(id) on delete restrict,
  invited_by uuid references auth.users(id),
  token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  expires_at timestamptz default (now() + interval '14 days'),
  accepted_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists project_invitations_token_idx
  on public.project_invitations(token);

/* ============================================================ */
/*  Permission catalogue seed                                   */
/* ============================================================ */

insert into public.permissions(key, module, feature, action, description, is_destructive) values
  -- Overview
  ('overview.dashboard.view',        'overview', 'dashboard',         'view',    'See the project dashboard',                  false),
  ('overview.dashboards.manage',     'overview', 'custom_dashboards', 'manage',  'Create, edit and delete custom dashboards',  false),
  ('overview.alerts.view',           'overview', 'alerts',            'view',    'See alerts',                                  false),
  ('overview.alerts.manage',         'overview', 'alerts',            'manage',  'Acknowledge and resolve alerts',              false),
  ('overview.briefing.view',         'overview', 'daily_briefing',    'view',    'Read the daily AI briefing',                  false),
  ('overview.activity.view',         'overview', 'activity_feed',     'view',    'Browse the activity feed',                    false),

  -- Finance & Costs
  ('finance.revenue.view',           'finance',  'revenue',           'view',    'View revenue, MRR, ARR',                      false),
  ('finance.subscriptions.view',     'finance',  'subscriptions',     'view',    'View subscriptions',                          false),
  ('finance.customers.view',         'finance',  'customers',         'view',    'View customers list',                         false),
  ('finance.transactions.view',      'finance',  'transactions',      'view',    'View raw transactions',                       false),
  ('finance.reports.view',           'finance',  'reports',           'view',    'View finance reports',                        false),
  ('finance.reports.export',         'finance',  'reports',           'export',  'Export finance reports',                      false),
  ('costs.view',                     'finance',  'costs',             'view',    'View costs and burn rate',                    false),
  ('costs.budgets.manage',           'finance',  'budgets',           'manage',  'Set and edit budgets',                        false),

  -- Code & Security
  ('code.repos.view',                'code',     'repositories',      'view',    'View tracked repositories',                   false),
  ('code.repos.manage',              'code',     'repositories',      'manage',  'Add and remove repositories',                 false),
  ('code.scans.run',                 'code',     'scans',             'execute', 'Trigger a code scan',                         false),
  ('code.scans.view',                'code',     'scans',             'view',    'See scan results',                            false),
  ('security.findings.view',         'code',     'security_findings', 'view',    'See security findings',                       false),
  ('security.secrets.view',          'code',     'secrets',           'view',    'See detected secrets',                        false),

  -- SaaS Analytics (Users / Health) — surfaced inside Admin panel
  ('analytics.users.view',           'admin',    'users_analytics',   'view',    'See user analytics',                          false),
  ('analytics.users.manage',         'admin',    'users_analytics',   'manage',  'Create cohorts and segments',                 false),
  ('analytics.health.view',          'admin',    'health',            'view',    'See app health / uptime / deploys',           false),

  -- Admin panel (actions)
  ('admin.actions.view',             'admin',    'actions',           'view',    'See actions center',                          false),
  ('admin.actions.execute',          'admin',    'actions',           'execute', 'Execute admin actions',                       true),
  ('admin.user.reset_password',      'admin',    'users',             'execute', 'Reset a customer password',                   true),
  ('admin.user.ban',                 'admin',    'users',             'execute', 'Ban / suspend a customer',                    true),
  ('admin.billing.refund',           'admin',    'billing',           'execute', 'Issue a refund',                              true),
  ('admin.billing.cancel_sub',       'admin',    'billing',           'execute', 'Cancel a subscription',                       true),
  ('admin.db.console',               'admin',    'database',          'execute', 'Use the database console',                    true),
  ('admin.email.send',               'admin',    'email',             'execute', 'Send an email through the cockpit',           false),
  ('admin.webhooks.manage',          'admin',    'webhooks',          'manage',  'Configure outbound webhooks',                 false),
  ('admin.runbooks.execute',         'admin',    'runbooks',          'execute', 'Run a runbook',                               true),
  ('admin.approvals.review',         'admin',    'approvals',         'review',  'Approve or reject admin actions',             false),
  ('admin.audit.view',               'admin',    'audit_log',         'view',    'View the audit log',                          false),
  ('admin.audit.export',             'admin',    'audit_log',         'export',  'Export the audit log',                        false),

  -- Marketing
  ('marketing.posts.view',           'marketing','posts',             'view',    'View posts',                                  false),
  ('marketing.posts.manage',         'marketing','posts',             'manage',  'Create, schedule, publish posts',             false),
  ('marketing.campaigns.manage',     'marketing','campaigns',         'manage',  'Manage campaigns',                            false),

  -- RAG / AI agents
  ('agent.rag.view',                 'agent',    'rag_agents',        'view',    'View RAG agents',                             false),
  ('agent.rag.manage',               'agent',    'rag_agents',        'manage',  'Create and edit RAG agents',                  false),
  ('agent.rag.train',                'agent',    'rag_agents',        'execute', 'Ingest sources and train',                    false),
  ('agent.onboarding.manage',        'agent',    'onboarding',        'manage',  'Edit onboarding flows',                       false),
  ('agent.ai.chat',                  'agent',    'ai_chat',           'execute', 'Chat with the AI agent',                      false),

  -- Integrations / Vault
  ('integrations.view',              'integrations','connectors',     'view',    'View connected providers',                    false),
  ('integrations.connect',           'integrations','connectors',     'execute', 'Connect a new provider',                      false),
  ('integrations.disconnect',        'integrations','connectors',     'execute', 'Disconnect a provider',                       true),
  ('vault.view',                     'integrations','credentials',    'view',    'List vault entries (metadata only)',          false),
  ('vault.propagate',                'integrations','credentials',    'execute', 'Push secrets to backends',                    true),

  -- Settings
  ('settings.project.manage',        'settings', 'project',           'manage',  'Edit project name, slug, danger zone',        true),
  ('settings.team.view',             'settings', 'team',              'view',    'See team members',                            false),
  ('settings.team.manage',           'settings', 'team',              'manage',  'Invite, remove members and change roles',     false),
  ('settings.roles.manage',          'settings', 'roles',             'manage',  'Create and edit custom roles',                false),
  ('settings.billing.manage',        'settings', 'billing',           'manage',  'Access billing portal',                       false)
on conflict (key) do update set
  description = excluded.description,
  module = excluded.module,
  feature = excluded.feature,
  action = excluded.action,
  is_destructive = excluded.is_destructive;

/* ============================================================ */
/*  Built-in roles seed                                         */
/* ============================================================ */

insert into public.roles(workspace_id, slug, name, description, is_system, color, position) values
  (null, 'owner',     'Owner',     'Full control over the project (cannot be removed).', true, '#001BB7', 0),
  (null, 'admin',     'Admin',     'Manage everything except destroying the project.',   true, '#a78bfa', 1),
  (null, 'developer', 'Developer', 'Read access to all modules + code scans, can manage RAG agents and dashboards.', true, '#38bdf8', 2),
  (null, 'finance',   'Finance',   'Full finance access, read-only elsewhere.',          true, '#34d399', 3),
  (null, 'support',   'Support',   'Customer support actions only.',                     true, '#fbbf24', 4),
  (null, 'viewer',    'Viewer',    'Read-only access to all dashboards.',                true, '#94a3b8', 5)
on conflict (workspace_id, slug) do update set
  name = excluded.name,
  description = excluded.description,
  color = excluded.color,
  position = excluded.position;

/* Permissions per built-in role */

-- Owner: every permission
insert into public.role_permissions(role_id, permission_key)
select r.id, p.key
  from public.roles r, public.permissions p
 where r.slug = 'owner' and r.workspace_id is null
on conflict do nothing;

-- Admin: everything except settings.project.manage (destroying the project)
insert into public.role_permissions(role_id, permission_key)
select r.id, p.key
  from public.roles r, public.permissions p
 where r.slug = 'admin' and r.workspace_id is null
   and p.key <> 'settings.project.manage'
on conflict do nothing;

-- Developer: view everything + code/scan + RAG manage + dashboards
insert into public.role_permissions(role_id, permission_key)
select r.id, p.key
  from public.roles r, public.permissions p
 where r.slug = 'developer' and r.workspace_id is null
   and (
     p.action = 'view'
     or p.key in (
       'overview.dashboards.manage',
       'code.repos.manage', 'code.scans.run',
       'agent.rag.manage', 'agent.rag.train', 'agent.onboarding.manage', 'agent.ai.chat',
       'integrations.view', 'integrations.connect',
       'admin.actions.view', 'admin.email.send', 'admin.webhooks.manage'
     )
   )
on conflict do nothing;

-- Finance: full finance + dashboards/view, alerts, reports export
insert into public.role_permissions(role_id, permission_key)
select r.id, p.key
  from public.roles r, public.permissions p
 where r.slug = 'finance' and r.workspace_id is null
   and (
     p.module in ('finance')
     or p.key in (
       'overview.dashboard.view', 'overview.alerts.view',
       'finance.reports.export', 'costs.budgets.manage',
       'admin.billing.refund', 'admin.billing.cancel_sub', 'admin.audit.view'
     )
   )
on conflict do nothing;

-- Support: customer-facing actions + analytics read
insert into public.role_permissions(role_id, permission_key)
select r.id, p.key
  from public.roles r, public.permissions p
 where r.slug = 'support' and r.workspace_id is null
   and p.key in (
     'overview.dashboard.view', 'overview.alerts.view',
     'analytics.users.view',
     'admin.actions.view', 'admin.actions.execute',
     'admin.user.reset_password',
     'admin.billing.refund', 'admin.billing.cancel_sub',
     'admin.email.send',
     'finance.customers.view', 'finance.subscriptions.view',
     'agent.ai.chat'
   )
on conflict do nothing;

-- Viewer: every view/read permission
insert into public.role_permissions(role_id, permission_key)
select r.id, p.key
  from public.roles r, public.permissions p
 where r.slug = 'viewer' and r.workspace_id is null
   and p.action = 'view'
on conflict do nothing;

/* ============================================================ */
/*  Permission resolver                                          */
/* ============================================================ */

create or replace function public.has_permission(p_user uuid, p_project uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Workspace owners always pass.
  select exists (
    select 1
      from public.projects pr
      join public.workspace_members wm on wm.workspace_id = pr.workspace_id
     where pr.id = p_project
       and wm.user_id = p_user
       and wm.role = 'owner'
  )
  or exists (
    select 1
      from public.project_members pm
      join public.role_permissions rp on rp.role_id = pm.role_id
     where pm.project_id = p_project
       and pm.user_id = p_user
       and rp.permission_key = p_perm
  );
$$;

/* Helper: list every permission a user holds on a project. Used by the
   frontend to bootstrap the `usePermission` hook. */
create or replace function public.user_permissions(p_user uuid, p_project uuid)
returns table (permission_key text)
language sql
stable
security definer
set search_path = public
as $$
  -- Workspace owners get every permission.
  select p.key from public.permissions p
   where exists (
     select 1 from public.projects pr
     join public.workspace_members wm on wm.workspace_id = pr.workspace_id
     where pr.id = p_project and wm.user_id = p_user and wm.role = 'owner'
   )
  union
  select rp.permission_key
    from public.project_members pm
    join public.role_permissions rp on rp.role_id = pm.role_id
   where pm.project_id = p_project
     and pm.user_id = p_user;
$$;

/* Helper: resolve emails for a list of user ids (used by the Team page).
   Only project-members of the caller can be resolved. */
create or replace function public.emails_for_users(p_users uuid[])
returns table (id uuid, email text)
language sql
stable
security definer
set search_path = public, auth
as $$
  select u.id, u.email
    from auth.users u
   where u.id = any(p_users)
     and exists (
       select 1
         from public.project_members pm
         join public.project_members me on me.project_id = pm.project_id
        where me.user_id = auth.uid()
          and pm.user_id = u.id
     );
$$;

/* ============================================================ */
/*  RLS                                                          */
/* ============================================================ */

alter table public.permissions enable row level security;
alter table public.roles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.project_members enable row level security;
alter table public.project_invitations enable row level security;

-- Permissions catalogue is readable by every authenticated user.
create policy "permissions readable" on public.permissions
  for select using (auth.role() = 'authenticated');

-- Built-in roles are readable by everyone, custom roles only by workspace members.
create policy "roles readable" on public.roles
  for select using (
    is_system
    or exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = roles.workspace_id
        and wm.user_id = auth.uid()
    )
  );

create policy "role_permissions readable" on public.role_permissions
  for select using (
    exists (
      select 1 from public.roles r
      where r.id = role_permissions.role_id
        and (
          r.is_system
          or exists (
            select 1 from public.workspace_members wm
            where wm.workspace_id = r.workspace_id and wm.user_id = auth.uid()
          )
        )
    )
  );

-- Project members: a user can see members of any project where they are
-- themselves a member (or workspace owner).
create policy "project_members readable" on public.project_members
  for select using (
    user_id = auth.uid()
    or exists (
      select 1 from public.project_members pm2
      where pm2.project_id = project_members.project_id and pm2.user_id = auth.uid()
    )
    or exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = project_members.workspace_id
        and wm.user_id = auth.uid()
        and wm.role = 'owner'
    )
  );

-- Writes (insert/update/delete) are restricted to the service role; edge
-- functions enforce per-permission authorisation server-side.
create policy "roles writes service" on public.roles
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
create policy "role_permissions writes service" on public.role_permissions
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
create policy "project_members writes service" on public.project_members
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
create policy "project_invitations writes service" on public.project_invitations
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Invitations: invitee can see their own invitations.
create policy "project_invitations readable" on public.project_invitations
  for select using (
    accepted_at is null and (
      email = (select email from auth.users where id = auth.uid())
      or exists (
        select 1 from public.project_members pm
        where pm.project_id = project_invitations.project_id and pm.user_id = auth.uid()
      )
    )
  );

/* ============================================================ */
/*  Bootstrap existing projects as owner-member of their creator */
/* ============================================================ */

insert into public.project_members(project_id, workspace_id, user_id, role_id)
select distinct pr.id, pr.workspace_id, wm.user_id, r.id
  from public.projects pr
  join public.workspace_members wm on wm.workspace_id = pr.workspace_id and wm.role = 'owner'
  join public.roles r on r.slug = 'owner' and r.workspace_id is null
on conflict (project_id, user_id) do nothing;
