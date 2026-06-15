-- Allow connector_action as an approvable action kind. Agents can now queue
-- write actions on real integrations (Slack/Teams/Linear/Notion/…) for human
-- approval; the internal-agent-approve function executes them via connector-action.
alter table public.internal_agent_approvals
  drop constraint if exists internal_agent_approvals_action_kind_check;

alter table public.internal_agent_approvals
  add constraint internal_agent_approvals_action_kind_check
  check (action_kind in ('edge_function','webhook','connector_action'));
