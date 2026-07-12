-- 0115_onboarding_voice.sql
-- Optional voice for the live onboarding agent (Deepgram). The founder enables
-- it per public agent; the end user still opts in from the widget (the widget
-- passes voice:true and captures mic input). Guidance is spoken via Deepgram
-- Aura TTS and the user's speech transcribed via Deepgram STT.
alter table public.rag_agents
  add column if not exists onboarding_voice_enabled boolean not null default false,
  add column if not exists onboarding_voice_model text not null default 'aura-asteria-en';
