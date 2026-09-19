-- 0218 · Formation guidée — l'agent MONTRE, l'humain FAIT.
--
-- 0202 a appris à l'agent une procédure en la lui montrant. 0205 lui a permis
-- de l'exécuter à la place de quelqu'un. Il manquait le geste inverse, qui est
-- celui de l'onboarding : l'agent connaît la procédure, et c'est le NOUVEL
-- ARRIVANT qui doit la faire — dans son navigateur, avec ses comptes, sur le
-- vrai outil.
--
-- ┌─ POURQUOI UN CANAL SÉPARÉ DU PILOTAGE ─────────────────────────────────┐
-- │ Le pilotage (0205) agit : il clique, il saisit, il valide. Guider ne    │
-- │ fait rien de tout ça — l'agent pose un repère sur un bouton, écrit une  │
-- │ phrase, et ATTEND. Deux pouvoirs très différents ne peuvent pas         │
-- │ partager le même consentement : accepter d'être formé ne peut pas       │
-- │ revenir à donner les clés de ses onglets.                              │
-- │                                                                        │
-- │ D'où deux armements distincts, et une contrainte tenue côté extension   │
-- │ comme ici : sur le canal `coach`, aucune commande mutante n'est servie. │
-- │ Le mode formation dure plus longtemps (une session de formation, ce     │
-- │ n'est pas quinze minutes) précisément parce qu'il peut moins.           │
-- └────────────────────────────────────────────────────────────────────────┘

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. L'armement « mode formation », à côté de l'armement « pilotage »
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.recorder_devices
  add column if not exists coach_until   timestamptz,
  -- Vide = tous les domaines. Sinon, hôtes sur lesquels le coach peut s'afficher.
  add column if not exists coach_origins text[] not null default '{}';

comment on column public.recorder_devices.coach_until is
  'Fenêtre pendant laquelle un agent peut AFFICHER des repères de formation dans les onglets de cet appareil. N''autorise aucune action : voir browser_commands.channel.';

-- Le canal sépare ce qui agit de ce qui montre. Une commande de guidage émise
-- pendant que seul le pilotage est armé reste servie (qui peut le plus peut le
-- moins) ; l'inverse ne l'est jamais.
alter table public.browser_commands
  add column if not exists channel text not null default 'control'
    check (channel in ('control', 'coach'));

comment on column public.browser_commands.channel is
  'control = l''agent agit dans la page (0205). coach = l''agent affiche un repère et attend un geste humain (0218). Le canal coach n''accepte que des actions non mutantes.';

create index if not exists idx_browser_commands_queue_channel
  on public.browser_commands(device_id, channel, created_at) where status = 'pending';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Le parcours de formation
-- ═══════════════════════════════════════════════════════════════════════════
-- Un programme dit CE QU'ON APPREND et DANS QUEL OUTIL. Il ne redit pas la
-- procédure : celle-ci vit déjà dans les skills démontrées (0202), qui portent
-- leurs gestes dans steps.json. Un programme les référence, et n'écrit à la
-- main que ce qu'aucune démonstration ne contient — l'ordre pédagogique, les
-- objectifs, les pièges maison.

create table if not exists public.training_programs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id   uuid references public.projects(id) on delete cascade,
  -- L'agent formateur qui anime ce parcours (facultatif : n'importe lequel peut).
  agent_id     uuid references public.internal_agents(id) on delete set null,
  title        text not null,
  -- L'outil visé : « HubSpot », « Jira », « notre back-office ». C'est ce que
  -- le nouvel arrivant cherche, pas le nom du parcours.
  tool_name    text,
  tool_url     text,
  -- À qui ça s'adresse : « SDR », « Support niveau 1 », « tout le monde ».
  audience     text,
  summary      text,
  objectives   text[] not null default '{}',
  -- Les procédures démontrées qui composent le parcours, dans l'ordre.
  skill_ids    uuid[] not null default '{}',
  -- Étapes écrites à la main, quand aucune démonstration ne les couvre :
  -- [{ title, instruction, tip, target: {...}, expect, url, gesture }]
  steps        jsonb not null default '[]',
  est_minutes  int,
  is_published boolean not null default false,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_training_programs_ws
  on public.training_programs(workspace_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Une session = une personne, un parcours, une fois
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.training_sessions (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  program_id      uuid references public.training_programs(id) on delete set null,
  agent_id        uuid references public.internal_agents(id) on delete set null,
  run_id          uuid,
  -- Le formé. Souvent un membre du workspace ; parfois un arrivant qui n'a pas
  -- encore de compte, d'où les champs libres à côté de la référence.
  trainee_user_id uuid references auth.users(id) on delete set null,
  trainee_name    text,
  trainee_email   text,
  status          text not null default 'in_progress'
    check (status in ('in_progress', 'paused', 'done', 'abandoned')),
  current_step    int not null default 0,
  total_steps     int,
  -- Ce que la session a coûté au formé : les blocages sont le vrai signal.
  -- Une étape sur laquelle trois personnes sur quatre se bloquent n'est pas un
  -- problème de formés, c'est une procédure à réécrire.
  stuck_count     int not null default 0,
  hint_count      int not null default 0,
  duration_ms     int,
  summary         text,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_training_sessions_ws
  on public.training_sessions(workspace_id, started_at desc);
create index if not exists idx_training_sessions_program
  on public.training_sessions(program_id, started_at desc);

create table if not exists public.training_step_logs (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.training_sessions(id) on delete cascade,
  seq         int not null,
  title       text,
  instruction text,
  target      jsonb not null default '{}',
  url         text,
  -- done      : le formé l'a fait
  -- stuck     : il a demandé de l'aide sur cette étape
  -- skipped   : passée, volontairement
  -- timeout   : plus de réponse — il a quitté, ou il cherche encore
  -- not_found : le repère n'a pas pu être posé (l'outil a changé)
  outcome     text not null default 'done'
    check (outcome in ('done', 'stuck', 'skipped', 'timeout', 'not_found', 'answered')),
  attempts    int not null default 1,
  hints       int not null default 0,
  duration_ms int,
  note        text,
  created_at  timestamptz not null default now(),
  unique (session_id, seq)
);

create index if not exists idx_training_step_logs_session
  on public.training_step_logs(session_id, seq);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. RLS
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.training_programs  enable row level security;
alter table public.training_sessions  enable row level security;
alter table public.training_step_logs enable row level security;

drop policy if exists "members manage training_programs" on public.training_programs;
create policy "members manage training_programs" on public.training_programs for all
  using  (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = training_programs.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = training_programs.workspace_id and wm.user_id = auth.uid()));

