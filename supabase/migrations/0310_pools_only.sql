-- 0310 : un agent ne reçoit plus ses ressources QUE par des pools.
--
-- Jusqu'ici (0291), un agent sans pool était en « mode granulaire » : ses
-- lignes d'outils, ses compétences activées et ses serveurs MCP lui donnaient
-- directement accès. Désormais :
--
--   1. À l'exécution, un agent n'atteint que l'union de ses pools ; sans pool,
--      il n'a que les outils de base (resource-pools.ts : plus de retour au
--      mode granulaire).
--   2. Chaque agent peut avoir un POOL PERSONNEL (resource_pools.owner_agent_id),
--      un pool comme les autres, visible et modifiable dans l'onglet Pools.
--   3. Une attribution directe, d'où qu'elle vienne (modèle d'agent, assistant
--      de service, ancienne interface, fonction), n'ouvre plus rien par
--      elle-même : des triggers la versent dans le pool personnel de l'agent
--      (et l'en retirent quand elle disparaît). Les lignes d'outils restent ce
--      qu'elles sont aussi : la CONFIGURATION des familles qui en demandent une
--      (tables lues, fonctions serveur, coffre, webhooks).
--   4. Les agents qui étaient en mode granulaire reçoivent maintenant un pool
--      personnel fait de leurs accès d'aujourd'hui : personne ne perd rien.

alter table public.resource_pools
  add column if not exists owner_agent_id uuid references public.internal_agents(id) on delete cascade;
create unique index if not exists resource_pools_owner_agent on public.resource_pools(owner_agent_id) where owner_agent_id is not null;

comment on column public.resource_pools.owner_agent_id is
  'Pool personnel : ce qu''on donne directement à cet agent y est versé (0310).';

-- ── Le pool personnel d'un agent ─────────────────────────────────────────────

create or replace function public.agent_personal_pool(p_agent uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  a record;
  v_pool uuid;
  v_name text;
  v_n integer := 0;
begin
  select id from public.resource_pools where owner_agent_id = p_agent into v_pool;
  if v_pool is not null then return v_pool; end if;
  select id, workspace_id, project_id, service_dashboard_id, name into a from public.internal_agents where id = p_agent;
  if a.id is null then raise exception 'agent_personal_pool: agent introuvable' using errcode = 'no_data_found'; end if;
  v_name := left('Accès de ' || a.name, 70);
  while exists (select 1 from public.resource_pools where project_id = a.project_id and name = v_name) loop
    v_n := v_n + 1;
    v_name := left('Accès de ' || a.name, 70) || ' (' || v_n || ')';
  end loop;
  insert into public.resource_pools (workspace_id, project_id, service_dashboard_id, name, description, owner_agent_id, created_by)
  values (a.workspace_id, a.project_id, a.service_dashboard_id, v_name,
          'Pool personnel de ' || a.name || ' : ce qu''on lui donne directement y est versé.', p_agent, auth.uid())
  returning id into v_pool;
  -- Vide, il est cohérent : la garde d'attribution le laisse passer.
  insert into public.agent_resource_pools (agent_id, pool_id, assigned_by)
  values (p_agent, v_pool, auth.uid()) on conflict do nothing;
  return v_pool;
end $$;

-- ── Ce qu'une attribution directe désigne dans le registre ──────────────────

-- p_table : 'skill' (agent_skill_activations), 'mcp' (agent_mcp_servers) ou
-- 'tool' (internal_agent_tools) ; p_ref : l'identifiant de la compétence ou du
-- serveur, ou la ligne d'outil en jsonb. Mêmes correspondances que
-- resource_pool_from_agent (0291, 0293).
create or replace function public.agent_grant_registry_ids(p_agent uuid, p_table text, p_ref jsonb)
returns uuid[] language plpgsql stable security definer set search_path = public as $$
declare
  a record;
  v_kind text := p_ref ->> 'kind';
  v_cfg jsonb := coalesce(p_ref -> 'config', '{}'::jsonb);
  v_ids uuid[];
begin
  select id, project_id, service_dashboard_id into a from public.internal_agents where id = p_agent;
  if a.id is null then return '{}'; end if;
  if p_table = 'skill' then
    select array_agg(reg.id) into v_ids from public.resource_registry reg
     where reg.source = 'skill' and reg.source_id = p_ref ->> 'id';
  elsif p_table = 'mcp' then
    select array_agg(reg.id) into v_ids from public.resource_registry reg
     where reg.source = 'mcp' and reg.source_id = p_ref ->> 'id' and reg.item_key = '';
  elsif v_kind = 'composio_toolkit' then
    select array_agg(reg.id) into v_ids from public.resource_registry reg
     where reg.source = 'composio' and reg.kind = 'toolset' and reg.project_id = a.project_id
       and reg.metadata ->> 'toolkit' = lower(v_cfg ->> 'toolkit')
       and (reg.service_dashboard_id is null or reg.service_dashboard_id = a.service_dashboard_id);
  elsif v_kind = 'connector_action' then
    select array_agg(reg.id) into v_ids from public.resource_registry reg
     where reg.source = 'app_connector' and reg.kind = 'toolset' and reg.project_id = a.project_id
       and reg.metadata ->> 'provider' = lower(v_cfg ->> 'provider')
       and (reg.service_dashboard_id is null or reg.service_dashboard_id = a.service_dashboard_id);
  elsif v_kind = 'custom_connector' then
    select array_agg(reg.id) into v_ids from public.resource_registry reg
     where reg.source = 'custom_connector' and reg.item_key = '' and reg.source_id = v_cfg ->> 'connector_id';
  elsif v_kind = 'rag_search' then
    select array_agg(reg.id) into v_ids from public.resource_registry reg
     where reg.kind = 'knowledge' and reg.project_id = a.project_id
       and (jsonb_typeof(v_cfg -> 'collection_ids') is distinct from 'array'
            or jsonb_array_length(v_cfg -> 'collection_ids') = 0
            or v_cfg -> 'collection_ids' ? reg.source_id);
  else
    select array_agg(reg.id) into v_ids from public.resource_registry reg
     where reg.source = 'builtin' and reg.source_id = a.project_id::text and reg.item_key = v_kind;
  end if;
  return coalesce(v_ids, '{}');
end $$;

-- Verse une attribution dans le pool personnel (p_add) ou l'en retire. Ne
-- touche jamais aux pools partagés.
create or replace function public.agent_grant_to_pool(p_agent uuid, p_table text, p_ref jsonb, p_add boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  a record;
  v_ids uuid[];
  v_pool uuid;
begin
  select id, project_id, service_dashboard_id, coalesce(is_archived, false) as archived into a from public.internal_agents where id = p_agent;
  if a.id is null then return; end if;
  v_ids := public.agent_grant_registry_ids(p_agent, p_table, p_ref);
  -- Une ressource créée à l'instant n'est peut-être pas encore au registre.
  if p_add and cardinality(v_ids) = 0 and a.project_id is not null then
    perform public.resource_registry_rebuild_internal(a.project_id);
    v_ids := public.agent_grant_registry_ids(p_agent, p_table, p_ref);
  end if;
  if cardinality(v_ids) = 0 then return; end if;
  if p_add then
    v_pool := public.agent_personal_pool(p_agent);
    insert into public.resource_pool_items (pool_id, registry_id, added_by)
    select v_pool, reg.id, auth.uid() from public.resource_registry reg
     where reg.id = any(v_ids) and reg.status <> 'removed'
       and (reg.kind in ('agent', 'automation', 'procedure') or reg.service_dashboard_id is null
            or reg.service_dashboard_id is not distinct from a.service_dashboard_id)
    on conflict do nothing;
  else
    select id into v_pool from public.resource_pools where owner_agent_id = p_agent;
    if v_pool is not null then
      delete from public.resource_pool_items where pool_id = v_pool and registry_id = any(v_ids);
    end if;
  end if;
end $$;

-- ── Les triggers ─────────────────────────────────────────────────────────────

create or replace function public.agent_direct_grant_to_pool() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'agent_skill_activations' then
    if tg_op = 'INSERT' then perform public.agent_grant_to_pool(new.agent_id, 'skill', jsonb_build_object('id', new.skill_id), true);
    else perform public.agent_grant_to_pool(old.agent_id, 'skill', jsonb_build_object('id', old.skill_id), false); end if;
  elsif tg_table_name = 'agent_mcp_servers' then
    if tg_op = 'INSERT' then perform public.agent_grant_to_pool(new.agent_id, 'mcp', jsonb_build_object('id', new.server_id), true);
    else perform public.agent_grant_to_pool(old.agent_id, 'mcp', jsonb_build_object('id', old.server_id), false); end if;
  else
    -- internal_agent_tools : l'ancienne attribution sort, la nouvelle entre.
    if tg_op in ('UPDATE', 'DELETE') and old.enabled then
      perform public.agent_grant_to_pool(old.agent_id, 'tool', jsonb_build_object('kind', old.kind, 'config', old.config), false);
    end if;
    if tg_op in ('INSERT', 'UPDATE') and new.enabled then
      perform public.agent_grant_to_pool(new.agent_id, 'tool', jsonb_build_object('kind', new.kind, 'config', new.config), true);
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_agent_skill_grant_pool on public.agent_skill_activations;
create trigger trg_agent_skill_grant_pool after insert or delete on public.agent_skill_activations
  for each row execute function public.agent_direct_grant_to_pool();
drop trigger if exists trg_agent_mcp_grant_pool on public.agent_mcp_servers;
create trigger trg_agent_mcp_grant_pool after insert or delete on public.agent_mcp_servers
  for each row execute function public.agent_direct_grant_to_pool();
drop trigger if exists trg_agent_tool_grant_pool on public.internal_agent_tools;
create trigger trg_agent_tool_grant_pool after insert or update of enabled, kind, config or delete on public.internal_agent_tools
  for each row execute function public.agent_direct_grant_to_pool();

-- ── Les agents qui étaient en mode granulaire ───────────────────────────────
-- Leurs accès d'aujourd'hui deviennent leur pool personnel (resource_pool_from_agent :
-- accès, collègues du service, travail qu'on leur confie). Donné même s'il
-- n'est pas encore cohérent : un agent ne doit rien perdre au passage ; l'onglet
-- Pools signale ce qui est à corriger.

-- La garde d'attribution de 0291, telle quelle, sauf pendant cette conversion
-- (founderos.pools_conversion = 'on', posé et retiré par la fonction
-- ci-dessous, dans sa transaction).
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
  if coalesce(current_setting('founderos.pools_conversion', true), '') = 'on' then return new; end if;
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

-- Rend le nombre d'agents convertis. Rejouable : un agent qui a déjà un pool
-- n'est pas touché.
create or replace function public.agents_pools_from_grants() returns integer
language plpgsql security definer set search_path = public as $$
declare
  ag record;
  v jsonb;
  v_pool uuid;
  n integer := 0;
begin
  for ag in
    -- Tous les agents sans pool, même sans accès propre : leurs collègues et
    -- les workflows qui leur passent la main leur étaient ouverts aussi.
    select a.id from public.internal_agents a
     where not exists (select 1 from public.agent_resource_pools ap where ap.agent_id = a.id)
       and a.project_id is not null
  loop
    v := public.resource_pool_from_agent(ag.id, null, false);
    v_pool := (v ->> 'pool_id')::uuid;
    update public.resource_pools set owner_agent_id = ag.id,
      description = 'Pool personnel, créé à partir de ses accès au passage aux pools (0310).'
     where id = v_pool;
    -- Donné même s'il n'est pas encore cohérent (la garde l'aurait refusé) :
    -- un agent ne perd rien au passage ; l'onglet Pools signale le reste.
    perform set_config('founderos.pools_conversion', 'on', true);
    insert into public.agent_resource_pools (agent_id, pool_id) values (ag.id, v_pool) on conflict do nothing;
    perform set_config('founderos.pools_conversion', 'off', true);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.agents_pools_from_grants() from public, anon, authenticated;

select public.agents_pools_from_grants();

revoke all on function public.agent_personal_pool(uuid) from public, anon;
revoke all on function public.agent_grant_registry_ids(uuid, text, jsonb) from public, anon;
revoke all on function public.agent_grant_to_pool(uuid, text, jsonb, boolean) from public, anon;
