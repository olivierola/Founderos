-- 0181_ai_guardrails_runtime.sql
-- Runtime enforcement of aiops_guardrails inside the agent engine.
--
-- A guardrail becomes machine-applicable when it carries a `match_pattern`
-- (a regex tested against real traffic). `match_scope` says WHERE the pattern is
-- tested: the user's prompt, the agent's tool calls (name + arguments), or the
-- tool results coming back. `all` tests every surface. Guardrails WITHOUT a
-- pattern stay documentation-only policy statements (title/body markdown) — the
-- previous behaviour, untouched.
--
-- Enforcement is unchanged (block / warn / log), decided at the point of match:
--   - block      → the offending tool call is never executed (an error result is
--                  returned to the model); a prompt-scope block fails the run.
--   - warn / log → recorded on the run timeline as a `guardrail` event.
--
-- Every match (any enforcement) is a `guardrail` run event — the Security tab
-- and Prompt Monitoring surface those without extra plumbing.

-- ── 1. Machine-matchable guardrail fields ─────────────────────────────────────
alter table public.aiops_guardrails
  add column if not exists match_pattern text,
  add column if not exists match_scope text not null default 'all'
    check (match_scope in ('prompt','tool_call','tool_result','all'));

comment on column public.aiops_guardrails.match_pattern is
  'Regex testé en runtime contre le trafic (prompt / appels d''outils / résultats). Vide = guardrail documentaire uniquement.';
comment on column public.aiops_guardrails.match_scope is
  'Surface de test: prompt (consignes utilisateur), tool_call (nom + arguments), tool_result (sorties), all (tout).';

-- ── 2. `guardrail` run-event kind ─────────────────────────────────────────────
-- Extends the append-only internal_agent_run_events kinds so guardrail hits are
-- visible on the run timeline and streamable to the Security / Monitoring tabs.
alter table public.internal_agent_run_events
  drop constraint if exists internal_agent_run_events_kind_check;
alter table public.internal_agent_run_events
  add constraint internal_agent_run_events_kind_check
  check (kind in (
    'llm_call','tool_call','tool_result','status','log','error',
    'plan','plan_step','tool_error','question','todos','ui',
    'browser_navigate','browser_action','browser_screenshot',
    'loop','prompt','route','guardrail'
  ));

-- ── 3. Prompt Monitoring joins runs to their usage by metadata->>run_id ───────
-- btree on the extracted text expression (NOT GIN — the UI filters with `->>`).
create index if not exists idx_llm_usage_run_id on public.llm_usage ((metadata ->> 'run_id'));
create index if not exists idx_llm_usage_created on public.llm_usage(created_at desc);
