-- RAG Agents module: agents, knowledge sources, vector chunks, conversations.
-- Embeddings are produced by Jina (jina-embeddings-v3 → 1024 dims) and searched
-- with pgvector cosine similarity.

create extension if not exists vector;

-- Capture the app's UI structure (routes/pages/interactive elements) on scan.
alter table public.scan_results add column if not exists app_structure jsonb default '{}'::jsonb;

create table if not exists public.rag_agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  name text not null,
  description text,
  persona text,                              -- system persona / role
  instructions text,                         -- extra system instructions
  model text default 'groq',                 -- groq | deepseek
  temperature numeric default 0.3,
  welcome_message text default 'Hi! How can I help you today?',
  widget_config jsonb default '{}'::jsonb,    -- color, position, title…
  public_key text unique default replace(gen_random_uuid()::text, '-', ''),
  enabled boolean default true,
  onboarding_enabled boolean default false,   -- use SaaS structure for guided onboarding
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.rag_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  agent_id uuid references public.rag_agents(id) on delete cascade,
  type text not null check (type in ('text','url','document','saas_structure')),
  title text not null,
  source_ref text,                           -- url or file name
  status text default 'pending' check (status in ('pending','processing','ready','failed')),
  chunk_count int default 0,
  error_message text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists public.rag_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  agent_id uuid references public.rag_agents(id) on delete cascade,
  source_id uuid references public.rag_sources(id) on delete cascade,
  content text not null,
  embedding vector(1024),
  token_estimate int default 0,
  created_at timestamptz default now()
);

create table if not exists public.rag_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  agent_id uuid references public.rag_agents(id) on delete cascade,
  visitor_id text,                           -- anonymous widget visitor
  source text default 'playground',          -- playground | widget
  rating int,                                -- optional satisfaction 1..5
  created_at timestamptz default now()
);

create table if not exists public.rag_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.rag_conversations(id) on delete cascade,
  agent_id uuid references public.rag_agents(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  sources jsonb default '[]'::jsonb,         -- chunk refs used to answer
  created_at timestamptz default now()
);

-- RLS: members read; members (owner/admin/member) manage.
do $$
declare t text;
begin
  foreach t in array array['rag_agents','rag_sources','rag_chunks','rag_conversations','rag_messages']
  loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- Agents / sources / chunks / conversations are workspace-scoped.
do $$
declare t text;
begin
  foreach t in array array['rag_agents','rag_sources','rag_chunks','rag_conversations']
  loop
    execute format($f$
      create policy "Members read %1$s"
      on public.%1$s for select
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()));
    $f$, t);
    execute format($f$
      create policy "Members manage %1$s"
      on public.%1$s for all
      using (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
          and wm.role in ('owner','admin','member')))
      with check (exists (select 1 from public.workspace_members wm
        where wm.workspace_id = %1$s.workspace_id and wm.user_id = auth.uid()
          and wm.role in ('owner','admin','member')));
    $f$, t);
  end loop;
end $$;

-- Messages: readable when the parent conversation is in a workspace the user belongs to.
create policy "Members read rag_messages"
on public.rag_messages for select
using (exists (
  select 1 from public.rag_conversations c
  join public.workspace_members wm on wm.workspace_id = c.workspace_id
  where c.id = rag_messages.conversation_id and wm.user_id = auth.uid()
));

create index if not exists idx_rag_agents_project on public.rag_agents(project_id);
create index if not exists idx_rag_sources_agent on public.rag_sources(agent_id);
create index if not exists idx_rag_chunks_agent on public.rag_chunks(agent_id);
create index if not exists idx_rag_conversations_agent on public.rag_conversations(agent_id, created_at desc);
create index if not exists idx_rag_messages_conv on public.rag_messages(conversation_id, created_at);

-- Cosine similarity index for vector search.
create index if not exists idx_rag_chunks_embedding
  on public.rag_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Similarity search function (SECURITY DEFINER so edge functions can call it with service role).
create or replace function public.match_rag_chunks(
  p_agent_id uuid,
  p_query_embedding vector(1024),
  p_match_count int default 6
)
returns table (id uuid, content text, source_id uuid, similarity float)
language sql stable
as $$
  select c.id, c.content, c.source_id,
         1 - (c.embedding <=> p_query_embedding) as similarity
  from public.rag_chunks c
  where c.agent_id = p_agent_id and c.embedding is not null
  order by c.embedding <=> p_query_embedding
  limit p_match_count;
$$;
