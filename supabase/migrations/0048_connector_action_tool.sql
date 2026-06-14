-- Allow internal agents to have "connector_action" tools — safe read-mostly
-- actions against connected CRM / HR (and future) integrations, executed via
-- the connector-action edge function (credential decrypted server-side).
alter table public.internal_agent_tools drop constraint if exists internal_agent_tools_kind_check;
alter table public.internal_agent_tools add constraint internal_agent_tools_kind_check
  check (kind in (
    'web_search','web_fetch','db_read','rag_search',
    'edge_function','vault_connector','connector_action','custom'
  ));
