-- 0137_room_artifacts.sql
-- Lets a Room's Artifacts tab distinguish "created in this room" from
-- "other" office_documents/office_media (same workspace/project, created
-- elsewhere). Nullable — existing rows and non-room creation flows are
-- unaffected.

alter table public.office_documents
  add column if not exists service_room_id uuid references public.service_rooms(id) on delete set null;

alter table public.office_media
  add column if not exists service_room_id uuid references public.service_rooms(id) on delete set null;

create index if not exists idx_office_documents_room on public.office_documents(service_room_id);
create index if not exists idx_office_media_room on public.office_media(service_room_id);
