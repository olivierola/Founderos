-- Storage bucket for media (images, video, audio, files) uploaded inside the
-- Office Plate editor.

insert into storage.buckets (id, name, public)
values ('office-media', 'office-media', true)
on conflict (id) do nothing;

create policy "office-media upload"
  on storage.objects for insert
  with check (bucket_id = 'office-media' and auth.role() = 'authenticated');

create policy "office-media select"
  on storage.objects for select
  using (bucket_id = 'office-media');

create policy "office-media update"
  on storage.objects for update
  using (bucket_id = 'office-media' and auth.role() = 'authenticated');

create policy "office-media delete"
  on storage.objects for delete
  using (bucket_id = 'office-media' and auth.role() = 'authenticated');
