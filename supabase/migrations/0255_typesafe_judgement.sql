-- 0255_typesafe_judgement.sql
-- Le jugement rapide (TypeSafe / Jev) — branché PARTOUT, actif NULLE PART par défaut.
--
-- Jev est un modèle « System One » : on lui donne un état et des questions
-- typées, il rend des réponses typées avec leur probabilité, en une passe.
-- Pas de texte généré, ~0,1-0,3 s, 42 $ le milliard de tokens d'entrée (sortie
-- gratuite) contre 25 c€ le million chez notre fournisseur le moins cher.
--
-- Ce qu'il remplace chez nous : les micro-jugements que l'on paie aujourd'hui en
-- raisonnement (quelle skill charger, quel agent est le bon, ce run est-il fini,
-- ce passage est-il pertinent, ce message est-il dangereux). Ce qu'il ne
-- remplace pas : tout ce qui ÉCRIT — il ne produit pas une phrase.
--
-- ── Pourquoi une table de réglages plutôt qu'un secret et basta ──────────────
--
-- Parce qu'on ne branche pas un fournisseur d'un mois sur le chemin critique
-- d'un produit facturé. Chaque usage a donc TROIS états :
--
--   off     — aucun appel n'est fait. C'est le défaut, partout.
--   shadow  — l'appel est fait, la réponse est JOURNALISÉE, et le code garde
--             son comportement actuel. C'est le mode qui permet de comparer sur
--             des données réelles avant de décider.
--   on      — la réponse est utilisée.
--
-- Revenir en arrière, c'est repasser un réglage à `off` : aucun déploiement,
-- aucune migration, et le code d'origine n'a jamais été retiré — il est le
-- chemin de repli, pris aussi quand l'API est lente, absente ou en erreur.

create table if not exists public.typesafe_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,

  -- { "<usage>": { "mode": "off|shadow|on", "threshold": 0.7, "min_confidence": 0.6 } }
  -- Un objet libre plutôt qu'une colonne par usage : la liste des usages va
  -- bouger plus vite que le schéma, et une migration par expérience est le plus
  -- sûr moyen de ne plus en tenter aucune.
  features jsonb not null default '{}'::jsonb,

  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

comment on table public.typesafe_settings is
  'Réglages du jugement rapide (TypeSafe/Jev), par espace de travail. Chaque usage vaut off (aucun appel), shadow (appelé et journalisé, sans effet) ou on (utilisé).';

alter table public.typesafe_settings enable row level security;

drop policy if exists "members read typesafe settings" on public.typesafe_settings;
create policy "members read typesafe settings" on public.typesafe_settings for select
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = typesafe_settings.workspace_id and wm.user_id = auth.uid()));

-- Écriture réservée aux administrateurs de l'espace : activer un jugement
-- automatique sur les garde-fous ou les approbations est une décision de
-- gouvernance, pas un réglage d'affichage.
drop policy if exists "admins write typesafe settings" on public.typesafe_settings;
create policy "admins write typesafe settings" on public.typesafe_settings for all
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = typesafe_settings.workspace_id
                    and wm.user_id = auth.uid() and wm.role in ('owner', 'admin')))
  with check (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = typesafe_settings.workspace_id
                    and wm.user_id = auth.uid() and wm.role in ('owner', 'admin')));

-- ── Le journal ───────────────────────────────────────────────────────────────
-- Sans lui, le mode `shadow` ne servirait à rien : c'est ici qu'on lit ce que
-- le modèle aurait décidé, avec quelle confiance, en combien de temps et pour
-- combien. C'est aussi la preuve qu'exige la gouvernance dès qu'un jugement
-- automatique bloque un message ou approuve une action.

create table if not exists public.typesafe_judgements (
  id            bigserial primary key,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  project_id    uuid references public.projects(id) on delete cascade,

  -- L'usage (guardrails, skill_ranking, agent_choice…) et le mode où il tournait.
  feature       text not null,
  mode          text not null check (mode in ('shadow', 'on')),
  -- La réponse a-t-elle CHANGÉ quelque chose. Faux en shadow, faux aussi quand
  -- la confiance est retombée sous le seuil et qu'on a gardé l'ancien chemin.
  applied       boolean not null default false,

  -- De quoi relier un jugement à ce qu'il jugeait.
  run_id        uuid,
  subject       text,

  questions     jsonb not null default '{}'::jsonb,
  answers       jsonb,
  confidence    numeric(4, 3),

  model         text,
  latency_ms    int,
  input_tokens  int,
  cost_cents    numeric(10, 4),
  error         text,

  created_at    timestamptz not null default now()
);

create index if not exists idx_typesafe_judgements_ws
  on public.typesafe_judgements(workspace_id, created_at desc);
create index if not exists idx_typesafe_judgements_feature
  on public.typesafe_judgements(workspace_id, feature, created_at desc);

alter table public.typesafe_judgements enable row level security;

drop policy if exists "members read typesafe judgements" on public.typesafe_judgements;
create policy "members read typesafe judgements" on public.typesafe_judgements for select
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = typesafe_judgements.workspace_id and wm.user_id = auth.uid()));

-- Écriture réservée au runtime (service_role) : un journal modifiable depuis le
-- client ne prouve plus rien de ce qui a été décidé.
