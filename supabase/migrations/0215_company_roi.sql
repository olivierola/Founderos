-- 0215_company_roi.sql
-- Le ROI de la workforce — le côté VALEUR, en face du côté coût qui existe déjà.
--
-- Le produit sait déjà tout dire sur ce que l'IA COÛTE : usage_ledger, llm_usage,
-- cost_records, metering.ts, la facturation en crédits (0194) et le webhook
-- Stripe (0200). Il ne sait rien dire sur ce qu'elle RAPPORTE. Un dirigeant qui
-- ouvre le produit lit « 1 843 runs d'agents » — une mesure d'activité, pas une
-- mesure de valeur. C'est exactement la phrase qu'on ne peut pas défendre en
-- renouvellement.
--
-- Le parti pris ici est de ne PAS inventer une valeur automatique. On ne sait
-- pas ce que vaut un livrable ; l'entreprise, elle, le sait. Donc :
--
--   • L'ENTREPRISE POSE LES HYPOTHÈSES (company_value_rules) : « un rapport
--     produit par le service Finance nous économise 90 minutes », « un
--     livrable de l'agent SDR influence 400 € de pipeline ». Une règle, une
--     hypothèse, assumée et modifiable.
--   • LE PRODUIT COMPTE (company_value_events) : il apparie chaque livrable
--     réel à la règle la plus spécifique qui le concerne et fait la
--     multiplication. Rien de plus.
--
-- La conséquence est volontaire : le chiffre affiché est traçable jusqu'à la
-- règle qui l'a produit et jusqu'au livrable qui l'a déclenché. Un ROI qu'on
-- ne peut pas ouvrir est un ROI que personne ne croit.
--
-- Pourquoi les euros du coût passent par un taux réglable plutôt que par le
-- COGS réel : usage_ledger contient le coût fournisseur et n'a AUCUNE policy
-- RLS (c'est délibéré, 0194). Le client lit workspace_usage_ledger, qui expose
-- les crédits sans un euro de COGS. La conversion crédit → euro est donc une
-- hypothèse explicite de plus, posée à côté du taux horaire.

-- ── Les hypothèses de valorisation ──────────────────────────────────────────
create table if not exists public.company_roi_settings (
  project_id             uuid primary key references public.projects(id) on delete cascade,
  workspace_id           uuid not null references public.workspaces(id) on delete cascade,
  -- Coût horaire chargé de la personne qui aurait fait le travail. Sert de
  -- défaut à toute règle qui n'en fixe pas un.
  default_hourly_rate_eur numeric(10,2) not null default 45,
  -- Ce que coûte un crédit à l'entreprise. Défaut = prix catalogue du
  -- dépassement (1 500 micro-euros, cf. billing_plans), pas le COGS.
  credit_price_eur       numeric(12,6) not null default 0.0015,
  -- Devise d'affichage. Le calcul reste en euros ; ce champ dit seulement
  -- comment l'écran l'étiquette.
  currency               text not null default 'eur',
  updated_at             timestamptz not null default now(),
  updated_by             uuid references auth.users(id)
);

create table if not exists public.company_value_rules (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  project_id    uuid not null references public.projects(id) on delete cascade,
  label         text not null,

  -- À quoi la règle s'applique. Quatre portées, de la plus spécifique à la
  -- plus générale — l'appariement prend TOUJOURS la plus spécifique qui
  -- matche, jamais la somme des deux.
  --   agent            → match_value = un internal_agents.id
  --   service          → match_value = un service_dashboards.id
  --   deliverable_kind → match_value = internal_agent_deliverables.kind
  --   default          → match_value ignoré : le filet de sécurité du projet
  scope         text not null default 'default'
                  check (scope in ('agent','service','deliverable_kind','default')),
  match_value   text,

  -- La valeur d'UNE occurrence, dans les deux monnaies qui parlent à un
  -- dirigeant : du temps humain repris, et du revenu influencé.
  minutes_saved          numeric(10,2) not null default 0,
  -- NULL → on retombe sur company_roi_settings.default_hourly_rate_eur.
  hourly_rate_eur        numeric(10,2),
  revenue_influenced_eur numeric(14,2) not null default 0,

  active        boolean not null default true,
  note          text,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_company_value_rules_project
  on public.company_value_rules(project_id, scope) where active;
-- Une seule règle active par cible : deux règles qui matchent la même chose
-- rendraient le chiffre indéfendable (laquelle a compté ?).
create unique index if not exists uq_company_value_rules_target
  on public.company_value_rules(project_id, scope, (coalesce(match_value, '')))
  where active;

comment on table public.company_value_rules is
  'Hypothèses de valorisation posées par l''entreprise : ce que vaut une occurrence de travail. Le produit ne les devine pas, il les applique.';

alter table public.company_roi_settings enable row level security;
alter table public.company_value_rules  enable row level security;

drop policy if exists "members manage company_roi_settings" on public.company_roi_settings;
create policy "members manage company_roi_settings" on public.company_roi_settings for all
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = company_roi_settings.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = company_roi_settings.workspace_id and wm.user_id = auth.uid()));

drop policy if exists "members manage company_value_rules" on public.company_value_rules;
create policy "members manage company_value_rules" on public.company_value_rules for all
  using (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = company_value_rules.workspace_id and wm.user_id = auth.uid()))
  with check (exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = company_value_rules.workspace_id and wm.user_id = auth.uid()));

