-- AI assistant artifacts + tool-call trace.
--
-- The assistant (ai-agent-chat) now runs a tool-calling loop. When it produces
-- a concrete output — a document, a JSON payload, a table/CSV, a code block —
-- it persists it as an "artifact" attached to the assistant message. The chat
-- UI renders these as cards (open in canvas, download, copy).
--
-- We also record the tool calls it made on the message metadata for
-- transparency / debugging (no separate table needed for v1).

create table if not exists public.ai_artifacts (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.ai_conversations(id) on delete cascade,
  message_id uuid references public.ai_messages(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  -- Artifact kind drives how the UI renders it.
  --   document  → markdown, opens in the document canvas
  --   json      → pretty-printed JSON payload
  --   table     → { columns: string[], rows: (string|number)[][] } rendered as a grid + CSV export
  --   code      → fenced code with a language tag
  --   csv       → raw CSV text, downloadable
  kind text not null check (kind in ('document','json','table','code','csv')),
  title text not null default 'Artifact',
  -- For document/code/csv: the textual content. For json/table: see `data`.
  content text,
  -- For json/table: structured payload.
  data jsonb,
  -- Code language (when kind = 'code'), or file extension hint.
  language text,
  created_at timestamptz default now()
);

alter table public.ai_artifacts enable row level security;

-- Read: any workspace member who can see the parent conversation.
drop policy if exists "Members read ai_artifacts" on public.ai_artifacts;
create policy "Members read ai_artifacts"
on public.ai_artifacts for select
using (
  exists (
    select 1 from public.ai_conversations c
    join public.workspace_members wm on wm.workspace_id = c.workspace_id
    where c.id = ai_artifacts.conversation_id and wm.user_id = auth.uid()
  )
);

-- Writes happen via the service-role edge function, which bypasses RLS. We add
-- a permissive insert policy guarded by membership so authenticated clients
-- could also attach artifacts in the future if needed.
drop policy if exists "Members insert ai_artifacts" on public.ai_artifacts;
create policy "Members insert ai_artifacts"
on public.ai_artifacts for insert
with check (
  exists (
    select 1 from public.ai_conversations c
    join public.workspace_members wm on wm.workspace_id = c.workspace_id
    where c.id = ai_artifacts.conversation_id and wm.user_id = auth.uid()
  )
);

create index if not exists idx_ai_artifacts_message on public.ai_artifacts(message_id);
create index if not exists idx_ai_artifacts_conversation on public.ai_artifacts(conversation_id, created_at);
