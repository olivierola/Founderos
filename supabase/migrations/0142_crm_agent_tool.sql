-- CRM agent capability: a new `crm` tool kind (read/write the in-house CRM)
-- and a `crm_write` approval action_kind for its gated write actions.

alter table public.internal_agent_tools
  drop constraint internal_agent_tools_kind_check;
alter table public.internal_agent_tools
  add constraint internal_agent_tools_kind_check check (
    kind in (
      'web_search', 'web_fetch', 'db_read', 'rag_search', 'edge_function',
      'vault_connector', 'connector_action', 'composio_toolkit', 'crm',
      'security_scan', 'custom'
    )
  );

alter table public.internal_agent_approvals
  drop constraint internal_agent_approvals_action_kind_check;
alter table public.internal_agent_approvals
  add constraint internal_agent_approvals_action_kind_check check (
    action_kind in ('edge_function', 'webhook', 'connector_action', 'composio_action', 'crm_write')
  );