-- ── L'appariement : un livrable, une règle, une valeur ──────────────────────
-- `distinct on` + un ordre de spécificité : chaque livrable ne compte qu'UNE
-- fois, via la règle la plus précise qui le concerne. Un livrable qu'aucune
-- règle ne couvre sort quand même de la vue, avec une valeur nulle et
-- rule_id NULL — c'est ainsi qu'on voit ce qui n'est pas encore valorisé au
-- lieu de le faire disparaître.
create or replace view public.company_value_events
  with (security_invoker = on) as
select distinct on (dl.id)
  coalesce(r.project_id, m.project_id, ag.project_id)      as project_id,
  dl.id                                                    as deliverable_id,
  dl.name                                                  as deliverable_name,
  dl.kind                                                  as deliverable_kind,
  dl.created_at                                            as occurred_at,
  dl.agent_id,
  ag.name                                                  as agent_name,
  ag.service_dashboard_id                                  as dashboard_id,
  vr.id                                                    as rule_id,
  vr.label                                                 as rule_label,
  vr.scope                                                 as rule_scope,
  coalesce(vr.minutes_saved, 0)                            as minutes_saved,
  -- Temps repris × taux horaire de la règle, à défaut celui du projet, à
  -- défaut 45 €/h : la chaîne de repli est explicite pour qu'un chiffre ne
  -- puisse jamais venir d'un NULL silencieux.
  round(
    coalesce(vr.minutes_saved, 0) / 60.0
      * coalesce(vr.hourly_rate_eur, st.default_hourly_rate_eur, 45)
  , 2)                                                     as hours_value_eur,
  coalesce(vr.revenue_influenced_eur, 0)                   as revenue_influenced_eur,
  round(
    coalesce(vr.minutes_saved, 0) / 60.0
      * coalesce(vr.hourly_rate_eur, st.default_hourly_rate_eur, 45)
    + coalesce(vr.revenue_influenced_eur, 0)
  , 2)                                                     as value_eur
from public.internal_agent_deliverables dl
left join public.internal_agent_runs      r  on r.id  = dl.run_id
left join public.internal_agent_missions  m  on m.id  = dl.mission_id
left join public.internal_agents          ag on ag.id = dl.agent_id
left join public.company_roi_settings     st on st.project_id = coalesce(r.project_id, m.project_id, ag.project_id)
left join public.company_value_rules      vr
       on vr.project_id = coalesce(r.project_id, m.project_id, ag.project_id)
      and vr.active
      and (
        (vr.scope = 'agent'            and vr.match_value = dl.agent_id::text)
     or (vr.scope = 'service'          and vr.match_value = ag.service_dashboard_id::text)
     or (vr.scope = 'deliverable_kind' and vr.match_value = dl.kind)
     or (vr.scope = 'default')
      )
where coalesce(r.project_id, m.project_id, ag.project_id) is not null
order by dl.id,
  case vr.scope
    when 'agent' then 1 when 'service' then 2
    when 'deliverable_kind' then 3 when 'default' then 4 else 5 end;

grant select on public.company_value_events to authenticated;

comment on view public.company_value_events is
  'Un livrable = un événement de valeur, apparié à la règle la plus spécifique. rule_id NULL = production non encore valorisée.';

-- ── La dépense IA, côté client ──────────────────────────────────────────────
-- Basée sur workspace_usage_ledger (crédits, sans COGS) et non sur
-- usage_ledger : le coût fournisseur ne sort pas d'ici, jamais.
create or replace view public.company_ai_spend_daily
  with (security_invoker = on) as
select
  l.project_id,
  date_trunc('day', l.occurred_at)::date            as day,
  sum(l.billed_credits)                             as credits,
  round(sum(l.billed_credits)
        * coalesce(max(st.credit_price_eur), 0.0015), 2) as spend_eur
from public.workspace_usage_ledger l
left join public.company_roi_settings st on st.project_id = l.project_id
where l.project_id is not null and l.billable
group by l.project_id, date_trunc('day', l.occurred_at)::date;

grant select on public.company_ai_spend_daily to authenticated;

comment on view public.company_ai_spend_daily is
  'Dépense IA par jour, en crédits et en euros au taux posé dans company_roi_settings. Aucun coût fournisseur.';

-- ── Amorce : un ROI vide ne se remplit jamais non plus ──────────────────────
-- Des réglages par défaut et une règle filet par projet, pour que l'écran
-- affiche un chiffre dès la première ouverture. Ce sont des HYPOTHÈSES, et
-- l'écran le dit — 30 minutes reprises par livrable est délibérément prudent.
insert into public.company_roi_settings (project_id, workspace_id)
select p.id, p.workspace_id from public.projects p
 where p.workspace_id is not null
on conflict (project_id) do nothing;

insert into public.company_value_rules (workspace_id, project_id, label, scope, minutes_saved, note)
select p.workspace_id, p.id,
       'Livrable produit par un agent', 'default', 30,
       'Hypothèse de départ : un livrable reprend en moyenne 30 minutes de travail humain. À ajuster.'
  from public.projects p
 where p.workspace_id is not null
   and not exists (
     select 1 from public.company_value_rules vr
      where vr.project_id = p.id and vr.scope = 'default' and vr.active
   );
