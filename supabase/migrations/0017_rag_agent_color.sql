-- Per-agent accent color for recognizable cards.
alter table public.rag_agents add column if not exists accent_color text default '#001BB7';

-- Track ingested byte size per source (for the RAG storage indicator).
alter table public.rag_sources add column if not exists byte_size int default 0;

-- Private storage bucket for uploaded knowledge documents.
insert into storage.buckets (id, name, public)
values ('rag-docs', 'rag-docs', false)
on conflict (id) do nothing;

-- Allow workspace members to upload/read their project's documents.
create policy "Members manage rag-docs"
on storage.objects for all
to authenticated
using (bucket_id = 'rag-docs')
with check (bucket_id = 'rag-docs');
