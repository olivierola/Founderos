-- 0182_aiops_pod_deploy.sql
-- RunPod pod deployment depth (migration 0180's real infra follow-up):
--   1. Multi-GPU pods (tensor parallelism) for 70B-class models.
--   2. Community cloud (cheaper, non-guaranteed instances).
--   3. Quantization (AWQ / GPTQ / FP8) to fit bigger models on smaller VRAM.
--   4. max_model_len + the exact docker image used, for ops legibility.
-- All defaulted so existing rows (and the client-side seed) keep working.

alter table public.aiops_servers
  add column if not exists gpu_count int not null default 1,
  add column if not exists cloud_type text not null default 'secure'
    check (cloud_type in ('secure','community')),
  add column if not exists quantization text,
  add column if not exists max_model_len int,
  add column if not exists docker_image text;
