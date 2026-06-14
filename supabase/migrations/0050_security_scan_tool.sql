-- Allow the "security_scan" tool kind for cyber agents (defensive + consented
-- active scanning).
alter table public.internal_agent_tools drop constraint if exists internal_agent_tools_kind_check;
alter table public.internal_agent_tools add constraint internal_agent_tools_kind_check
  check (kind in (
    'web_search','web_fetch','db_read','rag_search',
    'edge_function','vault_connector','connector_action','security_scan','custom'
  ));
