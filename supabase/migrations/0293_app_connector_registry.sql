-- 0293_app_connector_registry.sql
-- Les outils des connecteurs d'applications deviennent des ressources de pool.
--
-- 0291 ne retenait des connecteurs d'applications que les connexions Composio,
-- et une app n'y avait ses actions que si quelqu'un les avait découvertes :
-- sinon elle ne se donnait qu'entière. Les connecteurs maison (Slack, HubSpot,
-- Stripe, GitHub… le catalogue de _shared/connector-actions.ts) n'y étaient
-- pas du tout : un pool ne pouvait les donner que par la famille entière
-- « connector_action », sans choisir ni l'app ni l'action.
--
--   1. LE CATALOGUE (connector_action_catalog). Les actions de chaque
--      connecteur maison, recopiées de CONNECTOR_ACTIONS : le registre est
--      écrit par des triggers SQL, qui ne lisent pas le TypeScript.
--      backend/src/shared/connector-catalog-sql.ts en tire le bloc de
--      synchronisation ; connector-catalog.test.ts échoue dès que les deux
--      divergent.
--
--   2. LE REGISTRE. Chaque connexion maison partagée (projet ou service) dont
--      le fournisseur a un catalogue devient une source « app_connector » :
--      une ligne « toolset » (l'app entière) et une ligne « tool » par action,
--      lecture ou écriture d'après le catalogue. Une connexion personnelle
--      n'est pas une ressource à distribuer.
--      Les actions Composio sont désormais découvertes à la connexion et par
--      « Resynchroniser » (_shared/composio-discovery.ts), avec les
--      indications de Composio (readOnlyHint, destructiveHint) pour le risque.
--
--   3. LA COHÉRENCE. Un bloc Outil d'un workflow appelle une app via Composio
--      ou en connecteur maison (automation-engine choisit la porte) : l'un ou
--      l'autre dans le pool la couvre. Un accès granulaire « connector_action »
--      hors des pools est signalé, et « Créer un pool depuis ses accès » prend
--      l'app plutôt que la famille entière.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Le catalogue
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.connector_action_catalog (
  provider    text not null,
  action      text not null,
  description text not null default '',
  is_write    boolean not null default false,
  primary key (provider, action)
);

comment on table public.connector_action_catalog is
  'Les actions des connecteurs maison (0293), recopiées de _shared/connector-actions.ts par backend/src/shared/connector-catalog-sql.ts.';

alter table public.connector_action_catalog enable row level security;
drop policy if exists "connector_action_catalog: read" on public.connector_action_catalog;
create policy "connector_action_catalog: read" on public.connector_action_catalog for select
using (auth.role() = 'authenticated');
revoke insert, update, delete on public.connector_action_catalog from anon, authenticated;

insert into public.connector_action_catalog (provider, action, description, is_write) values
  ('airtable', 'list_records', 'List records from a base table.', false),
  ('airtable', 'create_record', 'Create a record in a base table.', true),
  ('athena', 'query', 'Run a read-only SQL query against the S3 data lake (Athena).', false),
  ('athena', 'list_tables', 'List tables in the configured Glue database.', false),
  ('attio', 'list_records', 'Query records for an object (e.g. companies, people).', false),
  ('azure-blob', 'list_containers', 'List containers in the storage account.', false),
  ('azure-blob', 'list_blobs', 'List blobs in a container.', false),
  ('azure-synapse', 'query', 'Run a read-only SQL query (SELECT) on Synapse serverless.', false),
  ('bamboohr', 'employee_directory', 'Company employee directory.', false),
  ('bamboohr', 'time_off_requests', 'List time-off requests.', false),
  ('bigquery', 'query', 'Run a read-only SQL query (BigQuery standard SQL).', false),
  ('bigquery', 'list_datasets', 'List datasets in the project.', false),
  ('deel', 'list_people', 'List workers / contractors.', false),
  ('discord', 'post_message', 'Post a message to the configured Discord channel (webhook).', true),
  ('factorial', 'list_employees', 'List employees.', false),
  ('factorial', 'list_leaves', 'List leaves / time off.', false),
  ('figma', 'get_file', 'Get a file''s document tree (nodes, pages).', false),
  ('figma', 'get_comments', 'List comments on a file.', false),
  ('gcs', 'list_objects', 'List objects in a GCS bucket (optionally by prefix).', false),
  ('gcs', 'read_object', 'Read a text/JSON object''s content (first 100KB).', false),
  ('github', 'list_repos', 'List repositories accessible to the token.', false),
  ('github', 'list_issues', 'List open issues for a repo.', false),
  ('github', 'create_issue', 'Open an issue on a repo.', true),
  ('google-calendar', 'list_events', 'List upcoming events.', false),
  ('google-calendar', 'create_event', 'Create a calendar event.', false),
  ('greenhouse', 'list_jobs', 'List open jobs.', false),
  ('greenhouse', 'list_candidates', 'List recent candidates.', false),
  ('hubspot', 'list_contacts', 'List CRM contacts.', false),
  ('hubspot', 'list_deals', 'List deals in the pipeline.', false),
  ('hubspot', 'list_companies', 'List companies.', false),
  ('hubspot', 'search_contacts', 'Search contacts by a query string (email/name).', false),
  ('hubspot', 'create_note', 'Create a note in the CRM.', true),
  ('intercom', 'list_contacts', 'List contacts.', false),
  ('intercom', 'search_conversations', 'List recent conversations.', false),
  ('lever', 'list_candidates', 'List recent opportunities/candidates.', false),
  ('lever', 'list_postings', 'List published job postings.', false),
  ('linear', 'list_issues', 'List recent issues (title, state, assignee, priority).', false),
  ('linear', 'list_teams', 'List teams.', false),
  ('linear', 'list_projects', 'List projects and their progress.', false),
  ('linear', 'create_issue', 'Create an issue in a team.', true),
  ('notion', 'search', 'Search pages and databases by text.', false),
  ('notion', 'query_database', 'Query rows of a Notion database.', false),
  ('notion', 'get_page', 'Get a page''s properties.', false),
  ('notion', 'create_page', 'Create a page inside a parent page.', true),
  ('pipedrive', 'list_deals', 'List deals.', false),
  ('pipedrive', 'list_persons', 'List persons (contacts).', false),
  ('pipedrive', 'pipeline_summary', 'Summary of deals per stage in the default pipeline.', false),
  ('plausible', 'aggregate', 'Aggregate visitors/pageviews/bounce for a site over a period.', false),
  ('plausible', 'breakdown', 'Top pages or sources breakdown.', false),
  ('posthog', 'list_insights', 'List saved insights (dashboards'' charts).', false),
  ('posthog', 'trends', 'Run a trends query for an event over time.', false),
  ('salesforce', 'soql_query', 'Run a read-only SOQL query (SELECT only).', false),
  ('salesforce', 'list_opportunities', 'List recent opportunities.', false),
  ('sentry', 'list_projects', 'List projects you can access.', false),
  ('sentry', 'list_issues', 'List unresolved issues for a project.', false),
  ('slack', 'post_message', 'Post a message to a channel using the Slack bot token (chat.postMessage).', true),
  ('slack', 'list_channels', 'List public channels the bot can see.', false),
  ('slack', 'post_webhook', 'Post to the configured incoming webhook (no channel choice).', true),
  ('stripe', 'list_customers', 'List customers.', false),
  ('stripe', 'list_subscriptions', 'List subscriptions (optionally by status).', false),
  ('stripe', 'list_invoices', 'List invoices.', false),
  ('stripe', 'balance', 'Current account balance.', false),
  ('teams', 'post_message', 'Post a message to the configured Microsoft Teams channel (incoming webhook).', true),
  ('telegram', 'send_message', 'Send a message to the configured Telegram chat (bot token + chat_id).', true),
  ('workable', 'list_candidates', 'List candidates across jobs.', false),
  ('workable', 'list_jobs', 'List published jobs.', false)
on conflict (provider, action) do update set description = excluded.description, is_write = excluded.is_write;

delete from public.connector_action_catalog c
 where not exists (select 1 from (values
   ('airtable', 'list_records'),
   ('airtable', 'create_record'),
   ('athena', 'query'),
   ('athena', 'list_tables'),
   ('attio', 'list_records'),
   ('azure-blob', 'list_containers'),
   ('azure-blob', 'list_blobs'),
   ('azure-synapse', 'query'),
   ('bamboohr', 'employee_directory'),
   ('bamboohr', 'time_off_requests'),
   ('bigquery', 'query'),
   ('bigquery', 'list_datasets'),
   ('deel', 'list_people'),
   ('discord', 'post_message'),
   ('factorial', 'list_employees'),
   ('factorial', 'list_leaves'),
   ('figma', 'get_file'),
   ('figma', 'get_comments'),
   ('gcs', 'list_objects'),
   ('gcs', 'read_object'),
   ('github', 'list_repos'),
   ('github', 'list_issues'),
   ('github', 'create_issue'),
   ('google-calendar', 'list_events'),
   ('google-calendar', 'create_event'),
   ('greenhouse', 'list_jobs'),
   ('greenhouse', 'list_candidates'),
   ('hubspot', 'list_contacts'),
   ('hubspot', 'list_deals'),
   ('hubspot', 'list_companies'),
   ('hubspot', 'search_contacts'),
   ('hubspot', 'create_note'),
   ('intercom', 'list_contacts'),
   ('intercom', 'search_conversations'),
   ('lever', 'list_candidates'),
   ('lever', 'list_postings'),
   ('linear', 'list_issues'),
   ('linear', 'list_teams'),
   ('linear', 'list_projects'),
   ('linear', 'create_issue'),
   ('notion', 'search'),
   ('notion', 'query_database'),
   ('notion', 'get_page'),
   ('notion', 'create_page'),
   ('pipedrive', 'list_deals'),
   ('pipedrive', 'list_persons'),
   ('pipedrive', 'pipeline_summary'),
   ('plausible', 'aggregate'),
   ('plausible', 'breakdown'),
   ('posthog', 'list_insights'),
   ('posthog', 'trends'),
   ('salesforce', 'soql_query'),
   ('salesforce', 'list_opportunities'),
   ('sentry', 'list_projects'),
   ('sentry', 'list_issues'),
   ('slack', 'post_message'),
   ('slack', 'list_channels'),
   ('slack', 'post_webhook'),
   ('stripe', 'list_customers'),
   ('stripe', 'list_subscriptions'),
   ('stripe', 'list_invoices'),
   ('stripe', 'balance'),
   ('teams', 'post_message'),
   ('telegram', 'send_message'),
   ('workable', 'list_candidates'),
   ('workable', 'list_jobs')
   ) v(provider, action) where v.provider = c.provider and v.action = c.action);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Le registre
-- ────────────────────────────────────────────────────────────────────────────
alter table public.resource_registry drop constraint if exists resource_registry_source_check;
alter table public.resource_registry add constraint resource_registry_source_check
  check (source in ('mcp', 'composio', 'app_connector', 'custom_connector', 'builtin', 'rag', 'skill', 'guardrail', 'workflow', 'agent'));

-- ── Connecteurs maison : la connexion partagée et les actions du catalogue ───
create or replace function public.resource_registry_sync_app_connector(p_connector uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  a record;
  v_set uuid;
  v_status text;
  v_provider text;
  v_names text[] := '{}';
begin
  select id, workspace_id, project_id, provider, source, status, metadata, scope, service_dashboard_id
    into c from public.connectors where id = p_connector;
  if not found then
    perform public.resource_registry_mark_removed('app_connector', p_connector::text);
    return;
  end if;
  v_provider := lower(coalesce(c.provider, ''));
  if c.source is distinct from 'in_house' or c.scope = 'personal' or c.workspace_id is null
     or not exists (select 1 from public.connector_action_catalog k where k.provider = v_provider) then
    perform public.resource_registry_mark_removed('app_connector', p_connector::text);
    return;
  end if;
  v_status := case when c.status in ('connected', 'read_only', 'write_enabled') then 'active' else 'unavailable' end;
  v_set := public.resource_registry_put(
    c.workspace_id, c.project_id, case when c.scope = 'dashboard' then c.service_dashboard_id end,
    'toolset', 'app_connector', c.id::text, '', null,
    coalesce(nullif(c.metadata ->> 'name', ''), initcap(replace(replace(v_provider, '-', ' '), '_', ' '))),
    nullif(c.metadata ->> 'description', ''), 'unknown', v_status,
    jsonb_build_object('provider', v_provider));
  for a in select * from public.connector_action_catalog k where k.provider = v_provider order by k.action loop
    v_names := v_names || a.action;
    perform public.resource_registry_put(
      c.workspace_id, c.project_id, case when c.scope = 'dashboard' then c.service_dashboard_id end,
      'tool', 'app_connector', c.id::text, a.action, v_set,
      a.action, a.description, case when a.is_write then 'write' else 'read' end,
      v_status, jsonb_build_object('provider', v_provider));
  end loop;
  -- Une action retirée du catalogue.
  update public.resource_registry
     set status = 'removed', synced_at = now()
   where source = 'app_connector' and source_id = c.id::text and item_key <> ''
     and not (item_key = any(v_names)) and status <> 'removed';
end;
$$;

/** Une ligne de connectors : Composio ou maison, chacune sa synchronisation
 *  (chacune retire sa source quand la ligne n'est plus des siennes). */
create or replace function public.resource_registry_sync_connector(p_connector uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.resource_registry_sync_composio(p_connector);
  perform public.resource_registry_sync_app_connector(p_connector);
end;
$$;

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
      -- Les indications de Composio (0293), quand la découverte les a gardées.
      public.resource_risk_of(v_key, jsonb_build_object(
        'readOnlyHint', (case when jsonb_typeof(t -> 'tags') = 'array' then t -> 'tags' else '[]'::jsonb end) ? 'readOnlyHint',
        'destructiveHint', (case when jsonb_typeof(t -> 'tags') = 'array' then t -> 'tags' else '[]'::jsonb end) ? 'destructiveHint')),
      v_status, jsonb_build_object('toolkit', lower(c.provider)));
  end loop;
  update public.resource_registry
     set status = 'removed', synced_at = now()
   where source = 'composio' and source_id = c.id::text and item_key <> ''
     and not (item_key = any(v_keys)) and status <> 'removed';
end;
$$;

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
    when 'connectors' then perform public.resource_registry_sync_connector(v_id);
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

drop trigger if exists trg_resource_registry_composio on public.connectors;
drop trigger if exists trg_resource_registry_connectors on public.connectors;
create trigger trg_resource_registry_connectors
after insert or delete or update of provider, source, status, permissions, metadata, scope, service_dashboard_id on public.connectors
for each row execute function public.resource_registry_on_source();

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
  for v_id in select id from public.connectors where project_id = p_project loop perform public.resource_registry_sync_connector(v_id); end loop;
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

-- ────────────────────────────────────────────────────────────────────────────
-- 3. La cohérence
-- ────────────────────────────────────────────────────────────────────────────
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
     -- … ni en connecteur maison (0293) : un bloc Outil passe par l'un ou l'autre.
     and not exists (
           select 1 from live t where t.source = 'app_connector' and t.kind = 'toolset' and t.metadata ->> 'provider' = a ->> 'provider')
     and not exists (
           select 1 from live t
            where t.source = 'app_connector' and t.kind = 'tool' and t.metadata ->> 'provider' = a ->> 'provider'
              and lower(t.item_key) = lower(a ->> 'action') and coalesce(a ->> 'action', '') <> '')
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
           when 'connector_action' then not exists (
             select 1 from mine m
              where (m.source = 'app_connector' and m.metadata ->> 'provider' = lower(t.config ->> 'provider'))
                 or (m.source = 'builtin' and m.item_key = 'connector_action'))
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
    -- Connecteurs maison (0293) : la connexion du projet, ou du service de l'agent.
    select reg.id from public.internal_agent_tools t
      join public.resource_registry reg on reg.source = 'app_connector' and reg.kind = 'toolset'
       and reg.metadata ->> 'provider' = lower(t.config ->> 'provider') and reg.project_id = a.project_id
       and (reg.service_dashboard_id is null or reg.service_dashboard_id = a.service_dashboard_id)
     where t.agent_id = p_agent and t.enabled and t.kind = 'connector_action'
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
    -- Familles intégrées. Un connecteur maison est donné par son app (ci-dessus),
    -- plus par la famille entière.
    select reg.id from public.internal_agent_tools t
      join public.resource_registry reg on reg.source = 'builtin' and reg.source_id = a.project_id::text and reg.item_key = t.kind
     where t.agent_id = p_agent and t.enabled and t.kind <> 'connector_action'
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

revoke execute on function public.resource_registry_sync_app_connector(uuid) from public, anon, authenticated;
revoke execute on function public.resource_registry_sync_connector(uuid) from public, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Reprise de l'existant
-- ────────────────────────────────────────────────────────────────────────────
-- Les connexions maison entrent au registre ; les actions Composio déjà en
-- cache reprennent leur risque d'après les indications de Composio.
do $$
declare
  v_id uuid;
begin
  for v_id in select id from public.connectors loop
    perform public.resource_registry_sync_connector(v_id);
  end loop;
end;
$$;
