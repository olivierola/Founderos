-- Same miss as 0140, on the approvals table: composio_action (used when a
-- non-autopilot agent's Composio tool call is queued for human approval) was
-- missing from this CHECK constraint.

alter table public.internal_agent_approvals
  drop constraint internal_agent_approvals_action_kind_check;

alter table public.internal_agent_approvals
  add constraint internal_agent_approvals_action_kind_check check (
    action_kind in ('edge_function', 'webhook', 'connector_action', 'composio_action')
  );
