-- 0189_office_documents_blocks.sql
-- `office_documents` becomes the HUMAN half of the new artifact system.
--
-- Agents write to internal_agent_deliverables (run_id, agent_id — that is what
-- the success contract verifies against). A person creating an artifact by hand
-- has no run and no agent, and that table's RLS is keyed on agent access, so a
-- row with a null agent_id would be unreadable by its own author.
--
-- So the human path keeps its own table — but not its own FORMAT. `content`
-- now holds the same Editor.js document `{ blocks: [...] }` an agent produces,
-- and the same renderer draws both. Only two kinds remain: `report` (a
-- scrolling document) and `presentation` (the same blocks cut into slides).
-- `document` and `spreadsheet` go with the editors that served them.

alter table public.office_documents
  drop constraint if exists office_documents_kind_check;

alter table public.office_documents
  add constraint office_documents_kind_check
  check (kind in ('report', 'presentation'));

-- The table was emptied by 0188, so no row needs converting: the constraint can
-- tighten without a backfill.
