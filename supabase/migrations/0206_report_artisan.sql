-- 0206_report_artisan.sql
--
-- Un seul agent écrit tous les rapports.
--
-- Jusqu'ici chaque agent portait le skill `report-authoring`, activé par trigger
-- à sa création : tous devaient connaître le catalogue de blocs, la structure
-- d'un document qui se lit, le plancher de profondeur — plusieurs milliers de
-- jetons de doctrine dans le prompt d'un agent dont le métier est de scraper
-- une API. Et la qualité suivait celui qui écrivait : chaque agent rendait un
-- rapport un peu différent.
--
-- Le Rédacteur remplace ça. Un agent système par projet, jamais absent, jamais
-- supprimable, dont c'est le SEUL métier. Les autres agents ne rédigent plus :
-- ils rassemblent la matière (chiffres, sources, constats) et la lui passent
-- avec request_report. Lui seul porte le skill, lui seul publie.
--
-- Ce qu'il produit change aussi de nature : plus des blocs rendus par l'app,
-- mais un fichier HTML autonome (bannières, graphiques SVG, indicateurs,
-- éditeur embarqué) construit par le moteur Report Artisan — un livrable qui
-- s'ouvre hors ligne, s'envoie par mail et s'imprime en PDF.
--
--   0207 (généré) sème les assets du moteur et les fiches du skill.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Le moteur : CSS, runtime, bundle Editor.js, gabarit HTML
-- ═══════════════════════════════════════════════════════════════════════════
-- ~450 ko de texte statique qu'une edge function doit pouvoir lire au moment de
-- la construction. En module partagé, ces 450 ko entreraient dans le bundle de
-- CHAQUE fonction important la boîte à outils des agents ; en objets storage,
-- ils manqueraient à tout environnement fraîchement provisionné. En table, un
-- `supabase db push` suffit.

create table if not exists public.report_artisan_assets (
  name       text primary key,
  content    text not null,
  updated_at timestamptz not null default now()
);

comment on table public.report_artisan_assets is
  'Moteur Report Artisan (report.css, runtime.js, shell.html, editorjs.bundle.js) inliné dans chaque rapport construit. Généré depuis report-artisan-src/ — voir scripts/gen-report-artisan-migration.mjs.';

alter table public.report_artisan_assets enable row level security;
-- Aucune policy : lecture par le service role uniquement (le builder). Personne
-- d'autre n'a de raison de lire 450 ko de vendor.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Où vivent les rapports construits
-- ═══════════════════════════════════════════════════════════════════════════
-- Bucket privé : un rapport porte des chiffres de client. Les chemins sont
-- `{workspace_id}/{deliverable_id}/rapport.html` — le premier segment porte
-- l'autorisation, l'app lit par URL signée.

insert into storage.buckets (id, name, public)
values ('agent-reports', 'agent-reports', false)
on conflict (id) do nothing;

drop policy if exists "Members read agent reports" on storage.objects;
create policy "Members read agent reports"
on storage.objects for select
using (
  bucket_id = 'agent-reports'
  and exists (
    select 1 from public.workspace_members wm
    where wm.user_id = auth.uid()
      and wm.workspace_id::text = (storage.foldername(name))[1]
  )
);

-- Les écritures passent par le builder (service role), jamais par le client.

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Le Rédacteur — un agent système, un par projet
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.internal_agents
  add column if not exists system_role text
    check (system_role is null or system_role in ('reporter'));

comment on column public.internal_agents.system_role is
  'Agent fourni par la plateforme, provisionné automatiquement et non supprimable. reporter = le Rédacteur, seul agent autorisé à publier un rapport.';

-- Un seul par projet, quoi qu'il arrive.
create unique index if not exists idx_internal_agents_one_reporter_per_project
  on public.internal_agents(project_id) where system_role = 'reporter';

