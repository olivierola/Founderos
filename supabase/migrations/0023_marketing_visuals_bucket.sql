-- Storage bucket for generated visuals attached to marketing posts.

insert into storage.buckets (id, name, public)
values ('marketing-visuals', 'marketing-visuals', true)
on conflict (id) do nothing;

-- Members of the workspace owning the project can upload/read.
create policy "marketing-visuals upload"
  on storage.objects for insert
  with check (
    bucket_id = 'marketing-visuals'
    and auth.role() = 'authenticated'
  );

create policy "marketing-visuals select"
  on storage.objects for select
  using (bucket_id = 'marketing-visuals');

create policy "marketing-visuals update"
  on storage.objects for update
  using (
    bucket_id = 'marketing-visuals'
    and auth.role() = 'authenticated'
  );

create policy "marketing-visuals delete"
  on storage.objects for delete
  using (
    bucket_id = 'marketing-visuals'
    and auth.role() = 'authenticated'
  );
