-- 0290_schema_reconciliation.sql
-- Ce que l'instance SaaS a reçu hors migration, rattrapé pour qu'une base
-- neuve (on-prem, backend auto-hébergé) soit identique à elle.
--
-- Relevé du 2026-11-04 : base reconstruite depuis les migrations comparée au
-- schéma public de l'instance (description OpenAPI de PostgREST) — 380 tables
-- et vues des deux côtés, une colonne manquante. Sur l'instance SaaS, tout ceci
-- est sans effet (`if not exists`).
--
-- Pour refaire le relevé : backend/src/platform/schema-drift.ts.

alter table public.crm_objects add column if not exists hidden_in_sidebar boolean not null default false;
