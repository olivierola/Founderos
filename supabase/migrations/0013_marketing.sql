-- Marketing module: social channels, campaigns, posts and per-post metrics.
-- Posts are generated from the SaaS understanding produced by code scans,
-- scheduled/published via Buffer (or webhook automation), and their metrics synced back.

-- Connected publishing channels (one row per social account the project posts to).
create table if not exists public.marketing_channels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  provider text not null,                       -- buffer | typefully | x | linkedin | webhook
  platform text not null,                       -- twitter | linkedin | facebook | instagram | mastodon | threads
  external_id text,                             -- Buffer profile id, etc.
  handle text,                                  -- @handle / page name
  status text default 'connected' check (status in ('connected','disconnected','error')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  unique (project_id, provider, external_id)
);

create table if not exists public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  name text not null,
  objective text default 'awareness' check (objective in ('awareness','launch','feature','educational','engagement','conversion')),
  description text,
  status text default 'active' check (status in ('draft','active','completed','archived')),
  starts_on date,
  ends_on date,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create table if not exists public.marketing_posts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  campaign_id uuid references public.marketing_campaigns(id) on delete set null,
  channel_id uuid references public.marketing_channels(id) on delete set null,
  platform text default 'twitter',
  status text default 'draft' check (status in ('draft','scheduled','publishing','published','failed')),
  objective text,                               -- awareness | launch | feature | educational | engagement | conversion
  tone text,                                    -- professional | casual | bold | technical | playful
  angle text,                                   -- the content angle / hook used
  content text not null,
  hashtags text[] default '{}',
  cta text,
  media_url text,
  source text default 'ai',                     -- ai | manual
  source_scan_id uuid,                          -- scan_result that informed generation
  external_post_id text,                        -- id returned by Buffer / platform
  scheduled_at timestamptz,
  published_at timestamptz,
  error_message text,
  ai_meta jsonb default '{}'::jsonb,            -- provider/model/usage
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- One metrics snapshot per post (latest engagement figures synced from the platform).
create table if not exists public.marketing_post_metrics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  post_id uuid references public.marketing_posts(id) on delete cascade,
  impressions int default 0,
  likes int default 0,
  comments int default 0,
  shares int default 0,
  clicks int default 0,
  engagement_rate numeric default 0,            -- 0..1
  collected_at timestamptz default now(),
  unique (post_id)
);

-- RLS: workspace members read; members (owner/admin/member) manage.
do $$
declare t text;
begin
  foreach t in array array['marketing_channels','marketing_campaigns','marketing_posts','marketing_post_metrics']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format($f$
      create policy "Members read %1$s"
      on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format($f$
      create policy "Members manage %1$s"
      on public.%1$s for all
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
          and wm.role in ('owner','admin','member')))
      with check (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
          and wm.role in ('owner','admin','member')));
    $f$, t);
  end loop;
end $$;

create index if not exists idx_mkt_posts_project on public.marketing_posts(project_id, created_at desc);
create index if not exists idx_mkt_posts_status on public.marketing_posts(project_id, status);
create index if not exists idx_mkt_channels_project on public.marketing_channels(project_id);
create index if not exists idx_mkt_campaigns_project on public.marketing_campaigns(project_id, created_at desc);
create index if not exists idx_mkt_metrics_post on public.marketing_post_metrics(post_id);
