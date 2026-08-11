-- 0188_purge_office_documents.sql
-- Clean break, second half.
--
-- 0187 purged `internal_agent_deliverables`. It left `office_documents`
-- untouched, so agent work written through the retired create_artifact path was
-- still on screen — Plate documents, CSV spreadsheets, "Title | body" decks,
-- none of which the Editor.js renderer can read.
--
-- The purge is TOTAL and not selective, because it cannot be selective: an
-- agent stamps `created_by` with the id of the USER who owns it, so an
-- agent-authored row is byte-identical to a hand-authored one. There is no
-- column — no run_id, no agent_id — to tell them apart. Requested and confirmed
-- by the owner with that consequence stated.
--
-- Not reversible. The table itself stays: the gallery's "New artifact" and
-- "Upload file" tiles still write to it until they are moved onto Editor.js,
-- which is the last step of this migration path.

delete from public.office_documents;
