-- Allow the E2E test agent to record a "hover" step (used to reveal hover-gated
-- controls like dropdowns / row actions before clicking them).
alter table public.test_run_steps drop constraint if exists test_run_steps_kind_check;
alter table public.test_run_steps add constraint test_run_steps_kind_check check (kind in (
  'plan','navigate','click','fill','select','scroll','press','hover','wait',
  'assert','screenshot','dom_snapshot','ask_user','user_answer','thought',
  'say','report','pass','fail','error','info'
));
