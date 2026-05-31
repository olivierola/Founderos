-- Add a metadata jsonb column to marketing_posts. Some flows (Visual generator,
-- analytics enrichment) write structured side data here; the original 0013
-- migration shipped without it so updates with `metadata` were failing
-- silently on the client.

alter table public.marketing_posts
  add column if not exists metadata jsonb default '{}'::jsonb;