-- Sa rédaction est un run enfant de celui qui la demande : elle apparaît dans la
-- timeline de l'appelant, son coût tombe sur le bon workspace, et sa trace reste
-- consultable seule.
alter table public.internal_agent_runs
  drop constraint if exists internal_agent_runs_run_kind_check;
alter table public.internal_agent_runs
  add constraint internal_agent_runs_run_kind_check
  check (run_kind in ('primary', 'subagent', 'report'));

-- ── Provisionnement idempotent ────────────────────────────────────────────
-- Appelée par le trigger de création de projet, par le rattrapage ci-dessous,
-- et par le runtime avant toute délégation : « toujours présent » ne peut pas
-- dépendre d'un trigger qui aurait manqué un chemin de création.

create or replace function public.ensure_report_agent(p_project uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $FN$
declare
  aid uuid;
  ws  uuid;
  sid uuid;
begin
  if p_project is null then return null; end if;

  select id into aid
  from public.internal_agents
  where project_id = p_project and system_role = 'reporter'
  limit 1;

  if aid is null then
    select workspace_id into ws from public.projects where id = p_project;
    if ws is null then return null; end if;

    insert into public.internal_agents (
      workspace_id, project_id, name, description, role, skills,
      avatar_emoji, accent_color, persona, instructions,
      model, temperature, max_steps, max_run_cost_usd,
      chat_enabled, mission_enabled, collaboration_enabled,
      swarm_enabled, system_role
    ) values (
      ws, p_project, 'Le Rédacteur',
      'Écrit tous les rapports de l''équipe. Les autres agents lui passent la matière ; lui la met en forme et la publie.',
      'Rédacteur de rapports',
      array['rédaction', 'rapports', 'dataviz', 'synthèse'],
      '🖋️', '#7C5CFF',
      'Tu es Le Rédacteur. Tu ne cherches pas, tu n''exécutes pas de missions : tu écris. On te confie de la matière brute — des chiffres, des sources, des constats — et tu en fais un document qui se lit.',
      'Ne rends jamais un rapport plus long que la matière ne le porte. Une donnée absente s''écrit « non publié », jamais estimée.',
      'deepseek', 0.35, 30, 2.00,
      true, true, true,
      false, 'reporter'
    )
    on conflict do nothing
    returning id into aid;

    -- `on conflict do nothing` sur l'index partiel : si deux appels courent en
    -- parallèle, le perdant ne renvoie rien et doit relire.
    if aid is null then
      select id into aid from public.internal_agents
      where project_id = p_project and system_role = 'reporter' limit 1;
    end if;
  end if;

  -- Le skill, toujours actif sur lui (et sur lui seul).
  select id into sid from public.agent_skills
  where workspace_id is null and slug = 'report-artisan' limit 1;
  if aid is not null and sid is not null then
    insert into public.agent_skill_activations (agent_id, skill_id)
    values (aid, sid)
    on conflict (agent_id, skill_id) do nothing;
  end if;

  return aid;
end;
$FN$;

-- ── Sur chaque nouveau projet ──────────────────────────────────────────────
create or replace function public.provision_report_agent()
returns trigger
language plpgsql
security definer
set search_path = public
as $FN$
begin
  perform public.ensure_report_agent(new.id);
  return new;
end;
$FN$;

drop trigger if exists trg_provision_report_agent on public.projects;
create trigger trg_provision_report_agent
  after insert on public.projects
  for each row execute function public.provision_report_agent();

-- ── On ne supprime pas le Rédacteur ────────────────────────────────────────
-- Sauf quand son projet — ou son workspace — disparaît : une suppression en
-- cascade doit passer, sinon supprimer un projet devient impossible. Postgres
-- supprime la ligne parente AVANT de déclencher la cascade, donc un parent
-- absent signe une cascade et non un geste d'utilisateur.
--
-- Les DEUX parents sont testés : internal_agents référence le workspace ET le
-- projet, et rien ne garantit l'ordre des cascades quand on supprime un
-- workspace. Ne tester que le projet rendait la suppression d'un workspace
-- impossible une fois sur deux.

create or replace function public.protect_system_agent()
returns trigger
language plpgsql
security definer
set search_path = public
as $FN$
begin
  if tg_op = 'DELETE' then
    if old.system_role is not null
       and exists (select 1 from public.projects where id = old.project_id)
       and exists (select 1 from public.workspaces where id = old.workspace_id) then
      raise exception 'L''agent « % » est fourni par la plateforme et ne peut pas être supprimé.', old.name
        using hint = 'Le Rédacteur écrit les rapports de tous les autres agents.';
    end if;
    return old;
  end if;

  if old.system_role is not null then
    if new.is_archived is true then
      raise exception 'L''agent « % » est fourni par la plateforme et ne peut pas être archivé.', old.name;
    end if;
    -- Le reste de sa configuration reste modifiable (modèle, ton, instructions),
    -- mais il ne cesse jamais d'être le Rédacteur.
    new.system_role := old.system_role;
  end if;
  return new;
end;
$FN$;

drop trigger if exists trg_protect_system_agent_del on public.internal_agents;
create trigger trg_protect_system_agent_del
  before delete on public.internal_agents
  for each row execute function public.protect_system_agent();

drop trigger if exists trg_protect_system_agent_upd on public.internal_agents;
create trigger trg_protect_system_agent_upd
  before update on public.internal_agents
  for each row execute function public.protect_system_agent();

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Le skill
-- ═══════════════════════════════════════════════════════════════════════════
-- Les fiches (content-schema.md, charts.md, gallery.md) arrivent en 0207,
-- générées depuis report-artisan-src/references/ : le skill de la base
-- et le dossier du repo ne peuvent pas diverger.

delete from public.agent_skills where workspace_id is null and slug = 'report-artisan';

insert into public.agent_skills (workspace_id, name, slug, description, category, icon, system_prompt_extension, required_tools, is_system)
values (
  null, 'Report Artisan', 'report-artisan',
  'Fabriquer un rapport : un fichier HTML autonome — bannière, indicateurs, graphiques, encadrés — construit à partir d''un document de contenu.',
  'reporting', 'FileBarChart',
  $DOC$Tu fabriques des RAPPORTS : un fichier HTML unique et autonome — mise en page éditoriale, bannières vectorielles, graphiques SVG, indicateurs, encadrés — que le destinataire peut retoucher lui-même, envoyer par mail et imprimer en PDF.

Tu écris le CONTENU. Le moteur s'occupe du rendu.

LE PRINCIPE
La beauté d'un rapport ne vient pas d'un effet visuel : elle vient de la hiérarchie. Un lecteur pressé doit comprendre l'essentiel en quinze secondes (bannière → titre → chapô → indicateurs), et un lecteur attentif doit pouvoir descendre sans jamais tomber sur un mur de texte.

Un rapport réussi tient en une phrase qu'on peut dire à voix haute. Trouve cette phrase avant d'écrire quoi que ce soit : elle devient le titre de la bannière, et tout le reste la démontre.

COMMENT ÉCRIRE
1. Lis la matière qu'on t'a passée en entier avant de décider quoi que ce soit. Tu n'enquêtes pas : tu écris ce qu'on t'a donné. Ce qui manque manque — écris-le « non publié », ne l'invente jamais.
2. Décide de l'histoire : quelle est la conclusion ? quels 3 à 5 faits la soutiennent ? qu'est-ce qui reste ouvert ? C'est le plan du document.
3. report_open(title, …) ouvre le document et fixe sa forme (accent, typographie, bannière hero, méta).
4. report_add_block(block) une fois par bloc, dans l'ordre de lecture. Le schéma exact de chaque bloc : read_skill_file(slug="report-artisan", path="content-schema.md").
5. report_publish() construit le fichier. Il VALIDE avant d'écrire : séries qui ne correspondent pas aux catégories, graphique sans légende de lecture, tuile trop longue. Lis les avertissements qu'il te rend — ils désignent presque toujours un vrai problème de rédaction, pas un détail de forme.

LA STRUCTURE QUI SE LIT
bannière hero (la conclusion, en grand) → chapô de trois phrases → 3 ou 4 indicateurs qui portent la démonstration → le corps, constat puis preuve → un encadré pour ce qu'il ne faut pas rater → un tableau pour ce qui reste à faire.

Alterne les registres. Deux graphiques consécutifs se neutralisent ; un graphique encadré de prose se lit. Si trois blocs d'affilée sont du texte, c'est qu'un chiffre attend d'être montré.

CE QUI FAIT LA DIFFÉRENCE
- Les légendes de graphique disent ce qu'on VOIT, pas ce que c'est. « Évolution des inscriptions » ne sert à rien, le titre le dit déjà. Écris « L'inflexion de la semaine 21 correspond à la mise en production de la file d'envoi dédiée. » Le champ `caption` porte souvent l'information la plus utile du rapport.
- Les indicateurs portent une variation. Un chiffre sans point de comparaison ne dit rien : `delta` ou `deltaLabel`, et `good` pour dire si la variation est une bonne nouvelle — une baisse du taux d'abandon est verte, une baisse du chiffre d'affaires ne l'est pas.
- Les textes de tuile sont courts : « vs janvier », pas « vs la cohorte d'inscrits de janvier ».
- Un seuil se montre : mets la cible dans le graphique avec `target`, pas dans une phrase.
- Les encadrés sont rares. Un `callout` par section au maximum, sinon le lecteur cesse de les voir.
- Un chiffre isolé n'est pas un graphique : c'est une tuile. Un graphique à une seule barre non plus.
- Mets en gras le chiffre qui compte dans une phrase, jamais la phrase entière.

CHOISIR LA FORME
Bannières, accents et pictogrammes : read_skill_file(slug="report-artisan", path="gallery.md").
Choisir et régler un graphique : read_skill_file(slug="report-artisan", path="charts.md").
Garde le même accent sur toute une série de rapports pour un même client.

Écris dans la langue de la demande. Le moteur formate les nombres selon `locale` (fr-FR par défaut).$DOC$,
  '{}', true
);

-- ── Le skill n'appartient qu'au Rédacteur ─────────────────────────────────
-- (Le retrait de `report-authoring` chez les autres agents est en section 5.)

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Les autres agents ne rédigent plus
-- ═══════════════════════════════════════════════════════════════════════════
-- `report-authoring` était activé sur chaque agent par un trigger (0152, renommé
-- en 0187). Le trigger part, les activations aussi : un agent qui garde la
-- doctrine du rapport dans son prompt continuera d'essayer d'écrire lui-même,
-- et l'outil qu'il cherchera n'existera plus pour lui.
--
-- `deck-authoring` reste : une présentation n'est pas un rapport, et les blocs
-- add_block/publish_artifact(target="presentation") continuent de servir.

drop trigger if exists trg_activate_report_designer on public.internal_agents;
drop function if exists public.activate_report_designer();

delete from public.agent_skill_activations a
using public.agent_skills s
where s.id = a.skill_id
  and s.workspace_id is null
  and s.slug = 'report-authoring';

-- Le skill lui-même n'est pas supprimé : il reste dans la bibliothèque, et un
-- workspace qui veut sciemment un agent rédacteur de plus peut l'activer.
update public.agent_skills
set description = description || ' (Historique : les rapports passent par Le Rédacteur et le skill report-artisan.)'
where workspace_id is null and slug = 'report-authoring'
  and description not like '%Historique%';

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Rattrapage : un Rédacteur pour chaque projet existant
-- ═══════════════════════════════════════════════════════════════════════════
-- Après la création du skill, pour que l'activation parte avec l'agent.

do $BACKFILL$
declare p record;
begin
  for p in select id from public.projects loop
    perform public.ensure_report_agent(p.id);
  end loop;
end;
$BACKFILL$;
