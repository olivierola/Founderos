-- 0183_aiops_cloud_providers.sql
-- Extend the AI Ops infra beyond RunPod to OVHcloud (real Public Cloud API) and
-- AWS (catalogue + simulated provisioning):
--   • aiops_providers.kind gains 'ovh' and 'aws' — the edge function dispatches
--     provider.test / server.rent / server.sync on this value.
--   • aiops_servers.source gains 'ovh' / 'aws' so rented instances are labelled
--     like RunPod pods are (badges, detail sheet, cost accounting).
-- The checks are re-created with the widened value lists; existing rows
-- ('seed' / 'runpod' / 'cloud') stay valid.

alter table public.aiops_servers
  drop constraint if exists aiops_servers_source_check;

alter table public.aiops_servers
  add constraint aiops_servers_source_check check (source in ('seed','runpod','cloud','ovh','aws'));

alter table public.aiops_providers
  drop constraint if exists aiops_providers_kind_check;

alter table public.aiops_providers
  add constraint aiops_providers_kind_check check (kind in ('cloud_endpoint','runpod','ovh','aws'));
