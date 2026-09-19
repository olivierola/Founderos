-- 0212_company_context.sql
-- Le contexte d'entreprise — la couche qui manquait SOUS la workforce.
--
-- Constat de l'audit : sur 211 migrations, aucune table ne décrivait
-- l'entreprise elle-même. `projects` porte un nom, une description et une
-- stack détectée ; c'est tout. Et `internal-agent-run` ne lisait même pas
-- cette ligne : le prompt système d'un agent contenait son identité, son âme,
-- ses instructions, sa mémoire et ses skills — jamais l'entreprise pour
-- laquelle il travaille.
--
-- Conséquence concrète, visible dans les runs : chaque agent redécouvrait
-- l'activité, le marché, la cible et le ton à chaque tâche, en les déduisant
-- de sa mémoire ou en les demandant. Deux agents de deux services donnaient
-- deux réponses différentes à « qui est notre client type ? ». Et la promesse
-- produit — « décrivez ce que votre entreprise doit accomplir, les agents
-- s'organisent » — n'avait aucun endroit où atterrir.
--
-- D'où deux objets, et deux seulement :
--
--   • company_profile    — CE QU'EST l'entreprise. Une ligne par projet, des
--     champs nommés (activité, marché, ICP, proposition de valeur, ton,
--     contraintes, non-négociables). Stable, court, toujours envoyé.
--   • company_objectives — CE QU'ELLE DOIT ACCOMPLIR. Un arbre : un objectif
--     porte des sous-objectifs, chacun mesuré par une métrique avec une cible
--     et une valeur courante. Rattaché à un service porteur et, si on veut, à
--     un agent nommément responsable.
--
-- Pourquoi des champs nommés plutôt qu'un texte libre : un texte libre part en
-- entier dans le prompt ou pas du tout, et il ne se compare pas d'un projet à
-- l'autre. Des champs nommés se rendent ligne à ligne, se sélectionnent par
-- pertinence pour la tâche du moment (comme les préférences, cf. 0210) et se
-- remplissent progressivement — un profil à moitié rempli reste utile.
--
-- Pourquoi un ARBRE d'objectifs : c'est la décomposition attendue (« on veut
-- 100 nouveaux clients ce trimestre », chaque service en dérive sa part).
-- Sans parent_id, on a une liste de vœux ; avec, on a une chaîne de causalité
-- qu'un agent peut remonter pour savoir POURQUOI on lui demande ça.

-- ── Le profil : une ligne par projet ────────────────────────────────────────
create table if not exists public.company_profile (
  project_id       uuid primary key references public.projects(id) on delete cascade,
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,

  -- Qui elle est. Chaque champ est UNE phrase — pas un paragraphe : ce qui
  -- part dans un prompt système doit être lisible d'un coup d'œil par le
  -- modèle comme par l'humain qui l'écrit.
  legal_name       text,
  activity         text,   -- ce qu'elle fait
  mission          text,   -- pourquoi elle le fait
  market           text,   -- sur quel marché
  icp              text,   -- à qui elle vend (client idéal)
  value_prop       text,   -- ce qu'elle promet
  differentiators  text,   -- ce qui la distingue

  -- Comment on y travaille.
  stage            text,   -- idée · amorçage · croissance · établie
  team_size        int,
  geographies      text[] not null default '{}'::text[],
  languages        text[] not null default '{}'::text[],
  tone             text,   -- ton de voix opposable aux agents

  -- Ce qui borne l'action. `non_negotiables` est la seule partie du profil qui
  -- soit une RÈGLE et pas une information : elle est rendue comme telle dans
  -- le prompt, au même rang que les règles de sécurité.
  constraints      text,
  non_negotiables  text,

  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id)
);

comment on table public.company_profile is
  'Ce qu''est l''entreprise. Une ligne par projet, injectée dans le prompt système de chaque agent (section "company").';
