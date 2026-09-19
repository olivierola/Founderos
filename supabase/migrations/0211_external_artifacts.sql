-- 0211_external_artifacts.sql
-- Les artifacts produits AILLEURS.
--
-- Le mur d'artifacts ne montrait que ce qui vit chez nous : rapports du
-- Rédacteur, documents Office, images générées. Or un agent qui a un connecteur
-- ou un serveur MCP produit surtout… ailleurs. Il crée une page Notion, ouvre
-- une issue Linear, dépose un fichier Drive, pousse une PR GitHub — et ce
-- travail n'existait nulle part dans le produit. Il fallait se souvenir qu'un
-- agent avait fait quelque chose, puis aller le chercher dans l'autre outil.
--
-- Une ligne ici = une carte sur le mur, avec le logo de l'outil, qui ouvre le
-- contenu réel. Le fichier reste chez son hôte : on n'en garde que l'adresse et
-- de quoi le reconnaître. Pas de copie à synchroniser, donc pas de copie qui
-- diverge.
--
-- `url` est unique par projet : un agent qui met à jour la même page Notion
-- rafraîchit sa carte au lieu d'en empiler une deuxième (upsert on conflict).

create table if not exists public.external_artifacts (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  -- Où le travail a été produit : la room, l'agent, le run. Ce sont ces trois
  -- colonnes qui font marcher les filtres du mur (agents / rooms / missions)
  -- sur les artifacts externes comme sur les autres.
  service_room_id uuid references public.service_rooms(id) on delete set null,
  agent_id        uuid references public.internal_agents(id) on delete set null,
  run_id          uuid references public.internal_agent_runs(id) on delete set null,
  -- 'connector' (Composio & co), 'mcp' (serveur distant), 'manual' (collé à la main).
  source          text not null default 'connector'
                  check (source in ('connector', 'mcp', 'manual')),
  -- Le slug qui choisit le logo : notion, linear, github, figma, slack…
  -- Volontairement libre : BrandLogo retombe sur le domaine puis sur une icône
  -- générique, donc un outil inconnu donne une carte correcte, pas une erreur.
  provider        text not null,
  -- L'action exacte qui l'a produit (NOTION_CREATE_PAGE, mcp_linear_create_issue…),
  -- pour qu'une carte surprenante puisse être remontée à son origine.
  tool            text,
  kind            text not null default 'link',
  title           text not null,
  url             text not null,
  summary         text,
  -- L'identifiant chez l'hôte, quand l'outil le rend. Sert à retrouver l'objet
  -- si son URL change (une page Notion renommée déplace son slug).
  external_id     text,
  card_color      text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_external_artifacts_project
  on public.external_artifacts(project_id, created_at desc);
create index if not exists idx_external_artifacts_room
  on public.external_artifacts(service_room_id) where service_room_id is not null;
create index if not exists idx_external_artifacts_agent
  on public.external_artifacts(agent_id) where agent_id is not null;
create unique index if not exists uq_external_artifacts_url
  on public.external_artifacts(project_id, url);

alter table public.external_artifacts enable row level security;

drop policy if exists "members manage external_artifacts" on public.external_artifacts;
create policy "members manage external_artifacts" on public.external_artifacts for all
  using (exists (select 1 from public.workspace_members wm
                 where wm.workspace_id = external_artifacts.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm
                      where wm.workspace_id = external_artifacts.workspace_id and wm.user_id = auth.uid()));

comment on table public.external_artifacts is
  'Travail produit hors du produit (connecteur ou MCP) : page Notion, issue Linear, fichier Drive… Une ligne = une carte du mur d''artifacts qui ouvre le contenu chez son hôte.';
