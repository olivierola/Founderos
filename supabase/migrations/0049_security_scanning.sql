-- Security scanning: defensive checks + consented, non-destructive active scans.
-- Active scans (port/surface) are ONLY ever run against a target the user has
-- explicitly authorised (consent recorded here). No exploitation — detection,
-- proof of exposure and remediation only.

-- ---- Authorised scan targets (consent registry) ---------------------------
create table if not exists public.security_scan_targets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- The host/domain or URL the user authorises scanning on.
  target text not null,
  label text,
  -- Consent: the user attests ownership/authorisation. Active scans require this.
  consent_active boolean not null default false,
  consented_by uuid references auth.users(id),
  consented_at timestamptz,
  consent_note text,                            -- e.g. "I own this domain"
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  unique (project_id, target)
);

-- ---- Scans (one run of one scan type against a target) --------------------
create table if not exists public.security_scans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  target_id uuid references public.security_scan_targets(id) on delete set null,
  -- target_host is denormalised so the runner needn't read the targets table.
  target_host text not null,
  -- passive: run in edge (headers/tls/exposure/cve/secrets).
  -- active: run by the runner (port_scan/surface). Requires consent.
  mode text not null default 'passive' check (mode in ('passive','active')),
  scan_type text not null check (scan_type in (
    'headers','tls','exposure','dependency_cve','secrets',   -- passive
    'port_scan','surface','full'                              -- active
  )),
  status text not null default 'queued' check (status in (
    'queued','running','completed','failed','blocked'         -- blocked = no consent
  )),
  result jsonb default '{}'::jsonb,
  error_message text,
  -- Runner bookkeeping (active scans).
  runner_id text,
  scheduled_at timestamptz default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- ---- Findings (one per issue) ----------------------------------------------
create table if not exists public.security_scan_findings (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.security_scans(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  severity text not null default 'info' check (severity in ('info','low','medium','high','critical')),
  title text not null,
  detail text,
  evidence jsonb default '{}'::jsonb,           -- proof of exposure (non-destructive)
  remediation text,
  created_at timestamptz default now()
);

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.security_scan_targets enable row level security;
alter table public.security_scans enable row level security;
alter table public.security_scan_findings enable row level security;

do $$
declare t text;
begin
  foreach t in array array['security_scan_targets','security_scans','security_scan_findings']
  loop
    execute format('drop policy if exists "Members read %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members read %1$s" on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format('drop policy if exists "Members manage %1$s" on public.%1$s;', t);
    execute format($f$
      create policy "Members manage %1$s" on public.%1$s for all
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
          and wm.role in ('owner','admin','member')))
      with check (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
          and wm.role in ('owner','admin','member')));
    $f$, t);
  end loop;
end $$;

-- ============================================================================
-- Indexes
-- ============================================================================
create index if not exists idx_sec_targets_project on public.security_scan_targets(project_id);
create index if not exists idx_sec_scans_project on public.security_scans(project_id, created_at desc);
create index if not exists idx_sec_scans_queue on public.security_scans(status, scheduled_at)
  where mode = 'active' and status in ('queued','running');
create index if not exists idx_sec_findings_scan on public.security_scan_findings(scan_id);

-- ============================================================================
-- claim_security_scan — runner pickup for ACTIVE scans only. Double-guards
-- consent: a scan is only claimable if its target has consent_active = true.
-- ============================================================================
create or replace function public.claim_security_scan(p_runner_id text)
returns public.security_scans
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scan public.security_scans;
begin
  select s.* into v_scan
  from public.security_scans s
  join public.security_scan_targets t on t.id = s.target_id
  where s.mode = 'active' and s.status = 'queued' and t.consent_active = true
  order by s.scheduled_at asc
  limit 1
  for update skip locked;

  if v_scan.id is null then
    return null;
  end if;

  update public.security_scans
     set status = 'running', runner_id = p_runner_id, started_at = now()
   where id = v_scan.id
   returning * into v_scan;

  return v_scan;
end;
$$;
