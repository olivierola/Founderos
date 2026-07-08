-- 0109_aiops_real_training.sql
-- Closes the last simulated loop: real fine-tuning on a rented RunPod GPU pod.
-- A job with runtime='runpod' launches an axolotl (QLoRA) pod that downloads the
-- dataset (Supabase Storage signed URL), trains, and streams progress/loss back
-- to the aiops-infra webhook (authenticated by a per-job report_token). Jobs
-- with runtime='sim' keep the client-side ticker.

-- ── Dataset file storage (the upload now keeps the actual .jsonl) ─────────────
insert into storage.buckets (id, name, public)
values ('ft-datasets', 'ft-datasets', false)
on conflict (id) do nothing;

drop policy if exists "aiops ft-datasets members" on storage.objects;
create policy "aiops ft-datasets members" on storage.objects for all to authenticated
  using (bucket_id = 'ft-datasets')
  with check (bucket_id = 'ft-datasets');

alter table public.aiops_ft_datasets
  add column if not exists storage_path text;

-- ── Real-training bookkeeping on jobs ────────────────────────────────────────
alter table public.aiops_ft_jobs
  add column if not exists runtime text not null default 'sim' check (runtime in ('sim','runpod')),
  add column if not exists provider_id uuid references public.aiops_providers(id) on delete set null,
  add column if not exists pod_id text,
  add column if not exists report_token text,
  add column if not exists hf_repo text,
  add column if not exists logs jsonb not null default '[]'::jsonb,
  add column if not exists error text;
create index if not exists idx_aiops_ft_jobs_report_token on public.aiops_ft_jobs(report_token) where report_token is not null;

-- ── Optional second secret on a provider: a Hugging Face token (for gated
--    weights like Llama/Gemma). Encrypted like the API key; never exposed. ────
alter table public.aiops_providers
  add column if not exists secret2_ciphertext text,
  add column if not exists secret2_iv text;
