-- 0089 · Agent Skills: pluggable capability bundles for autonomous agents.
-- A skill = system prompt extension + required tools + execution pattern.

create table if not exists public.agent_skills (
  id          uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  name        text not null,
  slug        text not null,
  description text,
  category    text,
  icon        text default 'Zap',
  system_prompt_extension text,
  required_tools text[] not null default '{}',
  config      jsonb not null default '{}',
  is_system   boolean not null default false,
  created_at  timestamptz not null default now()
);

create unique index if not exists idx_agent_skills_slug
  on public.agent_skills(workspace_id, slug);

create table if not exists public.agent_skill_activations (
  agent_id    uuid not null references public.internal_agents(id) on delete cascade,
  skill_id    uuid not null references public.agent_skills(id) on delete cascade,
  activated_at timestamptz not null default now(),
  primary key (agent_id, skill_id)
);

alter table public.agent_skills enable row level security;
alter table public.agent_skill_activations enable row level security;

create policy "members manage agent_skills" on public.agent_skills for all
  using  (workspace_id is null or exists (select 1 from public.workspace_members wm where wm.workspace_id = agent_skills.workspace_id and wm.user_id = auth.uid()))
  with check (workspace_id is null or exists (select 1 from public.workspace_members wm where wm.workspace_id = agent_skills.workspace_id and wm.user_id = auth.uid()));

create policy "members manage skill_activations" on public.agent_skill_activations for all
  using  (exists (select 1 from public.internal_agents a join public.workspace_members wm on wm.workspace_id = a.workspace_id where a.id = agent_skill_activations.agent_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.internal_agents a join public.workspace_members wm on wm.workspace_id = a.workspace_id where a.id = agent_skill_activations.agent_id and wm.user_id = auth.uid()));

-- Seed system skills (workspace_id = null → available to all workspaces)
insert into public.agent_skills (workspace_id, name, slug, description, category, icon, system_prompt_extension, required_tools, is_system) values
  (null, 'Web Researcher', 'web-researcher',
   'Deep web research — searches multiple sources, reads articles, produces structured briefs with citations.',
   'research', 'Search',
   E'You are an expert researcher. When given a research task:\n1. Search the web with multiple query variations\n2. Read the most relevant sources in full\n3. Cross-reference facts across sources\n4. Produce a structured brief with: summary, key findings, sources cited, confidence level\nAlways cite your sources with URLs. Never invent facts.',
   '{web_search,web_fetch,deep_research}', true),

  (null, 'Browser Navigator', 'browser-navigator',
   'Navigate and interact with real web pages — fill forms, click buttons, extract data, take screenshots.',
   'browser', 'Globe',
   E'You can navigate real web pages using browse_web. Rules:\n1. Use numbered refs from DOM snapshots to target elements (preferred over CSS selectors)\n2. Check element state (value, disabled) in snapshot before acting\n3. Take screenshots as evidence of what you see\n4. Never loop on the same action — if it fails, try a different approach or report the issue\n5. For hover-revealed items: hover first, then read the new snapshot\n6. evaluate() is gated by approval — use it only when no other action works',
   '{browse_web}', true),

  (null, 'Code Analyst', 'code-analyst',
   'Analyze codebases — read files, understand architecture, find bugs, suggest improvements.',
   'code', 'Code2',
   E'You analyze code and software architecture. You can:\n1. Read source files and documentation\n2. Trace execution flows across files\n3. Identify bugs, security issues, and tech debt\n4. Suggest refactoring with specific code examples\nAlways reference file paths and line numbers in your analysis.',
   '{web_fetch,db_read}', true),

  (null, 'Data Analyst', 'data-analyst',
   'Analyze data from databases — write queries, compute metrics, produce reports with KPIs.',
   'data', 'BarChart3',
   E'You are a data analyst. You can:\n1. Query databases to extract data\n2. Compute KPIs, aggregates, and trends\n3. Research industry benchmarks for context\n4. Produce structured reports with: executive summary, key metrics, trends, recommendations\nAlways validate data before drawing conclusions.',
   '{db_read,deep_research}', true),

  (null, 'Content Writer', 'content-writer',
   'Write professional content — articles, reports, documentation, emails. Research before writing.',
   'communication', 'FileText',
   E'You are a professional content writer. Your process:\n1. Research the topic thoroughly before writing\n2. Outline the structure first\n3. Write clear, concise prose with proper formatting (headers, bullets, emphasis)\n4. Include data points and citations when relevant\n5. End with actionable recommendations or next steps',
   '{web_search,deep_research}', true),

  (null, 'Security Auditor', 'security-auditor',
   'Audit security posture — check vulnerabilities, misconfigurations, compliance gaps.',
   'security', 'Shield',
   E'You are a security auditor. Your methodology:\n1. Identify the attack surface (web, infrastructure, code)\n2. Check for common vulnerabilities (OWASP Top 10, CIS benchmarks)\n3. Assess compliance against relevant frameworks (SOC2, ISO27001, GDPR)\n4. Produce findings with: severity (critical/high/medium/low), evidence, remediation steps\n5. Prioritize by risk = likelihood × impact',
   '{web_search,browse_web,deep_research}', true),

  (null, 'Recruiter', 'recruiter',
   'Source and screen candidates — search job boards, evaluate profiles, manage pipeline.',
   'hr', 'Users',
   E'You are a talent acquisition specialist. You can:\n1. Search the web for candidates matching job requirements\n2. Navigate job boards and professional networks\n3. Evaluate profiles against role criteria\n4. Produce structured candidate briefs with: fit score, strengths, concerns, recommended next steps\nRespect privacy — only use publicly available information.',
   '{web_search,browse_web,connector_action}', true)

on conflict do nothing;
