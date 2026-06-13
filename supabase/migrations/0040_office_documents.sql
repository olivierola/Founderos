-- Office module: documents, spreadsheets and presentations created by project
-- members. A single polymorphic table holds all three kinds; the `content`
-- jsonb shape depends on `kind`:
--   document     → Plate/Slate value: { nodes: [...] }  (rich text)
--   spreadsheet  → { columns: string[], rows: (string|number|null)[][] }
--   presentation → { slides: [{ title, body, layout, notes }] }
--
-- AI assistance (completion, knowledge-base search, section generation) operates
-- on this content via the office-ai edge function; nothing extra is stored here.

create table if not exists public.office_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  kind text not null check (kind in ('document','spreadsheet','presentation')),
  title text not null default 'Untitled',
  -- Polymorphic content payload (see header).
  content jsonb not null default '{}'::jsonb,
  -- Lightweight derived plain-text used for search + AI grounding previews.
  preview_text text,
  -- Soft taxonomy.
  emoji text default '📄',
  tags text[] not null default '{}'::text[],
  is_archived boolean not null default false,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.office_documents enable row level security;

-- Access: any member of the owning workspace. Mirrors the marketing/ai patterns.
drop policy if exists "Office: members read" on public.office_documents;
create policy "Office: members read"
on public.office_documents for select
using (
  exists (select 1 from public.workspace_members wm
          where wm.workspace_id = office_documents.workspace_id and wm.user_id = auth.uid())
);

drop policy if exists "Office: members insert" on public.office_documents;
create policy "Office: members insert"
on public.office_documents for insert
with check (
  created_by = auth.uid()
  and exists (select 1 from public.workspace_members wm
              where wm.workspace_id = office_documents.workspace_id and wm.user_id = auth.uid())
);

drop policy if exists "Office: members update" on public.office_documents;
create policy "Office: members update"
on public.office_documents for update
using (
  exists (select 1 from public.workspace_members wm
          where wm.workspace_id = office_documents.workspace_id and wm.user_id = auth.uid())
)
with check (
  exists (select 1 from public.workspace_members wm
          where wm.workspace_id = office_documents.workspace_id and wm.user_id = auth.uid())
);

drop policy if exists "Office: members delete" on public.office_documents;
create policy "Office: members delete"
on public.office_documents for delete
using (
  exists (select 1 from public.workspace_members wm
          where wm.workspace_id = office_documents.workspace_id and wm.user_id = auth.uid())
);

create index if not exists idx_office_documents_project
  on public.office_documents(project_id, kind, updated_at desc);
create index if not exists idx_office_documents_creator
  on public.office_documents(created_by);
