-- 0117_aiops_purge_seed.sql
-- The AI Ops & Governance tables used to be auto-seeded with deterministic
-- SAMPLE/MOCK rows on first project open. That seeding has been removed (the
-- module now shows real data only), but rows seeded in earlier sessions still
-- linger in the DB. This one-off cleanup deletes them so the module starts from
-- a clean, real-data-only slate. Tables repopulate solely from real user actions
-- (create a job, upload a dataset, provision a RunPod server, deploy, …).
--
-- Ordered child → parent to respect FKs. aiops_ft_settings (real user settings)
-- is intentionally left untouched.
delete from public.aiops_ft_endpoints;
delete from public.aiops_ft_evals;
delete from public.aiops_ft_experiments;
delete from public.aiops_ft_versions;
delete from public.aiops_ft_jobs;
delete from public.aiops_ft_label_tasks;
delete from public.aiops_ft_datasets;
delete from public.aiops_model_state;
delete from public.aiops_agent_deployments;
delete from public.aiops_infra_incidents;
delete from public.aiops_servers;
delete from public.aiops_guardrails;
delete from public.aiops_alert_rules;
delete from public.aiops_ft_roles;
