-- 0203 · Appairage du Skill Recorder — une identité par POSTE, pas un secret partagé.
--
-- Le recorder tourne sur la machine de quelqu'un, pour son compte, dans son
-- workspace. Lui faire emprunter le token du test-runner (identité d'un serveur
-- d'exécution partagé) l'obligeait à copier un secret à large portée, depuis un
-- écran d'ailleurs retiré de la nav.
--
-- À la place, un flux d'appairage par code, comme `gh auth login` :
--   1. le recorder démarre sans aucun secret et demande un code (rec_pair_start) ;
--   2. il affiche « CODE : 7KQ2-M4XB » et attend ;
--   3. l'utilisateur, DÉJÀ authentifié dans FounderOS, saisit ce code ;
--      c'est ce geste qui lie l'appareil à son workspace et à son compte ;
--   4. le recorder reçoit son propre token, l'écrit dans .auth.json et ne
--      redemande plus rien.
--
-- Le code est court, à usage unique, et expire en 10 minutes : il n'a de valeur
-- que dans la main de quelqu'un qui peut aussi s'authentifier dans l'app.

create table if not exists public.recorder_devices (
  id            uuid primary key default gen_random_uuid(),
  -- Renseignés à l'appairage, par l'utilisateur qui saisit le code : avant
  -- cela, l'appareil n'appartient à personne.
  workspace_id  uuid references public.workspaces(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete cascade,
  name          text not null default 'Poste inconnu',

  -- Le code d'appairage, en clair : il est éphémère, à usage unique, et sans
  -- valeur une fois consommé. Le TOKEN, lui, n'est stocké que haché.
  pairing_code  text,
  pairing_expires_at timestamptz,
  token_hash    text,

  paired_at     timestamptz,
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

-- Un code en attente doit être unique pour que sa saisie désigne un appareil et
-- un seul. L'index partiel laisse les codes consommés (mis à null) tranquilles.
create unique index if not exists idx_recorder_devices_code
  on public.recorder_devices(pairing_code) where pairing_code is not null;
create unique index if not exists idx_recorder_devices_token
  on public.recorder_devices(token_hash) where token_hash is not null;
create index if not exists idx_recorder_devices_ws
  on public.recorder_devices(workspace_id) where revoked_at is null;

alter table public.recorder_devices enable row level security;

-- Un membre voit et révoque les appareils de son workspace. Les lignes non
-- appairées (workspace_id null) ne sont visibles de personne : seule l'edge
-- function, en service role, les manipule pendant les dix minutes d'attente.
drop policy if exists "members manage recorder_devices" on public.recorder_devices;
create policy "members manage recorder_devices" on public.recorder_devices for all
  using (
    recorder_devices.workspace_id is not null
    and exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = recorder_devices.workspace_id and wm.user_id = auth.uid()
    )
  )
  with check (
    recorder_devices.workspace_id is not null
    and exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = recorder_devices.workspace_id and wm.user_id = auth.uid()
    )
  );

-- Trace de l'appareil qui a produit une démonstration (qui a filmé quoi).
alter table public.skill_recordings add column if not exists device_id uuid
  references public.recorder_devices(id) on delete set null;