drop policy if exists "members manage training_sessions" on public.training_sessions;
create policy "members manage training_sessions" on public.training_sessions for all
  using  (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = training_sessions.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = training_sessions.workspace_id and wm.user_id = auth.uid()));

-- Les pas héritent des droits de leur session (même règle que
-- skill_recording_events vis-à-vis de skill_recordings).
drop policy if exists "members manage training_step_logs" on public.training_step_logs;
create policy "members manage training_step_logs" on public.training_step_logs for all
  using (exists (
    select 1 from public.training_sessions s
    join public.workspace_members wm on wm.workspace_id = s.workspace_id
    where s.id = training_step_logs.session_id and wm.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.training_sessions s
    join public.workspace_members wm on wm.workspace_id = s.workspace_id
    where s.id = training_step_logs.session_id and wm.user_id = auth.uid()
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Le skill : la doctrine du formateur
-- ═══════════════════════════════════════════════════════════════════════════
-- Ce qui distingue une formation d'une exécution ne tient pas dans l'outillage
-- mais dans la retenue : savoir ne PAS faire à la place, découper au bon
-- grain, se taire quand la personne avance. C'est ce texte-là.

delete from public.agent_skills where workspace_id is null and slug = 'guided-onboarding';

insert into public.agent_skills (workspace_id, name, slug, description, category, icon, system_prompt_extension, required_tools, is_system)
values (
  null, 'Formation guidée dans l''outil', 'guided-onboarding',
  'Accompagner une personne pas à pas dans un vrai outil en ligne : poser un repère sur le bon élément, dire quoi faire, attendre qu''elle le fasse.',
  'onboarding', 'GraduationCap',
  $DOC$Tu formes une personne à un outil, DANS l'outil, pendant qu'elle l'utilise pour de vrai.

LA RÈGLE QUI COMMANDE TOUTES LES AUTRES
Tu ne fais jamais à sa place. Ta main ne touche pas sa souris : guide_user pose un repère et écrit une phrase, puis tu attends. Une manipulation faite à sa place n'apprend rien — elle a l'air d'un gain de temps et coûte une deuxième formation. Si tu disposes aussi de user_browser, ne l'utilise PAS pendant une formation, même quand la personne le demande : elle apprend en faisant.

AVANT DE COMMENCER
1. Récupère le parcours (training action="get_program") et lis la procédure référencée : read_skill_file(slug, "steps.json") donne les gestes exacts tels qu'ils ont été démontrés, et le corps du skill donne le sens.
2. Ouvre une session (training action="start") : sans elle, rien de ce que tu observes ne sera réutilisable pour améliorer le parcours.
3. Dis en deux phrases ce qu'on va faire et ce que la personne saura faire à la fin. Pas de plan en douze points : personne ne le lit.
4. Demande-lui d'ouvrir l'outil et d'être connectée. Tu ne te connectes jamais pour elle, et tu ne demandes jamais un mot de passe.

LE GRAIN D'UNE ÉTAPE
Une étape = un geste que la personne peut faire sans réfléchir à autre chose : un clic, un champ, un choix. « Crée le contact » n'est pas une étape, c'en est six. Le bon test : si ton instruction contient « puis », coupe-la.
Chaque étape porte une instruction à l'impératif (≤ 15 mots), et le pourquoi va dans le tip, pas dans l'instruction : « Clique sur Nouveau contact » d'un côté, « c'est ici que tout commence, l'import en masse est ailleurs » de l'autre.

QUAND LE REPÈRE NE SE POSE PAS
guide_user te répond target_not_found quand l'élément n'existe pas sur la page. Ne réécris pas la même cible en espérant mieux : appelle guide_user action="look" pour lire ce qui est RÉELLEMENT à l'écran, et re-vise avec un libellé que tu y as lu. Si l'outil a changé depuis la démonstration, dis-le à la personne et note-le — la procédure est à refaire, ce n'est pas elle qui se trompe.

QUAND ELLE BLOQUE
Le résultat stuck n'est pas un échec, c'est une information. Réponds dans cet ordre : (1) reformule le repère autrement — ce qu'elle cherche des yeux, pas ce qu'il faut cliquer ; (2) explique ce qui se passe à l'écran (une modale s'est ouverte, un filtre est actif) ; (3) propose de passer et de revenir. Ne répète jamais deux fois la même phrase : si elle n'a pas marché la première fois, c'est la phrase qui est mauvaise.

LE TON
Tu parles à quelqu'un dont c'est le premier jour, pas à un utilisateur avancé. Pas de jargon interne sans le traduire une fois. Pas de félicitations à chaque clic — on ne félicite pas quelqu'un d'avoir cliqué sur un bouton ; on le fait quand une vraie tâche est terminée, et ça compte parce que c'est rare.
Un conseil (tip) sur deux étapes environ, pas à chaque fois : le raccourci clavier, le piège classique, ce que les collègues font autrement. C'est ce qui distingue une formation d'une documentation.

À LA FIN
training action="finish", avec un résumé honnête : ce qui est acquis, ce qui a bloqué, ce qu'il faut revoir. Puis, si le parcours a fait trébucher plusieurs personnes au même endroit (training action="blockers"), dis-le au responsable : la procédure est à corriger, et c'est toi qui as la donnée.

CE QUE TU NE FAIS JAMAIS
- Saisir un identifiant, un mot de passe, un code à usage unique — même dicté.
- Guider hors de l'outil concerné (messagerie personnelle, banque, RH) : si la personne y navigue, mets la formation en pause.
- Prétendre qu'une étape est faite alors que le résultat dit timeout. Attends, ou demande.$DOC$,
  array['guide_user', 'training', 'read_skill_file'],
  true
);
