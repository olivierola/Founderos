-- Allow the E2E test agent to emit a natural-language message ("say") as a
-- timeline step, in addition to its browser actions and questions.
alter table public.test_run_steps drop constraint if exists test_run_steps_kind_check;
alter table public.test_run_steps add constraint test_run_steps_kind_check check (kind in (
  'plan','navigate','click','fill','select','scroll','press','wait',
  'assert','screenshot','dom_snapshot','ask_user','user_answer','thought',
  'say','pass','fail','error','info'
));
