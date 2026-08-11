-- 0184_assistant_connector_artifacts.sql
-- The assistant can answer with INTERACTIVE cards, not just text and files.
--
-- Configuring an agent's connectors used to dead-end: the assistant could see
-- that Slack wasn't connected and could only say "go to the Integrations
-- screen". It now emits an artifact of kind 'connectors' whose data carries the
-- proposed providers; the panel renders them as the same connector cards used
-- in the catalogue, and the CONNECT flow runs client-side from there (Composio
-- hosted page or the provider credential dialog) — the assistant never handles
-- a credential.
--
-- data shape: { agent_id: uuid|null, items: [{ slug, name, reason, status }] }

alter table public.ai_artifacts
  drop constraint if exists ai_artifacts_kind_check;

alter table public.ai_artifacts
  add constraint ai_artifacts_kind_check check (
    kind in ('document', 'json', 'table', 'code', 'csv', 'connectors')
  );
