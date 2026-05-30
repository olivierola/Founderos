-- Enrich the deployments table with first-class columns for fields that were
-- previously only in metadata. This lets the UI filter, sort and aggregate on
-- them without unpacking JSONB on every query.

alter table public.deployments
  add column if not exists kind text not null default 'deploy'
    check (kind in ('deploy','release','infra_event')),
  add column if not exists duration_ms bigint,
  add column if not exists author text,
  add column if not exists commit_message text;

create index if not exists deployments_project_created_idx
  on public.deployments(project_id, created_at_provider desc);
create index if not exists deployments_project_kind_idx
  on public.deployments(project_id, kind);
create index if not exists deployments_project_provider_idx
  on public.deployments(project_id, provider);

-- Backfill from metadata for rows already synced (Vercel pulled author /
-- commit_message / build_duration_ms into metadata in the previous version).
update public.deployments
   set author = coalesce(author, (metadata->>'author')),
       commit_message = coalesce(commit_message, (metadata->>'commit_message')),
       duration_ms = coalesce(duration_ms, nullif(metadata->>'build_duration_ms','')::bigint)
 where (metadata ? 'author') or (metadata ? 'commit_message') or (metadata ? 'build_duration_ms');
