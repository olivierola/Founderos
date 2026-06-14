-- Allow the E2E test agent to emit a structured run "report" as a timeline
-- step (rendered as an openable artifact card in the chat).
alter table public.test_run_steps drop constraint if exists test_run_steps_kind_check;
alter table public.test_run_steps add constraint test_run_steps_kind_check check (kind in (
  'plan','navigate','click','fill','select','scroll','press','wait',
  'assert','screenshot','dom_snapshot','ask_user','user_answer','thought',
  'say','report','pass','fail','error','info'
));
