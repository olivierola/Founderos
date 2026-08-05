-- The composio_toolkit agent-tool kind (added in this session's Composio
-- work) was missing from this CHECK constraint, so every attempt to enable a
-- Composio-connected toolkit for an agent failed at insert time.

alter table public.internal_agent_tools
  drop constraint internal_agent_tools_kind_check;

alter table public.internal_agent_tools
  add constraint internal_agent_tools_kind_check check (
    kind in (
      'web_search', 'web_fetch', 'db_read', 'rag_search', 'edge_function',
      'vault_connector', 'connector_action', 'composio_toolkit', 'security_scan', 'custom'
    )
  );
