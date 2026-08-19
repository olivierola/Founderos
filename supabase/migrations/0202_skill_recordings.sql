-- 0202 · Skill recordings — apprentissage par démonstration.
--
-- L'utilisateur fait son travail dans un navigateur piloté par Playwright
-- (paquet `skill-recorder/`) pendant qu'il COMMENTE ce qu'il fait au micro.
-- Les deux flux atterrissent dans la MÊME table d'événements, datés en
-- millisecondes depuis `started_at`, ce qui rend l'association narration ↔
-- action purement chronologique (un simple order by at_ms).
--
-- Le cycle de vie d'un enregistrement :
--   pending    — créé par l'app, en attente qu'un recorder local le réclame
--   recording  — un recorder l'a réclamé et pousse des événements
--   stopping   — l'utilisateur a cliqué "Arrêter" ; le recorder le voit à sa
--                prochaine poussée d'événements et referme proprement
--   processing — la timeline part en synthèse LLM
--   ready      — la skill est écrite (skill_id) ; failed / cancelled sinon

create table if not exists public.skill_recordings (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id   uuid references public.projects(id) on delete cascade,
  -- Agent auquel la skill produite sera activée d'office (optionnel).
  agent_id     uuid references public.internal_agents(id) on delete set null,
  created_by   uuid references auth.users(id) on delete set null,
  title        text not null default 'Nouvelle compétence',
  -- Ce que l'utilisateur annonce vouloir démontrer, saisi AVANT de démarrer :
  -- c'est le meilleur indice d'intention dont dispose la synthèse.
  goal         text,
  start_url    text,
  status       text not null default 'pending',
  runner_id    text,
  claimed_at   timestamptz,
  started_at   timestamptz,
  ended_at     timestamptz,
  heartbeat_at timestamptz,
  duration_ms  int,
  event_count  int not null default 0,
  narration    text,
  skill_id     uuid references public.agent_skills(id) on delete set null,
  error        text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_skill_recordings_ws     on public.skill_recordings(workspace_id, created_at desc);
create index if not exists idx_skill_recordings_status on public.skill_recordings(status) where status in ('pending', 'recording', 'stopping');

-- Un événement = un geste (clic, saisie, navigation…) OU un segment de
-- narration. `source` sépare les deux compteurs de séquence pour que chaque
-- producteur puisse rejouer un lot sans écraser l'autre (l'unique ci-dessous
-- rend les poussées idempotentes en cas de retry réseau).
create table if not exists public.skill_recording_events (
  id           uuid primary key default gen_random_uuid(),
  recording_id uuid not null references public.skill_recordings(id) on delete cascade,
  source       text not null default 'browser',   -- browser | narration | user
  seq          int  not null,
  at_ms        int  not null,                     -- offset depuis skill_recordings.started_at
  kind         text not null,                     -- click|fill|select|check|press|submit|navigate|upload|copy|scroll|tab_open|tab_close|narration|note
  url          text,
  -- Tout ce qui permet de re-cibler l'élément plus tard, du plus stable au
  -- moins stable : {label, role, tag, testid, name, placeholder, css, text, frame}
  target       jsonb not null default '{}',
  value        text,
  -- Vrai quand la valeur a été caviardée à la source (mot de passe, carte…) :
  -- la synthèse en fait une variable {{...}} au lieu d'une constante.
  is_secret    boolean not null default false,
  duration_ms  int,                               -- longueur d'un segment de narration
  screenshot_url text,
  created_at   timestamptz not null default now(),
  unique (recording_id, source, seq)
);

create index if not exists idx_skill_recording_events_timeline
  on public.skill_recording_events(recording_id, at_ms);

alter table public.skill_recordings       enable row level security;
alter table public.skill_recording_events enable row level security;

drop policy if exists "members manage skill_recordings" on public.skill_recordings;
create policy "members manage skill_recordings" on public.skill_recordings for all
  using  (exists (select 1 from public.workspace_members wm where wm.workspace_id = skill_recordings.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm where wm.workspace_id = skill_recordings.workspace_id and wm.user_id = auth.uid()));

-- Les événements héritent des droits de l'enregistrement parent (mêmes règles
-- que agent_skill_files vis-à-vis de agent_skills). Le recorder écrit via le
-- service role (edge function), qui contourne RLS.
drop policy if exists "members manage skill_recording_events" on public.skill_recording_events;
create policy "members manage skill_recording_events" on public.skill_recording_events for all
  using (exists (
    select 1 from public.skill_recordings r
    join public.workspace_members wm on wm.workspace_id = r.workspace_id
    where r.id = skill_recording_events.recording_id and wm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.skill_recordings r
    join public.workspace_members wm on wm.workspace_id = r.workspace_id
    where r.id = skill_recording_events.recording_id and wm.user_id = auth.uid()
  ));

-- La skill produite garde un lien vers la démonstration qui l'a engendrée.
alter table public.agent_skills add column if not exists source_recording_id uuid
  references public.skill_recordings(id) on delete set null;

-- ============================================================================
-- Storage : captures d'écran poussées par le recorder. Lecture publique (comme
-- test-artifacts) pour que la timeline affiche les vignettes ; les écritures
-- passent par le service role, qui contourne RLS.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('skill-recordings', 'skill-recordings', true)
on conflict (id) do nothing;

drop policy if exists "skill-recordings select" on storage.objects;
create policy "skill-recordings select"
  on storage.objects for select
  using (bucket_id = 'skill-recordings');