comment on column public.company_profile.non_negotiables is
  'Ce que les agents ne doivent JAMAIS faire, en clair. Rendu comme une règle, pas comme une information.';

-- ── Les objectifs : un arbre mesuré ─────────────────────────────────────────
create table if not exists public.company_objectives (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  project_id         uuid not null references public.projects(id) on delete cascade,
  -- L'arbre. Un objectif d'entreprise porte des objectifs de service, qui
  -- portent des objectifs d'agent. Suppression en cascade : un sous-objectif
  -- sans parent n'a plus de sens.
  parent_id          uuid references public.company_objectives(id) on delete cascade,

  title              text not null,
  detail             text,

  -- La mesure. Un objectif sans métrique reste recevable (on ne force pas la
  -- main au démarrage), mais il ne comptera dans aucun calcul d'avancement.
  metric             text,
  unit               text,
  baseline_value     numeric,
  target_value       numeric,
  current_value      numeric,
  direction          text not null default 'increase'
                       check (direction in ('increase','decrease','maintain')),

  period_start       date,
  period_end         date,
  status             text not null default 'active'
                       check (status in ('draft','active','at_risk','done','abandoned')),
  priority           int not null default 3 check (priority between 1 and 5),

  -- Qui le porte. Le service est le porteur naturel (c'est l'unité
  -- d'organisation du produit) ; l'agent responsable est optionnel et sert à
  -- ce qu'un objectif apparaisse nommément dans SON contexte.
  owner_dashboard_id uuid references public.service_dashboards(id) on delete set null,
  owner_agent_id     uuid references public.internal_agents(id) on delete set null,

  -- Traçabilité de la dernière mesure : un chiffre qui bouge tout seul sans
  -- qu'on sache qui l'a mis à jour ressemble à un bug, pas à un pilotage.
  measured_at        timestamptz,
  measured_by        text check (measured_by in ('user','agent')),
  -- D'OÙ vient le dernier chiffre. Un champ à part, jamais `detail` : la
  -- description de l'objectif est écrite par un humain et un agent qui met à
  -- jour une mesure n'a aucune raison de l'écraser.
  measured_note      text,

  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_company_objectives_project
  on public.company_objectives(project_id, status, priority);
create index if not exists idx_company_objectives_parent
  on public.company_objectives(parent_id) where parent_id is not null;
create index if not exists idx_company_objectives_owner_dash
  on public.company_objectives(owner_dashboard_id) where owner_dashboard_id is not null;
create index if not exists idx_company_objectives_owner_agent
  on public.company_objectives(owner_agent_id) where owner_agent_id is not null;

comment on table public.company_objectives is
  'Ce que l''entreprise doit accomplir, en arbre (objectif -> sous-objectifs), mesuré et rattaché à un service porteur.';

-- ── RLS : membres du workspace ──────────────────────────────────────────────
alter table public.company_profile    enable row level security;
alter table public.company_objectives enable row level security;

drop policy if exists "members manage company_profile" on public.company_profile;
create policy "members manage company_profile" on public.company_profile for all
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = company_profile.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = company_profile.workspace_id and wm.user_id = auth.uid()));

drop policy if exists "members manage company_objectives" on public.company_objectives;
create policy "members manage company_objectives" on public.company_objectives for all
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = company_objectives.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = company_objectives.workspace_id and wm.user_id = auth.uid()));

-- ── Amorce : ce qu'on sait déjà de l'entreprise vit déjà dans `projects` ─────
-- Un profil vide est un écran vide, et un écran vide ne se remplit jamais. On
-- reprend donc la description du projet comme première phrase d'activité : ce
-- n'est pas la vérité finale, c'est un point de départ que l'écran Contexte
-- donne à corriger.
insert into public.company_profile (project_id, workspace_id, activity)
select p.id, p.workspace_id, nullif(trim(coalesce(p.description, '')), '')
  from public.projects p
 where p.workspace_id is not null
on conflict (project_id) do nothing;
