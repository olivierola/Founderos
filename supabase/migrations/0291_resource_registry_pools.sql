-- 0291_resource_registry_pools.sql
-- La passerelle de ressources : un registre interne, des pools, et la cohérence.
--
-- Jusqu'ici un agent recevait ses moyens un par un, par six portes distinctes :
-- une ligne internal_agent_tools par capacité, agent_mcp_servers par serveur
-- MCP, agent_skill_activations par compétence, un connecteur custom par ligne,
-- les guardrails par portée d'espace, et l'A2A ouvert à tout agent
-- collaborant du projet. Rien ne disait, d'un coup d'œil, ce qu'un agent pouvait
-- atteindre — ni ne garantissait qu'une procédure qu'on lui confie ne faisait
-- pas intervenir un collègue ou un outil qu'il n'a pas.
--
-- Trois briques :
--
--   1. LE REGISTRE (resource_registry). Chaque fois qu'une source est connectée
--      ou modifiée — un serveur MCP et sa liste d'outils, une app Composio, un
--      outil customisé et ses opérations, une collection RAG, une compétence,
--      un guardrail, une automatisation ou une procédure, un agent (pour
--      l'A2A) — un trigger met le registre à jour. Une source est une ligne
--      « toolset » (toute la source, outils futurs compris) ; chacun de ses
--      outils, une ligne « tool » rattachée. Un outil qui disparaît de sa
--      source n'est pas effacé : il passe « removed », pour que le pool qui le
--      contient le signale au lieu de perdre l'information en silence.
--
--   2. LES POOLS (resource_pools, resource_pool_items, agent_resource_pools).
--      Un pool est un lot de ressources du registre, donné à un agent en une
--      fois. Un agent qui a au moins un pool passe en MODE POOLS : il n'atteint
--      plus que l'union de ses pools (_shared/resource-pools.ts l'applique à
--      l'exécution) ; ses accès granulaires hors pools sont ignorés. Un agent
--      sans pool garde le comportement d'avant.
--
--   3. LA COHÉRENCE (resource_pool_issues, agent_resource_issues,
--      resource_coherence_report). Une procédure ou une automatisation d'un
--      pool qui fait intervenir un agent, un serveur MCP, une app ou une
--      collection absents du pool est une ERREUR ; l'A2A doit être réciproque
--      entre agents en mode pools ; une ressource disparue ou réservée à un
--      autre service est signalée. Un pool en erreur ne se donne pas à un
--      agent (trigger), et l'exécution refuse ce qui sortirait des pools.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Le registre
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.resource_registry (
  id                   uuid primary key default gen_random_uuid(),
  -- Null pour les seules compétences système, communes à tous les espaces.
  workspace_id         uuid references public.workspaces(id) on delete cascade,
  -- Null pour une ressource d'espace (un serveur MCP sert tous les projets).
  project_id           uuid references public.projects(id) on delete cascade,
  -- Ressource réservée à un service ; pour un agent, son service.
  service_dashboard_id uuid references public.service_dashboards(id) on delete cascade,
  kind      text not null check (kind in ('toolset', 'tool', 'knowledge', 'skill', 'guardrail', 'automation', 'procedure', 'agent')),
  source    text not null check (source in ('mcp', 'composio', 'custom_connector', 'builtin', 'rag', 'skill', 'guardrail', 'workflow', 'agent')),
  -- L'identifiant de l'objet source (uuid en texte) ; pour une famille
  -- d'outils intégrée, le projet.
  source_id text not null,
  -- '' pour la source entière ; le nom de l'outil (MCP), le slug de l'action
  -- (Composio), le nom de l'opération (outil customisé), la famille (intégré).
  item_key  text not null default '',
  parent_id uuid references public.resource_registry(id) on delete cascade,
  name        text not null,
  description text,
  risk   text not null default 'unknown' check (risk in ('read', 'write', 'destructive', 'unknown')),
  status text not null default 'active' check (status in ('active', 'unavailable', 'removed')),
  -- Ce que la cohérence a besoin de lire sans rouvrir la source : pour un
  -- workflow, les agents, serveurs MCP, apps et collections qu'il fait intervenir.
  metadata  jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (source, source_id, item_key),
  check (workspace_id is not null or source = 'skill')
);
create index if not exists idx_resource_registry_project on public.resource_registry(project_id, kind);
create index if not exists idx_resource_registry_workspace on public.resource_registry(workspace_id, kind);
create index if not exists idx_resource_registry_parent on public.resource_registry(parent_id);

comment on table public.resource_registry is
  'Registre interne de la passerelle de ressources (0291) : outils, connaissances, compétences, guardrails, workflows et agents, tenu à jour par triggers.';

alter table public.resource_registry enable row level security;
drop policy if exists "resource_registry: members read" on public.resource_registry;
create policy "resource_registry: members read"
on public.resource_registry for select
using (workspace_id is null or public.is_workspace_member(workspace_id));
-- Seules les fonctions de synchronisation (security definer) écrivent.
revoke insert, update, delete on public.resource_registry from anon, authenticated;

/** Le risque d'un outil d'après ses annotations MCP, sinon d'après son nom. */
create or replace function public.resource_risk_of(p_name text, p_annotations jsonb default '{}'::jsonb)
returns text
language sql
immutable
as $$
  select case
    when coalesce(p_annotations ->> 'destructiveHint', '') = 'true' then 'destructive'
    when coalesce(p_annotations ->> 'readOnlyHint', '') = 'true' then 'read'
    when lower(coalesce(p_name, '')) ~ '(^|[_.: -])(delete|remove|drop|destroy|purge|terminate|revoke|wipe|truncate|uninstall|rollback)' then 'destructive'
    when lower(coalesce(p_name, '')) ~ '(^|[_.: -])(get|list|search|read|describe|fetch|find|query|show|count|view|lookup|status|logs?|inspect|export|top)([_.: -]|$)' then 'read'
    else 'write'
  end
$$;

/** Écrit (ou met à jour) une ligne du registre ; renvoie son id. */
create or replace function public.resource_registry_put(
  p_workspace uuid, p_project uuid, p_service uuid,
  p_kind text, p_source text, p_source_id text, p_item_key text, p_parent uuid,
  p_name text, p_description text, p_risk text, p_status text, p_metadata jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.resource_registry as r (
    workspace_id, project_id, service_dashboard_id, kind, source, source_id, item_key,
    parent_id, name, description, risk, status, metadata, synced_at
  ) values (
    p_workspace, p_project, p_service, p_kind, p_source, p_source_id, coalesce(p_item_key, ''),
    p_parent, left(coalesce(nullif(p_name, ''), p_source_id), 200), left(p_description, 1000),
    coalesce(p_risk, 'unknown'), coalesce(p_status, 'active'), coalesce(p_metadata, '{}'::jsonb), now()
  )
  on conflict (source, source_id, item_key) do update set
    workspace_id = excluded.workspace_id,
    project_id = excluded.project_id,
    service_dashboard_id = excluded.service_dashboard_id,
    kind = excluded.kind,
    parent_id = excluded.parent_id,
    name = excluded.name,
    description = excluded.description,
    risk = excluded.risk,
    status = excluded.status,
    metadata = excluded.metadata,
    synced_at = now()
  returning r.id into v_id;
  return v_id;
end;
$$;

/** Une source a disparu : elle et ses outils passent « removed ». */
create or replace function public.resource_registry_mark_removed(p_source text, p_source_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.resource_registry
     set status = 'removed', synced_at = now()
   where source = p_source and source_id = p_source_id and status <> 'removed';
$$;

-- ── Serveurs MCP : le serveur et sa liste d'outils (cached_tools) ────────────
create or replace function public.resource_registry_sync_mcp(p_server uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  t jsonb;
  v_set uuid;
  v_status text;
  v_names text[] := '{}';
begin
  select id, workspace_id, name, description, enabled, cached_tools, transport, environment
    into s from public.mcp_servers where id = p_server;
  if not found then
    perform public.resource_registry_mark_removed('mcp', p_server::text);
    return;
  end if;
  v_status := case when s.enabled then 'active' else 'unavailable' end;
  v_set := public.resource_registry_put(
    s.workspace_id, null, null, 'toolset', 'mcp', s.id::text, '', null,
    s.name, s.description, 'unknown', v_status,
    jsonb_build_object('transport', s.transport, 'environment', s.environment));
  for t in
    select x from jsonb_array_elements(
      case when jsonb_typeof(s.cached_tools) = 'array' then s.cached_tools else '[]'::jsonb end) x
  loop
    continue when coalesce(t ->> 'name', '') = '' or (t ->> 'name') = any(v_names);
    v_names := v_names || (t ->> 'name');
    perform public.resource_registry_put(
      s.workspace_id, null, null, 'tool', 'mcp', s.id::text, t ->> 'name', v_set,
      t ->> 'name', t ->> 'description',
      public.resource_risk_of(t ->> 'name', case when jsonb_typeof(t -> 'annotations') = 'object' then t -> 'annotations' else '{}'::jsonb end),
      v_status, '{}'::jsonb);
  end loop;
  -- Un outil que le serveur ne liste plus.
  update public.resource_registry
     set status = 'removed', synced_at = now()
   where source = 'mcp' and source_id = s.id::text and item_key <> ''
     and not (item_key = any(v_names)) and status <> 'removed';
end;
$$;

-- ── Apps Composio : la connexion partagée (projet ou service) et ses actions ──
-- Une connexion personnelle n'est pas une ressource à distribuer : elle reste
-- hors du registre. Les actions viennent de metadata.tools quand la découverte
-- les a mises en cache ; sans elles, l'app entière reste attribuable.
create or replace function public.resource_registry_sync_composio(p_connector uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  t jsonb;
  v_set uuid;
  v_status text;
  v_key text;
  v_keys text[] := '{}';
begin
  select id, workspace_id, project_id, provider, source, status, permissions, metadata, scope, service_dashboard_id
    into c from public.connectors where id = p_connector;
  if not found or c.source is distinct from 'composio' or c.scope = 'personal' or c.workspace_id is null then
    perform public.resource_registry_mark_removed('composio', p_connector::text);
    return;
  end if;
  v_status := case when c.status in ('connected', 'read_only', 'write_enabled') then 'active' else 'unavailable' end;
  v_set := public.resource_registry_put(
    c.workspace_id, c.project_id, case when c.scope = 'dashboard' then c.service_dashboard_id end,
    'toolset', 'composio', c.id::text, '', null,
    coalesce(nullif(c.metadata ->> 'name', ''), initcap(replace(c.provider, '_', ' '))),
    c.metadata ->> 'description', 'unknown', v_status,
    jsonb_build_object('toolkit', lower(c.provider), 'permissions', c.permissions));
  for t in
    select x from jsonb_array_elements(
      case when jsonb_typeof(c.metadata -> 'tools') = 'array' then c.metadata -> 'tools' else '[]'::jsonb end) x
  loop
    v_key := upper(coalesce(nullif(t ->> 'slug', ''), t ->> 'name', ''));
    continue when v_key = '' or v_key = any(v_keys);
    v_keys := v_keys || v_key;
    perform public.resource_registry_put(
      c.workspace_id, c.project_id, case when c.scope = 'dashboard' then c.service_dashboard_id end,
      'tool', 'composio', c.id::text, v_key, v_set,
      coalesce(nullif(t ->> 'name', ''), v_key), t ->> 'description',
      public.resource_risk_of(v_key), v_status, jsonb_build_object('toolkit', lower(c.provider)));
  end loop;
  update public.resource_registry
     set status = 'removed', synced_at = now()
   where source = 'composio' and source_id = c.id::text and item_key <> ''
     and not (item_key = any(v_keys)) and status <> 'removed';
end;
$$;

-- ── Outils customisés : le connecteur et ses opérations ──────────────────────
create or replace function public.resource_registry_sync_custom_connector(p_connector uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  op jsonb;
  v_set uuid;
  v_status text;
  v_names text[] := '{}';
begin
  select id, workspace_id, project_id, service_dashboard_id, name, slug, description, operations, status, transport, environment
    into c from public.custom_connectors where id = p_connector;
  if not found then
    perform public.resource_registry_mark_removed('custom_connector', p_connector::text);
    return;
  end if;
  v_status := case when c.status = 'active' then 'active' else 'unavailable' end;
  v_set := public.resource_registry_put(
    c.workspace_id, c.project_id, c.service_dashboard_id, 'toolset', 'custom_connector', c.id::text, '', null,
    c.name, c.description, 'unknown', v_status,
    jsonb_build_object('slug', c.slug, 'transport', c.transport, 'environment', c.environment));
  for op in
    select x from jsonb_array_elements(
      case when jsonb_typeof(c.operations) = 'array' then c.operations else '[]'::jsonb end) x
  loop
    continue when coalesce(op ->> 'name', '') = '' or (op ->> 'name') = any(v_names);
    v_names := v_names || (op ->> 'name');
    perform public.resource_registry_put(
      c.workspace_id, c.project_id, c.service_dashboard_id, 'tool', 'custom_connector', c.id::text, op ->> 'name', v_set,
      op ->> 'name', op ->> 'description',
      case when op ->> 'risk' in ('read', 'write', 'destructive') then op ->> 'risk' else 'write' end,
      v_status, '{}'::jsonb);
  end loop;
  update public.resource_registry
     set status = 'removed', synced_at = now()
   where source = 'custom_connector' and source_id = c.id::text and item_key <> ''
     and not (item_key = any(v_names)) and status <> 'removed';
end;
$$;

-- ── Collections RAG, compétences, guardrails ─────────────────────────────────
create or replace function public.resource_registry_sync_rag(p_collection uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare c record;
begin
  select id, workspace_id, project_id, name, description, enabled into c from public.rag_collections where id = p_collection;
  if not found then
    perform public.resource_registry_mark_removed('rag', p_collection::text);
    return;
  end if;
  perform public.resource_registry_put(
    c.workspace_id, c.project_id, null, 'knowledge', 'rag', c.id::text, '', null,
    c.name, c.description, 'read', case when c.enabled then 'active' else 'unavailable' end, '{}'::jsonb);
end;
$$;

create or replace function public.resource_registry_sync_skill(p_skill uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare s record;
begin
  select id, workspace_id, name, slug, description, category, is_system into s from public.agent_skills where id = p_skill;
  if not found then
    perform public.resource_registry_mark_removed('skill', p_skill::text);
    return;
  end if;
  perform public.resource_registry_put(
    s.workspace_id, null, null, 'skill', 'skill', s.id::text, '', null,
    s.name, s.description, 'unknown', 'active',
    jsonb_build_object('slug', s.slug, 'category', s.category, 'is_system', s.is_system));
end;
$$;

create or replace function public.resource_registry_sync_guardrail(p_guardrail uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare g record;
begin
  select id, workspace_id, project_id, title, category, enforcement, enabled, body into g from public.aiops_guardrails where id = p_guardrail;
  if not found then
    perform public.resource_registry_mark_removed('guardrail', p_guardrail::text);
    return;
  end if;
  perform public.resource_registry_put(
    g.workspace_id, g.project_id, null, 'guardrail', 'guardrail', g.id::text, '', null,
    g.title, left(g.body, 300), 'unknown', case when g.enabled then 'active' else 'unavailable' end,
    jsonb_build_object('category', g.category, 'enforcement', g.enforcement));
end;
$$;

-- ── Automatisations et procédures : ce qu'elles font intervenir ──────────────
/** Les références d'un graphe de workflow : agents (blocs Étape et Passation),
 *  serveurs MCP et apps (blocs Outil), collections (références de contexte).
 *  Même lecture que workflow-doc.ts (agentIdsOf, mcpSelectionsOf, toolCall). */
create or replace function public.resource_workflow_refs(p_blocks jsonb)
returns jsonb
language sql
immutable
as $$
  with nodes as (
    select n from jsonb_array_elements(
      case when jsonb_typeof(p_blocks -> 'nodes') = 'array' then p_blocks -> 'nodes' else '[]'::jsonb end) n
  ),
  agent_ids as (
    select distinct x as id from (
      select n -> 'data' ->> 'agent_id' as x from nodes where n ->> 'type' = 'step'
      union all
      select jsonb_array_elements_text(n -> 'data' -> 'agent_ids') from nodes
       where n ->> 'type' = 'handoff' and jsonb_typeof(n -> 'data' -> 'agent_ids') = 'array'
    ) a where coalesce(x, '') <> ''
  ),
  mcp as (
    select m ->> 'server_id' as server_id,
           case when jsonb_typeof(m -> 'tools') = 'array' then m -> 'tools' else '[]'::jsonb end as tools
      from nodes, jsonb_array_elements(n -> 'data' -> 'mcp') m
     where n ->> 'type' = 'tool' and n -> 'data' ->> 'tool' = 'mcp'
       and jsonb_typeof(n -> 'data' -> 'mcp') = 'array' and coalesce(m ->> 'server_id', '') <> ''
  ),
  apps as (
    select distinct lower(n -> 'data' ->> 'provider') as provider, upper(coalesce(n -> 'data' ->> 'action', '')) as action
      from nodes
     where n ->> 'type' = 'tool' and coalesce(n -> 'data' ->> 'provider', '') <> ''
       and coalesce(n -> 'data' ->> 'tool', '') <> 'mcp'
  ),
  collections as (
    select distinct r ->> 'id' as id
      from nodes, jsonb_array_elements(n -> 'data' -> 'refs') r
     where jsonb_typeof(n -> 'data' -> 'refs') = 'array' and r ->> 'kind' = 'collection' and coalesce(r ->> 'id', '') <> ''
  )
  select jsonb_build_object(
    'agent_ids', coalesce((select jsonb_agg(id order by id) from agent_ids), '[]'::jsonb),
    'mcp', coalesce((select jsonb_agg(jsonb_build_object('server_id', server_id, 'tools', tools)) from mcp), '[]'::jsonb),
    'apps', coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'action', action)) from apps), '[]'::jsonb),
    'collection_ids', coalesce((select jsonb_agg(id order by id) from collections), '[]'::jsonb)
  )
$$;

create or replace function public.resource_registry_sync_workflow(p_workflow uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare w record;
begin
  select id, workspace_id, project_id, service_dashboard_id, name, description, status, kind, blocks
    into w from public.agent_workflows where id = p_workflow;
  if not found then
    perform public.resource_registry_mark_removed('workflow', p_workflow::text);
    return;
  end if;
  perform public.resource_registry_put(
    w.workspace_id, w.project_id, w.service_dashboard_id,
    case when w.kind = 'automation' then 'automation' else 'procedure' end,
    'workflow', w.id::text, '', null, w.name, w.description, 'unknown',
    case when w.status = 'archived' then 'unavailable' else 'active' end,
    public.resource_workflow_refs(w.blocks) || jsonb_build_object('workflow_status', w.status));
end;
$$;

-- ── Agents : les collègues qu'on peut solliciter (A2A) ───────────────────────
create or replace function public.resource_registry_sync_agent(p_agent uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare a record;
begin
  select id, workspace_id, project_id, service_dashboard_id, name, description, is_archived, collaboration_enabled, is_orchestrator
    into a from public.internal_agents where id = p_agent;
  if not found or a.workspace_id is null then
    perform public.resource_registry_mark_removed('agent', p_agent::text);
    return;
  end if;
  perform public.resource_registry_put(
    a.workspace_id, a.project_id, a.service_dashboard_id, 'agent', 'agent', a.id::text, '', null,
    a.name, a.description, 'unknown',
    case when coalesce(a.is_archived, false) or a.collaboration_enabled is false then 'unavailable' else 'active' end,
    jsonb_build_object('is_orchestrator', coalesce(a.is_orchestrator, false)));
end;
$$;

-- ── Familles d'outils intégrées ───────────────────────────────────────────────
-- Les types d'internal_agent_tools qui ne viennent pas d'une source connectée.
-- `requires_config` : le pool en fixe la limite, mais l'agent doit aussi avoir
-- sa ligne configurée (les tables d'une lecture, le nom d'une fonction…).
create or replace function public.resource_builtin_families()
returns table(family text, label text, risk text, requires_config boolean)
language sql
immutable
as $$
  values
    ('web_search', 'Recherche web', 'read', false),
    ('web_fetch', 'Lecture de pages web', 'read', false),
    ('db_read', 'Lecture de tables', 'read', true),
    ('tracker', 'Suivi du travail (missions, work items)', 'write', false),
    ('crm', 'CRM', 'write', false),
    ('support', 'Support', 'write', false),
    ('governance', 'Gouvernance', 'write', false),
    ('leads', 'LeadSense', 'write', false),
    ('soc', 'SOC (SentinelFlow)', 'write', false),
    ('security_scan', 'Scans de sécurité', 'write', false),
    ('vibe_code', 'Vibe Code', 'write', false),
    ('testing', 'Tests applicatifs', 'write', false),
    ('simulation', 'Simulations', 'write', false),
    ('edge_function', 'Fonctions serveur', 'write', true),
    ('connector_action', 'Actions des connecteurs maison', 'write', true),
    ('vault_connector', 'Connecteurs du coffre', 'write', true),
    ('custom', 'Outil personnalisé', 'write', true)
$$;

create or replace function public.resource_registry_seed_builtin(p_project uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws uuid;
  f record;
begin
  select workspace_id into v_ws from public.projects where id = p_project;
  if v_ws is null then return; end if;
  for f in select * from public.resource_builtin_families() loop
    perform public.resource_registry_put(
      v_ws, p_project, null, 'toolset', 'builtin', p_project::text, f.family, null,
      f.label, null, f.risk, 'active', jsonb_build_object('requires_config', f.requires_config));
  end loop;
end;
$$;

-- ── Les triggers : le registre suit ses sources ──────────────────────────────
create or replace function public.resource_registry_on_source()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := case when tg_op = 'DELETE' then old.id else new.id end;
begin
  case tg_table_name
    when 'mcp_servers' then perform public.resource_registry_sync_mcp(v_id);
    when 'connectors' then perform public.resource_registry_sync_composio(v_id);
    when 'custom_connectors' then perform public.resource_registry_sync_custom_connector(v_id);
    when 'rag_collections' then perform public.resource_registry_sync_rag(v_id);
    when 'agent_skills' then perform public.resource_registry_sync_skill(v_id);
    when 'aiops_guardrails' then perform public.resource_registry_sync_guardrail(v_id);
    when 'agent_workflows' then perform public.resource_registry_sync_workflow(v_id);
    when 'internal_agents' then perform public.resource_registry_sync_agent(v_id);
    when 'projects' then perform public.resource_registry_seed_builtin(v_id);
  end case;
  return null;
end;
$$;

drop trigger if exists trg_resource_registry_mcp on public.mcp_servers;
create trigger trg_resource_registry_mcp
after insert or delete or update of name, description, enabled, cached_tools on public.mcp_servers
for each row execute function public.resource_registry_on_source();

drop trigger if exists trg_resource_registry_composio on public.connectors;
create trigger trg_resource_registry_composio
after insert or delete or update of provider, source, status, permissions, metadata, scope, service_dashboard_id on public.connectors
for each row execute function public.resource_registry_on_source();

drop trigger if exists trg_resource_registry_custom on public.custom_connectors;
create trigger trg_resource_registry_custom
after insert or delete or update of name, description, operations, status, service_dashboard_id on public.custom_connectors
for each row execute function public.resource_registry_on_source();

drop trigger if exists trg_resource_registry_rag on public.rag_collections;
create trigger trg_resource_registry_rag
after insert or delete or update of name, description, enabled on public.rag_collections
for each row execute function public.resource_registry_on_source();

drop trigger if exists trg_resource_registry_skill on public.agent_skills;
create trigger trg_resource_registry_skill
after insert or delete or update of name, description, slug, category on public.agent_skills
for each row execute function public.resource_registry_on_source();

drop trigger if exists trg_resource_registry_guardrail on public.aiops_guardrails;
create trigger trg_resource_registry_guardrail
after insert or delete or update of title, body, category, enforcement, enabled on public.aiops_guardrails
for each row execute function public.resource_registry_on_source();

drop trigger if exists trg_resource_registry_workflow on public.agent_workflows;
create trigger trg_resource_registry_workflow
after insert or delete or update of name, description, status, kind, blocks, service_dashboard_id on public.agent_workflows
for each row execute function public.resource_registry_on_source();

drop trigger if exists trg_resource_registry_agent on public.internal_agents;
create trigger trg_resource_registry_agent
after insert or delete or update of name, description, is_archived, collaboration_enabled, service_dashboard_id, is_orchestrator on public.internal_agents
for each row execute function public.resource_registry_on_source();

drop trigger if exists trg_resource_registry_project on public.projects;
create trigger trg_resource_registry_project
after insert on public.projects
for each row execute function public.resource_registry_on_source();

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Les pools
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.resource_pools (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  project_id           uuid not null references public.projects(id) on delete cascade,
  -- Pool réservé à un service : seuls ses agents le reçoivent, et il peut
  -- contenir les ressources réservées à ce service. Null = tout le projet.
  service_dashboard_id uuid references public.service_dashboards(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 80),
  description text check (description is null or length(description) <= 1000),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, name)
);
create index if not exists idx_resource_pools_service on public.resource_pools(service_dashboard_id);

create table if not exists public.resource_pool_items (
  pool_id     uuid not null references public.resource_pools(id) on delete cascade,
  registry_id uuid not null references public.resource_registry(id) on delete cascade,
  added_by    uuid references auth.users(id) on delete set null,
  added_at    timestamptz not null default now(),
  primary key (pool_id, registry_id)
);
create index if not exists idx_resource_pool_items_registry on public.resource_pool_items(registry_id);

create table if not exists public.agent_resource_pools (
  agent_id    uuid not null references public.internal_agents(id) on delete cascade,
  pool_id     uuid not null references public.resource_pools(id) on delete cascade,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (agent_id, pool_id)
);
create index if not exists idx_agent_resource_pools_pool on public.agent_resource_pools(pool_id);

comment on table public.agent_resource_pools is
  'Pools donnés à un agent (0291). Au moins un pool = mode pools : l''agent n''atteint que l''union de ses pools.';

alter table public.resource_pools enable row level security;
alter table public.resource_pool_items enable row level security;
alter table public.agent_resource_pools enable row level security;

drop policy if exists "resource_pools: members read" on public.resource_pools;
create policy "resource_pools: members read" on public.resource_pools for select
using (public.is_workspace_member(workspace_id));
drop policy if exists "resource_pools: editors write" on public.resource_pools;
create policy "resource_pools: editors write" on public.resource_pools for all
using (public.workspace_role(workspace_id) in ('owner', 'admin', 'member'))
with check (public.workspace_role(workspace_id) in ('owner', 'admin', 'member'));

drop policy if exists "resource_pool_items: members read" on public.resource_pool_items;
create policy "resource_pool_items: members read" on public.resource_pool_items for select
using (exists (select 1 from public.resource_pools p where p.id = pool_id and public.is_workspace_member(p.workspace_id)));
drop policy if exists "resource_pool_items: editors write" on public.resource_pool_items;
create policy "resource_pool_items: editors write" on public.resource_pool_items for all
using (exists (select 1 from public.resource_pools p where p.id = pool_id and public.workspace_role(p.workspace_id) in ('owner', 'admin', 'member')))
with check (exists (select 1 from public.resource_pools p where p.id = pool_id and public.workspace_role(p.workspace_id) in ('owner', 'admin', 'member')));

drop policy if exists "agent_resource_pools: members read" on public.agent_resource_pools;
create policy "agent_resource_pools: members read" on public.agent_resource_pools for select
using (exists (select 1 from public.resource_pools p where p.id = pool_id and public.is_workspace_member(p.workspace_id)));
drop policy if exists "agent_resource_pools: editors write" on public.agent_resource_pools;
create policy "agent_resource_pools: editors write" on public.agent_resource_pools for all
using (exists (select 1 from public.resource_pools p where p.id = pool_id and public.workspace_role(p.workspace_id) in ('owner', 'admin', 'member')))
with check (exists (select 1 from public.resource_pools p where p.id = pool_id and public.workspace_role(p.workspace_id) in ('owner', 'admin', 'member')));

-- Un pool et ce qu'il contient restent dans le même périmètre.
create or replace function public.resource_pool_items_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p record;
  r record;
begin
  select id, workspace_id, project_id, service_dashboard_id into p from public.resource_pools where id = new.pool_id;
  select id, workspace_id, project_id, service_dashboard_id, kind, status, name into r from public.resource_registry where id = new.registry_id;
  if r.id is null or p.id is null then
    raise exception 'resource_pool_item: pool ou ressource introuvable' using errcode = 'foreign_key_violation';
  end if;
  if r.workspace_id is not null and r.workspace_id <> p.workspace_id then
    raise exception 'resource_pool_scope: « % » appartient à un autre espace', r.name using errcode = 'check_violation';
  end if;
  if r.project_id is not null and r.project_id <> p.project_id then
    raise exception 'resource_pool_scope: « % » appartient à un autre projet', r.name using errcode = 'check_violation';
  end if;
  -- Une ressource réservée à un service ne va que dans un pool de ce service.
  -- Un agent et un workflow ne sont pas « réservés » : l'A2A et la passation
  -- traversent les services (0213). Un workflow dans un pool dit « cet agent
  -- exécute ce travail ou l'accepte », pas « il en devient propriétaire ».
  if r.kind not in ('agent', 'automation', 'procedure') and r.service_dashboard_id is not null and r.service_dashboard_id is distinct from p.service_dashboard_id then
    raise exception 'resource_pool_scope: « % » est réservée à un autre service que celui du pool', r.name using errcode = 'check_violation';
  end if;
  if r.status = 'removed' then
    raise exception 'resource_pool_removed: « % » n''existe plus sur sa source', r.name using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_resource_pool_items_guard on public.resource_pool_items;
create trigger trg_resource_pool_items_guard
before insert or update on public.resource_pool_items
for each row execute function public.resource_pool_items_guard();

create or replace function public.resource_pools_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.resource_pools set updated_at = now()
   where id = case when tg_op = 'DELETE' then old.pool_id else new.pool_id end;
  return null;
end;
$$;

drop trigger if exists trg_resource_pool_items_touch on public.resource_pool_items;
create trigger trg_resource_pool_items_touch
after insert or delete on public.resource_pool_items
for each row execute function public.resource_pools_touch();

-- ────────────────────────────────────────────────────────────────────────────
-- 3. La cohérence
-- ────────────────────────────────────────────────────────────────────────────
-- Trois niveaux : `error` (l'exécution échouera ou le pool ne se donne pas),
-- `warning` (quelque chose ne servira pas), `info`.

/** Les problèmes d'un pool, indépendamment de l'agent qui le reçoit. */
create or replace function public.resource_pool_issues(p_pool uuid)
returns table(severity text, code text, message text, pool_id uuid, registry_id uuid, agent_id uuid)
language sql
stable
set search_path = public
as $$
  with p as (
    select id, service_dashboard_id from public.resource_pools where id = p_pool
  ),
  items as (
    select r.* from public.resource_pool_items i
      join public.resource_registry r on r.id = i.registry_id
     where i.pool_id = p_pool
  ),
  live as (select * from items where status <> 'removed'),
  flows as (select * from live where kind in ('automation', 'procedure'))
  select 'error', 'item_removed',
         format('« %s » n''existe plus sur sa source : retirez-le du pool.', i.name),
         p_pool, i.id, null::uuid
    from items i where i.status = 'removed'
  union all
  select 'warning', 'item_unavailable',
         format('« %s » est indisponible (source désactivée, déconnectée ou archivée) : aucun agent ne pourra s''en servir.', i.name),
         p_pool, i.id, null::uuid
    from items i where i.status = 'unavailable'
  union all
  select 'error', 'scope_mismatch',
         format('« %s » est réservée à un autre service que celui du pool.', i.name),
         p_pool, i.id, null::uuid
    from live i, p
   where i.kind not in ('agent', 'automation', 'procedure') and i.service_dashboard_id is not null
     and i.service_dashboard_id is distinct from p.service_dashboard_id
  union all
  -- Une procédure ou une automatisation qui fait intervenir un agent hors du pool.
  select 'error', 'workflow_agent_outside_pool',
         format('%s « %s » fait intervenir « %s », absent du pool.',
                case w.kind when 'automation' then 'L''automatisation' else 'La procédure' end,
                w.name, coalesce(ag.name, 'un agent supprimé')),
         p_pool, w.id, case when ag.id is not null then ag.id end
    from flows w
   cross join lateral jsonb_array_elements_text(coalesce(w.metadata -> 'agent_ids', '[]'::jsonb)) x(agent_id)
    left join public.internal_agents ag on ag.id::text = x.agent_id
   where not exists (select 1 from live a where a.kind = 'agent' and a.source_id = x.agent_id)
  union all
  -- … ou un serveur MCP (ou certains de ses outils) hors du pool.
  select 'error', 'workflow_tool_outside_pool',
         format('%s « %s » utilise le serveur MCP « %s »%s, hors du pool.',
                case w.kind when 'automation' then 'L''automatisation' else 'La procédure' end,
                w.name, coalesce(s.name, m ->> 'server_id'),
                case when jsonb_array_length(m -> 'tools') > 0
                     then ' (' || (select string_agg(t, ', ') from jsonb_array_elements_text(m -> 'tools') t) || ')'
                     else '' end),
         p_pool, w.id, null::uuid
    from flows w
   cross join lateral jsonb_array_elements(coalesce(w.metadata -> 'mcp', '[]'::jsonb)) m
    left join public.mcp_servers s on s.id::text = m ->> 'server_id'
   where not exists (
           select 1 from live t where t.source = 'mcp' and t.kind = 'toolset' and t.source_id = m ->> 'server_id')
     and (jsonb_array_length(m -> 'tools') = 0
          or exists (
            select 1 from jsonb_array_elements_text(m -> 'tools') tn
             where not exists (
               select 1 from live t where t.source = 'mcp' and t.source_id = m ->> 'server_id' and t.item_key = tn)))
  union all
  -- … ou une app hors du pool.
  select 'error', 'workflow_app_outside_pool',
         format('%s « %s » utilise l''app « %s »%s, hors du pool.',
                case w.kind when 'automation' then 'L''automatisation' else 'La procédure' end,
                w.name, a ->> 'provider',
                case when coalesce(a ->> 'action', '') <> '' then ' (' || (a ->> 'action') || ')' else '' end),
         p_pool, w.id, null::uuid
    from flows w
   cross join lateral jsonb_array_elements(coalesce(w.metadata -> 'apps', '[]'::jsonb)) a
   where not exists (
           select 1 from live t where t.source = 'composio' and t.kind = 'toolset' and t.metadata ->> 'toolkit' = a ->> 'provider')
     and not exists (
           select 1 from live t join live ts on ts.id = t.parent_id
            where t.source = 'composio' and t.kind = 'tool' and ts.metadata ->> 'toolkit' = a ->> 'provider'
              and t.item_key = a ->> 'action' and coalesce(a ->> 'action', '') <> '')
  union all
  -- … ou une collection de connaissances hors du pool.
  select 'error', 'workflow_knowledge_outside_pool',
         format('%s « %s » consulte la collection « %s », hors du pool.',
                case w.kind when 'automation' then 'L''automatisation' else 'La procédure' end,
                w.name, coalesce(rc.name, x.cid)),
         p_pool, w.id, null::uuid
    from flows w
   cross join lateral jsonb_array_elements_text(coalesce(w.metadata -> 'collection_ids', '[]'::jsonb)) x(cid)
    left join public.rag_collections rc on rc.id::text = x.cid
   where not exists (select 1 from live k where k.kind = 'knowledge' and k.source_id = x.cid)
  union all
  select 'info', 'empty_pool', 'Ce pool est vide : un agent qui ne reçoit que lui n''a plus aucun outil.',
         p_pool, null::uuid, null::uuid
   where exists (select 1 from p) and not exists (select 1 from items)
$$;

/** Les problèmes d'un agent en mode pools : ceux de ses pools, et ceux qui
 *  naissent de la combinaison (réciprocité, accès ignorés, travail confié). */
create or replace function public.agent_resource_issues(p_agent uuid)
returns table(severity text, code text, message text, pool_id uuid, registry_id uuid, agent_id uuid)
language sql
stable
set search_path = public
as $$
  with a as (
    select id, name, project_id, service_dashboard_id, coalesce(is_orchestrator, false) as is_orchestrator
      from public.internal_agents where id = p_agent
  ),
  ap as (select r.pool_id from public.agent_resource_pools r where r.agent_id = p_agent),
  mine as (
    select distinct reg.* from ap
      join public.resource_pool_items i on i.pool_id = ap.pool_id
      join public.resource_registry reg on reg.id = i.registry_id
     where reg.status <> 'removed'
  ),
  tools as (
    select t.kind, t.name, t.config from public.internal_agent_tools t
     where t.agent_id = p_agent and t.enabled and exists (select 1 from ap)
  )
  select x.severity, x.code, x.message, x.pool_id, x.registry_id, x.agent_id
    from ap cross join lateral public.resource_pool_issues(ap.pool_id) x
  union all
  select 'error', 'pool_scope',
         format('Le pool « %s » est réservé à un autre service que celui de l''agent.', p.name),
         p.id, null::uuid, p_agent
    from ap join public.resource_pools p on p.id = ap.pool_id, a
   where p.service_dashboard_id is not null and p.service_dashboard_id is distinct from a.service_dashboard_id
  union all
  -- L'A2A réciproque : solliciter un agent en mode pools qui ne nous a pas.
  select 'error', 'a2a_not_reciprocal',
         format('« %s » peut solliciter « %s », mais « %s » n''a pas « %s » dans ses pools : il ne pourra ni lui répondre ni lui rendre compte.',
                a.name, b.name, b.name, a.name),
         null::uuid, m.id, b.id
    from mine m
    join public.internal_agents b on b.id::text = m.source_id, a
   where m.kind = 'agent' and b.id <> p_agent
     and exists (select 1 from public.agent_resource_pools bp where bp.agent_id = b.id)
     and not exists (
       select 1 from public.agent_resource_pools bp
         join public.resource_pool_items bi on bi.pool_id = bp.pool_id
         join public.resource_registry br on br.id = bi.registry_id
        where bp.agent_id = b.id and br.kind = 'agent' and br.source_id = p_agent::text and br.status <> 'removed')
  union all
  -- Les accès granulaires que le mode pools ignore.
  select 'warning', 'granular_ignored',
         format('Le serveur MCP « %s » est activé sur l''agent mais absent de ses pools : il est ignoré.', s.name),
         null::uuid, null::uuid, p_agent
    from public.agent_mcp_servers ams join public.mcp_servers s on s.id = ams.server_id
   where ams.agent_id = p_agent and exists (select 1 from ap)
     and not exists (select 1 from mine m where m.source = 'mcp' and m.source_id = s.id::text)
  union all
  select 'warning', 'granular_ignored',
         format('La compétence « %s » est activée sur l''agent mais absente de ses pools : elle est ignorée.', sk.name),
         null::uuid, null::uuid, p_agent
    from public.agent_skill_activations act join public.agent_skills sk on sk.id = act.skill_id
   where act.agent_id = p_agent and exists (select 1 from ap)
     and not exists (select 1 from mine m where m.source = 'skill' and m.source_id = sk.id::text)
  union all
  select 'warning', 'granular_ignored',
         format('L''outil « %s » est configuré sur l''agent mais absent de ses pools : il est ignoré.', t.name),
         null::uuid, null::uuid, p_agent
    from tools t
   where case t.kind
           when 'composio_toolkit' then not exists (
             select 1 from mine m where m.source = 'composio' and m.metadata ->> 'toolkit' = lower(t.config ->> 'toolkit'))
           when 'custom_connector' then not exists (
             select 1 from mine m where m.source = 'custom_connector' and m.source_id = t.config ->> 'connector_id')
           when 'rag_search' then not exists (select 1 from mine m where m.kind = 'knowledge')
           else not exists (select 1 from mine m where m.source = 'builtin' and m.item_key = t.kind)
         end
  union all
  -- Le travail qu'on lui confie et qui sortirait de ses pools.
  select 'warning', 'procedure_outside_pool',
         format('La procédure « %s » de ce service est confiée à « %s » (assistant du service) mais n''est pas dans ses pools : elle échouera au lancement.', w.name, a.name),
         null::uuid, null::uuid, p_agent
    from a join public.agent_workflows w
      on w.service_dashboard_id = a.service_dashboard_id and w.kind = 'procedure' and w.status = 'active'
   where a.is_orchestrator and exists (select 1 from ap)
     and not exists (select 1 from mine m where m.source = 'workflow' and m.source_id = w.id::text)
  union all
  select 'warning', 'workflow_targets_agent',
         format('%s « %s » confie du travail à « %s », qui ne l''a pas dans ses pools : l''étape échouera.',
                case r.kind when 'automation' then 'L''automatisation' else 'La procédure' end, r.name, a.name),
         null::uuid, r.id, p_agent
    from public.resource_registry r, a
   where r.source = 'workflow' and r.project_id = a.project_id and r.status = 'active'
     and r.metadata -> 'agent_ids' ? p_agent::text and exists (select 1 from ap)
     and not exists (select 1 from mine m where m.source = 'workflow' and m.source_id = r.source_id)
$$;

/** La surveillance d'un projet : tous ses pools et tous ses agents en mode pools. */
create or replace function public.resource_coherence_report(p_project uuid)
returns table(severity text, code text, message text, pool_id uuid, registry_id uuid, agent_id uuid)
language sql
stable
set search_path = public
as $$
  select x.* from public.resource_pools p
   cross join lateral public.resource_pool_issues(p.id) x
   where p.project_id = p_project
  union
  select y.* from (
    select distinct arp.agent_id from public.agent_resource_pools arp
      join public.internal_agents ag on ag.id = arp.agent_id
     where ag.project_id = p_project and not coalesce(ag.is_archived, false)
  ) q cross join lateral public.agent_resource_issues(q.agent_id) y
$$;

-- Un pool se donne à un agent du même projet (et du même service s'il est
-- réservé), et seulement s'il est cohérent.
create or replace function public.agent_resource_pools_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  a record;
  p record;
  v_err text;
begin
  select id, name, project_id, service_dashboard_id into a from public.internal_agents where id = new.agent_id;
  select id, name, project_id, service_dashboard_id into p from public.resource_pools where id = new.pool_id;
  if a.id is null or p.id is null then
    raise exception 'resource_pool_assign: agent ou pool introuvable' using errcode = 'foreign_key_violation';
  end if;
  if a.project_id is distinct from p.project_id then
    raise exception 'resource_pool_assign: le pool « % » appartient à un autre projet', p.name using errcode = 'check_violation';
  end if;
  if p.service_dashboard_id is not null and p.service_dashboard_id is distinct from a.service_dashboard_id then
    raise exception 'resource_pool_assign: le pool « % » est réservé à un autre service', p.name using errcode = 'check_violation';
  end if;
  select x.message into v_err from public.resource_pool_issues(new.pool_id) x where x.severity = 'error' limit 1;
  if v_err is not null then
    raise exception 'resource_pool_incoherent: %', v_err using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_agent_resource_pools_guard on public.agent_resource_pools;
create trigger trg_agent_resource_pools_guard
before insert or update on public.agent_resource_pools
for each row execute function public.agent_resource_pools_guard();

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Les fonctions appelées par l'interface
-- ────────────────────────────────────────────────────────────────────────────
/** Le registre visible depuis un projet : ses ressources, celles de l'espace
 *  (serveurs MCP) et les compétences système. */
create or replace function public.resource_registry_for_project(p_project uuid)
returns setof public.resource_registry
language sql
stable
set search_path = public
as $$
  select r.* from public.resource_registry r
    join public.projects pr on pr.id = p_project
   where (r.project_id = p_project
          or (r.project_id is null and r.workspace_id = pr.workspace_id)
          or (r.workspace_id is null))
     and r.status <> 'removed'
   order by r.kind, r.name
$$;

create or replace function public.resource_registry_rebuild_internal(p_project uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws uuid;
  v_id uuid;
  v_n integer;
begin
  select workspace_id into v_ws from public.projects where id = p_project;
  if v_ws is null then return 0; end if;
  perform public.resource_registry_seed_builtin(p_project);
  for v_id in select id from public.mcp_servers where workspace_id = v_ws loop perform public.resource_registry_sync_mcp(v_id); end loop;
  for v_id in select id from public.connectors where project_id = p_project and source = 'composio' loop perform public.resource_registry_sync_composio(v_id); end loop;
  for v_id in select id from public.custom_connectors where project_id = p_project loop perform public.resource_registry_sync_custom_connector(v_id); end loop;
  for v_id in select id from public.rag_collections where project_id = p_project loop perform public.resource_registry_sync_rag(v_id); end loop;
  for v_id in select id from public.agent_skills where workspace_id = v_ws loop perform public.resource_registry_sync_skill(v_id); end loop;
  for v_id in select id from public.aiops_guardrails where project_id = p_project loop perform public.resource_registry_sync_guardrail(v_id); end loop;
  for v_id in select id from public.agent_workflows where project_id = p_project loop perform public.resource_registry_sync_workflow(v_id); end loop;
  for v_id in select id from public.internal_agents where project_id = p_project loop perform public.resource_registry_sync_agent(v_id); end loop;
  -- Une ressource disparue que plus aucun pool ne cite n'a plus rien à signaler.
  delete from public.resource_registry r
   where r.status = 'removed' and (r.project_id = p_project or (r.project_id is null and r.workspace_id = v_ws))
     and not exists (select 1 from public.resource_pool_items i where i.registry_id = r.id)
     and not exists (
       select 1 from public.resource_registry c join public.resource_pool_items i on i.registry_id = c.id
        where c.parent_id = r.id);
  select count(*) into v_n from public.resource_registry where project_id = p_project or (project_id is null and workspace_id = v_ws);
  return v_n;
end;
$$;

/** Resynchronise le registre d'un projet (bouton « Resynchroniser »). */
create or replace function public.resource_registry_rebuild(p_project uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_ws uuid;
begin
  select workspace_id into v_ws from public.projects where id = p_project;
  if v_ws is null or not public.is_workspace_member(v_ws) then
    raise exception 'resource_registry_rebuild: projet introuvable' using errcode = 'insufficient_privilege';
  end if;
  return public.resource_registry_rebuild_internal(p_project);
end;
$$;

/**
 * Le passage au mode pools sans rien perdre : un pool fait des accès actuels
 * de l'agent (serveurs MCP, compétences, outils, collections), des agents de
 * son service pour l'A2A, et du travail qu'on lui confie (procédures du
 * service s'il en est l'assistant, workflows qui lui passent la main). Le pool
 * est réservé au service de l'agent. Il ne lui est donné que s'il est cohérent ;
 * sinon il reste à corriger, et la réponse dit pourquoi.
 */
create or replace function public.resource_pool_from_agent(p_agent uuid, p_name text default null, p_assign boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a record;
  v_pool uuid;
  v_name text;
  v_n integer := 0;
  v_errors jsonb;
  v_assigned boolean := false;
begin
  select id, workspace_id, project_id, service_dashboard_id, name, coalesce(is_orchestrator, false) as is_orchestrator
    into a from public.internal_agents where id = p_agent;
  if a.id is null then
    raise exception 'resource_pool_from_agent: agent introuvable' using errcode = 'no_data_found';
  end if;
  -- Security definer : le droit d'écrire un pool est vérifié ici, comme la
  -- RLS de resource_pools le ferait. Sans utilisateur, c'est le serveur.
  if auth.uid() is not null and coalesce(public.workspace_role(a.workspace_id), '') not in ('owner', 'admin', 'member') then
    raise exception 'resource_pool_from_agent: droits insuffisants sur cet espace' using errcode = 'insufficient_privilege';
  end if;
  perform public.resource_registry_rebuild_internal(a.project_id);

  v_name := left(coalesce(nullif(btrim(p_name), ''), 'Accès de ' || a.name), 70);
  while exists (select 1 from public.resource_pools where project_id = a.project_id and name = v_name) loop
    v_n := v_n + 1;
    v_name := left(coalesce(nullif(btrim(p_name), ''), 'Accès de ' || a.name), 70) || ' (' || v_n || ')';
  end loop;

  insert into public.resource_pools (workspace_id, project_id, service_dashboard_id, name, description, created_by)
  values (a.workspace_id, a.project_id, a.service_dashboard_id, v_name,
          'Créé à partir des accès de ' || a.name || ' au passage en mode pools.', auth.uid())
  returning id into v_pool;

  insert into public.resource_pool_items (pool_id, registry_id, added_by)
  select v_pool, r.id, auth.uid() from (
    -- Serveurs MCP activés.
    select reg.id from public.agent_mcp_servers ams
      join public.resource_registry reg on reg.source = 'mcp' and reg.source_id = ams.server_id::text and reg.item_key = ''
     where ams.agent_id = p_agent
    union
    -- Compétences activées.
    select reg.id from public.agent_skill_activations act
      join public.resource_registry reg on reg.source = 'skill' and reg.source_id = act.skill_id::text
     where act.agent_id = p_agent
    union
    -- Apps Composio : la connexion du projet ou du service de l'agent.
    select reg.id from public.internal_agent_tools t
      join public.resource_registry reg on reg.source = 'composio' and reg.kind = 'toolset'
       and reg.metadata ->> 'toolkit' = lower(t.config ->> 'toolkit') and reg.project_id = a.project_id
       and (reg.service_dashboard_id is null or reg.service_dashboard_id = a.service_dashboard_id)
     where t.agent_id = p_agent and t.enabled and t.kind = 'composio_toolkit'
    union
    -- Outils customisés.
    select reg.id from public.internal_agent_tools t
      join public.resource_registry reg on reg.source = 'custom_connector' and reg.item_key = ''
       and reg.source_id = t.config ->> 'connector_id'
     where t.agent_id = p_agent and t.enabled and t.kind = 'custom_connector'
    union
    -- Collections : celles de la ligne ; sans liste, tout le projet (c'était le sens d'une liste vide).
    select reg.id from public.internal_agent_tools t
      join public.resource_registry reg on reg.kind = 'knowledge' and reg.project_id = a.project_id
       and (jsonb_typeof(t.config -> 'collection_ids') is distinct from 'array'
            or jsonb_array_length(t.config -> 'collection_ids') = 0
            or t.config -> 'collection_ids' ? reg.source_id)
     where t.agent_id = p_agent and t.enabled and t.kind = 'rag_search'
    union
    -- Familles intégrées.
    select reg.id from public.internal_agent_tools t
      join public.resource_registry reg on reg.source = 'builtin' and reg.source_id = a.project_id::text and reg.item_key = t.kind
     where t.agent_id = p_agent and t.enabled
    union
    -- Les collègues du même service (l'A2A d'avant allait à tout le projet ;
    -- le pool part du cercle le plus proche).
    select reg.id from public.resource_registry reg
     where reg.source = 'agent' and reg.status = 'active' and reg.project_id = a.project_id
       and reg.source_id <> p_agent::text
       and reg.service_dashboard_id is not distinct from a.service_dashboard_id
    union
    -- Les procédures du service, s'il en est l'assistant.
    select reg.id from public.resource_registry reg
     where a.is_orchestrator and reg.source = 'workflow' and reg.kind = 'procedure' and reg.status = 'active'
       and reg.service_dashboard_id is not distinct from a.service_dashboard_id and a.service_dashboard_id is not null
    union
    -- Les workflows qui lui passent la main, de quelque service qu'ils viennent.
    select reg.id from public.resource_registry reg
     where reg.source = 'workflow' and reg.status = 'active' and reg.project_id = a.project_id
       and reg.metadata -> 'agent_ids' ? p_agent::text
  ) r
  join public.resource_registry rr on rr.id = r.id
  where rr.status <> 'removed'
    and (rr.kind in ('agent', 'automation', 'procedure') or rr.service_dashboard_id is null
         or rr.service_dashboard_id is not distinct from a.service_dashboard_id);

  select coalesce(jsonb_agg(x.message), '[]'::jsonb) into v_errors
    from public.resource_pool_issues(v_pool) x where x.severity = 'error';
  if p_assign and jsonb_array_length(v_errors) = 0 then
    insert into public.agent_resource_pools (agent_id, pool_id, assigned_by) values (p_agent, v_pool, auth.uid());
    v_assigned := true;
  end if;
  return jsonb_build_object('pool_id', v_pool, 'name', v_name, 'assigned', v_assigned, 'errors', v_errors);
end;
$$;

-- Une fonction est exécutable par PUBLIC par défaut : on ferme, puis on ouvre
-- aux seules sessions connectées.
revoke execute on function public.resource_pool_issues(uuid) from public, anon;
revoke execute on function public.agent_resource_issues(uuid) from public, anon;
revoke execute on function public.resource_coherence_report(uuid) from public, anon;
revoke execute on function public.resource_registry_for_project(uuid) from public, anon;
revoke execute on function public.resource_registry_rebuild(uuid) from public, anon;
revoke execute on function public.resource_pool_from_agent(uuid, text, boolean) from public, anon;
grant execute on function public.resource_pool_issues(uuid) to authenticated;
grant execute on function public.agent_resource_issues(uuid) to authenticated;
grant execute on function public.resource_coherence_report(uuid) to authenticated;
grant execute on function public.resource_registry_for_project(uuid) to authenticated;
grant execute on function public.resource_registry_rebuild(uuid) to authenticated;
grant execute on function public.resource_pool_from_agent(uuid, text, boolean) to authenticated;
-- Les fonctions de synchronisation ne s'appellent que par les triggers et les
-- fonctions ci-dessus (security definer).
revoke execute on function public.resource_registry_put(uuid, uuid, uuid, text, text, text, text, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.resource_registry_mark_removed(text, text) from public, anon, authenticated;
revoke execute on function public.resource_registry_rebuild_internal(uuid) from public, anon, authenticated;
revoke execute on function public.resource_registry_seed_builtin(uuid) from public, anon, authenticated;
revoke execute on function public.resource_registry_sync_mcp(uuid) from public, anon, authenticated;
revoke execute on function public.resource_registry_sync_composio(uuid) from public, anon, authenticated;
revoke execute on function public.resource_registry_sync_custom_connector(uuid) from public, anon, authenticated;
revoke execute on function public.resource_registry_sync_rag(uuid) from public, anon, authenticated;
revoke execute on function public.resource_registry_sync_skill(uuid) from public, anon, authenticated;
revoke execute on function public.resource_registry_sync_guardrail(uuid) from public, anon, authenticated;
revoke execute on function public.resource_registry_sync_workflow(uuid) from public, anon, authenticated;
revoke execute on function public.resource_registry_sync_agent(uuid) from public, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Reprise de l'existant
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_id uuid;
begin
  for v_id in select id from public.agent_skills where workspace_id is null loop
    perform public.resource_registry_sync_skill(v_id);
  end loop;
  for v_id in select id from public.projects loop
    perform public.resource_registry_rebuild_internal(v_id);
  end loop;
end;
$$;
