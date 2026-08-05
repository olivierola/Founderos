-- 0128_office_media.sql
-- Studios Image / Vidéo du module Office : vraie génération (fal.ai FLUX/Kling
-- ou OpenAI gpt-image-1/Sora via le connecteur du workspace) pilotée par
-- office-ai (op media.*). Les fichiers générés sont stockés dans le bucket
-- public `office-media` ; cette table est la galerie persistée.

create table if not exists public.office_media (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  project_id    uuid not null references public.projects(id) on delete cascade,
  kind          text not null check (kind in ('image','video')),
  prompt        text not null,
  ratio         text,
  provider      text not null,                  -- 'fal' | 'openai'
  model         text,
  status        text not null default 'generating'
                check (status in ('generating','ready','failed')),
  request_id    text,                           -- job id provider (fal request / sora video)
  url           text,                           -- URL publique une fois stocké
  storage_path  text,
  error_message text,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_office_media_project
  on public.office_media(project_id, kind, created_at desc);

alter table public.office_media enable row level security;

-- Lecture/suppression par les membres du workspace ; les écritures passent par
-- l'edge fn office-ai (service role).
create policy "Members read office_media"
on public.office_media for select
using (exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = office_media.workspace_id and wm.user_id = auth.uid()
));

create policy "Members delete office_media"
on public.office_media for delete
using (exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = office_media.workspace_id and wm.user_id = auth.uid()
));

-- Bucket public pour servir les médias générés directement dans <img>/<video>.
insert into storage.buckets (id, name, public)
values ('office-media', 'office-media', true)
on conflict (id) do nothing;
