-- Dependency vulnerabilities (CVE/GHSA) found by OSV.dev / Snyk for scanned deps.
create table if not exists public.vulnerabilities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  repository_id uuid references public.repositories(id) on delete set null,
  package_name text not null,
  package_version text,
  vuln_id text not null,                  -- GHSA-… / CVE-… / SNYK-…
  aliases text[] default '{}',            -- e.g. ['CVE-2023-…','GHSA-…']
  severity text default 'unknown' check (severity in ('unknown','low','medium','high','critical')),
  cvss numeric,
  summary text,
  fixed_version text,
  reference_url text,
  source text default 'osv' check (source in ('osv','snyk')),
  status text default 'open' check (status in ('open','ignored','fixed')),
  detected_at timestamptz default now(),
  unique (project_id, package_name, vuln_id)
);

alter table public.vulnerabilities enable row level security;

create policy "Members read vulnerabilities"
on public.vulnerabilities for select
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = vulnerabilities.workspace_id and wm.user_id = auth.uid()));

create policy "Members manage vulnerabilities"
on public.vulnerabilities for all
using (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = vulnerabilities.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')))
with check (exists (select 1 from public.workspace_members wm
  where wm.workspace_id = vulnerabilities.workspace_id and wm.user_id = auth.uid()
    and wm.role in ('owner','admin','member')));

create index if not exists idx_vuln_project on public.vulnerabilities(project_id, severity);
create index if not exists idx_vuln_status on public.vulnerabilities(project_id, status);
