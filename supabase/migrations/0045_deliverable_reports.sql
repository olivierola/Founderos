-- Internal agent deliverables: richer reports + chat provenance.
--
--  1. Deliverables can now be produced during a CHAT session (not only mission
--     runs). conversation_id links a chat-created deliverable back to its
--     conversation so the chat UI can render an "artifact card" for it.
--  2. New 'report' kind: a structured JSON document
--     { title, summary, sections: [{ heading, body, kpis, chart, table, callout }] }
--     rendered as a designed report (charts, KPIs, tables) in the UI.

alter table public.internal_agent_deliverables
  add column if not exists conversation_id uuid
    references public.internal_agent_conversations(id) on delete cascade;

create index if not exists idx_internal_agent_deliverables_conversation
  on public.internal_agent_deliverables(conversation_id) where conversation_id is not null;

-- The kind column is free-text (no check constraint), so 'report' needs no DDL
-- change — this migration documents it and adds the chat linkage + index.
