-- 0147_artifact_card_color.sql
-- Per-artifact card colour for the Artifacts gallery. A null value falls back to
-- a kind-based default in the UI. Stores a palette key (see CARD_COLORS), not a
-- raw colour, so the design stays centralised.

alter table public.office_documents
  add column if not exists card_color text;
alter table public.office_media
  add column if not exists card_color text;
