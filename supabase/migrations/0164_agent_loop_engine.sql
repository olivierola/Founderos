-- 0164_agent_loop_engine.sql
-- LOOP ENGINEERING — the agent loop becomes an explicit, verifiable, auditable
-- control system instead of a set of ad-hoc branches inside the tick handler.
--
-- Three things move from "implicit in the prompt" to "durable state":
--   1. contract  — the run's SUCCESS CONTRACT: a list of typed, mostly
--                  DETERMINISTIC checks (a deliverable exists, a URL answers,
--                  the checklist is closed…) derived from the plan's done_when,
--                  the mission's acceptance criteria and its expected
--                  deliverables. The LLM judge is now the LAST resort, not the
--                  only verifier — and chat runs get verified too.
--   2. progress  — a per-tick progress fingerprint (steps closed, deliverables
--                  produced, distinct tool signatures). Comparing fingerprints
--                  detects STAGNATION: an agent churning with varied arguments
--                  and producing nothing, which the identical-signature loop
--                  guard never caught.
--   3. stagnation/iteration — the counters the controller reads to decide
--                  continue / replan / finalize / abort.
--
-- Plus a 'loop' run event so every controller decision (what it saw, what it
-- decided, why) is traceable in the live timeline — the "auditable" half of the
-- loop-engineering promise.

-- ── 1. Durable loop state ────────────────────────────────────────────────────
alter table public.internal_agent_run_state
  -- SuccessContract: { goal, source, checks: [{ id, kind, label, args, required }], derived_at }
  add column if not exists contract   jsonb,
  -- Last progress fingerprint: { todos_done, todos_total, deliverables, tool_sigs, hash }
  add column if not exists progress   jsonb,
  -- Consecutive ticks that produced NO measurable progress.
  add column if not exists stagnation int not null default 0,
  -- Controller iterations (ticks) executed for this run.
  add column if not exists iteration  int not null default 0;

comment on column public.internal_agent_run_state.contract is
  'Loop engineering: typed success checks the run is verified against before it may finish.';
comment on column public.internal_agent_run_state.progress is
  'Loop engineering: last tick progress fingerprint, compared tick-over-tick to detect stagnation.';

-- ── 2. Event kind 'loop' (controller decisions + contract verdicts) ──────────
-- Keeps every kind allowed so far ('ui' came with 0129) and adds the browser_*
-- kinds the runner tools already emit — they were silently rejected by this
-- constraint, so those events never landed.
alter table public.internal_agent_run_events
  drop constraint if exists internal_agent_run_events_kind_check;
alter table public.internal_agent_run_events
  add constraint internal_agent_run_events_kind_check
  check (kind in (
    'llm_call','tool_call','tool_result','status','log','error',
    'plan','plan_step','tool_error','question','todos','ui',
    'browser_navigate','browser_action','browser_screenshot',
    'loop'
  ));
