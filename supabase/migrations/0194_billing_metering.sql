-- 0194_billing_metering.sql
-- Limitation d'usage + pricing, adossés à UNE unité interne : le « crédit ».
--
-- POURQUOI UNE UNITÉ UNIQUE
-- Le coût réel du produit n'est pas un nombre de requêtes : c'est la dépense
-- token chez DeepSeek, Jina, et demain OpenAI/Anthropic/fal. Facturer « 25 000
-- requêtes » laisse la marge dériver dès qu'un agent boucle 40 tours sur un
-- modèle reasoner. On mesure donc le COÛT FOURNISSEUR réel de chaque appel et on
-- le convertit en crédits à taux fixe :
--
--   1 crédit  =  200 micro-€ de coût fournisseur absorbé   (credit_cogs_micro_eur)
--   1 crédit  =  1 000 micro-€ de prix catalogue           (credit_list_micro_eur)
--   → marge plancher structurelle = 1 - 200/1000 = 80 %
--
-- La marge n'est donc pas une hypothèse commerciale : elle est imposée par la
-- conversion. Un fournisseur plus cher consomme plus de crédits, pas de marge.
-- Chaque tarif porte en plus un `margin_multiplier` (≥ 1) pour monter au-dessus
-- du plancher sur les usages à risque (génération d'images, temps GPU).
--
-- EXTENSIBILITÉ (exigence explicite)
-- Rien n'est codé en dur côté fournisseur : `ai_provider_rates` est une grille
-- tarifaire (provider, sku, unité) résolue à l'exécution. Brancher OpenAI ou
-- Mistral = insérer des lignes + appeler `meter_ai_usage`. Aucun DDL. Un SKU
-- inconnu tombe sur un tarif joker VOLONTAIREMENT sur-évalué : un fournisseur
-- oublié sur-facture des crédits, il n'ouvre jamais une fuite de marge.
--
-- CONFIDENTIALITÉ DES COÛTS
-- `ai_provider_rates`, `billing_config` et les colonnes de coût de `usage_ledger`
-- sont notre COGS : jamais exposés au client. Les clients lisent la vue
-- `workspace_usage_ledger` (quantités + crédits, sans euro de coût).

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Configuration économique (privée)
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.billing_config (
  id boolean primary key default true check (id),
  -- Coût fournisseur absorbé par 1 crédit, en micro-euros (1 € = 1 000 000).
  credit_cogs_micro_eur numeric(12,4) not null default 200,
  -- Prix catalogue d'1 crédit hors forfait, en micro-euros.
  credit_list_micro_eur numeric(12,4) not null default 1000,
  -- Marge plancher visée. Sert d'alerte : toute grille qui descend en dessous
  -- est signalée par billing_margin_report().
  margin_floor_pct numeric(5,2) not null default 80,
  -- Devise de référence de toute la grille (les tarifs fournisseurs sont
  -- convertis à l'insertion, pas à l'exécution).
  currency text not null default 'eur',
  updated_at timestamptz not null default now()
);
insert into public.billing_config (id) values (true) on conflict (id) do nothing;

alter table public.billing_config enable row level security;
-- Aucune policy : RLS activé sans policy = lecture interdite à anon/authenticated.
-- Seul le service_role (edge functions) et les fonctions security-definer lisent.

comment on table public.billing_config is
  'Paramètres économiques internes (coût absorbé par crédit, prix catalogue, marge plancher). JAMAIS exposé au client.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Catalogue d'offres
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.billing_plans (
  code text primary key,
  name text not null,
  tagline text not null default '',
  -- Prix mensuel HT, en centimes d'euro. 0 = gratuit ou sur devis (voir is_quote).
  price_cents_eur int not null default 0,
  annual_price_cents_eur int,
  is_quote boolean not null default false,
  -- Crédits inclus par période. Leur valeur catalogue est TOUJOURS inférieure au
  -- prix du plan (cf. commentaire du seed) : la marge réelle dépasse le plancher.
  included_credits bigint not null default 0,
  -- Dépassement : facturé à ce prix unitaire si overage_enabled sur l'abonnement.
  overage_micro_eur_per_credit numeric(12,4) not null default 1500,
  -- Plafond de dépassement par défaut (0 = pas de dépassement, on bloque).
  default_overage_cap_credits bigint not null default 0,
  included_seats int not null default 1,
  extra_seat_cents_eur int not null default 0,
  -- Limites dures non-token : { "agents": 5, "projects": 3, ... }. -1 = illimité.
  limits jsonb not null default '{}'::jsonb,
  -- Interrupteurs fonctionnels : { "guardrails_runtime": true, ... }.
  features jsonb not null default '{}'::jsonb,
  stripe_price_id text,
  stripe_price_id_annual text,
  sort_order int not null default 0,
  is_public boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.billing_plans enable row level security;
drop policy if exists "Anyone reads active plans" on public.billing_plans;
create policy "Anyone reads active plans" on public.billing_plans
  for select using (is_active and is_public);

-- Packs de crédits prépayés (report d'une période à l'autre).
create table if not exists public.credit_packs (
  code text primary key,
  name text not null,
  credits bigint not null,
  price_cents_eur int not null,
  stripe_price_id text,
  sort_order int not null default 0,
  is_active boolean not null default true
);
alter table public.credit_packs enable row level security;
drop policy if exists "Anyone reads active packs" on public.credit_packs;
create policy "Anyone reads active packs" on public.credit_packs
  for select using (is_active);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Grille tarifaire fournisseurs (= notre COGS, privé)
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.ai_provider_rates (
  id uuid primary key default gen_random_uuid(),
  provider text not null,                       -- deepseek | jina | groq | openai | ...
  -- SKU = identifiant de modèle/produit. '*' = joker du fournisseur.
  sku text not null default '*',
  unit text not null check (unit in (
    'token_in','token_out','token','request','second','minute','image','character','gb_month'
  )),
  -- Coût réel par unité, en euros. numeric(20,10) : un token DeepSeek en entrée
  -- vaut 0.0000003 €, il faut la précision.
  unit_cost_eur numeric(20,10) not null default 0,
  -- Multiplicateur de marge au-delà du plancher 80 % (1.0 = plancher).
  margin_multiplier numeric(6,3) not null default 1.0,
  -- exact : sku = valeur. prefix/contains : correspondance souple sur le modèle
  -- renvoyé par le fournisseur ('deepseek-chat-0725' → 'deepseek-chat').
  match_mode text not null default 'exact' check (match_mode in ('exact','prefix','contains','wildcard')),
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  notes text,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_ai_provider_rates
  on public.ai_provider_rates(provider, sku, unit, effective_from);
create index if not exists idx_ai_provider_rates_lookup
  on public.ai_provider_rates(provider, unit) where effective_to is null;

alter table public.ai_provider_rates enable row level security;
-- Aucune policy : grille de coûts = interne.

comment on table public.ai_provider_rates is
  'Grille des coûts fournisseurs (COGS). Ajouter un fournisseur IA = insérer des lignes ici, aucun changement de schéma. JAMAIS exposé au client.';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Abonnement d'un workspace
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.workspace_subscriptions (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  plan_code text not null default 'free' references public.billing_plans(code),
  status text not null default 'active'
    check (status in ('trialing','active','past_due','canceled','paused')),
  period_start timestamptz not null default date_trunc('month', now()),
  period_end   timestamptz not null default (date_trunc('month', now()) + interval '1 month'),
  seats int not null default 1,
  -- Figé au début de période : modifier une offre ne réécrit pas l'historique.
  included_credits bigint not null default 0,
  -- Solde de packs prépayés, décrémenté quand l'inclus est épuisé. Se reporte.
  topup_credits numeric(18,4) not null default 0,
  overage_enabled boolean not null default false,
  overage_cap_credits bigint not null default 0,
  -- Coupe-circuit manuel (impayé, abus). Bloque toute consommation IA.
  hard_blocked boolean not null default false,
  block_reason text,
  -- Le workspace fournit ses propres clés fournisseurs : on mesure l'usage mais
  -- on ne facture pas de crédits (levier grands comptes).
  byo_provider_keys boolean not null default false,
  trial_ends_at timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_workspace_subs_period on public.workspace_subscriptions(period_end);

alter table public.workspace_subscriptions enable row level security;
drop policy if exists "Members read their subscription" on public.workspace_subscriptions;
create policy "Members read their subscription" on public.workspace_subscriptions
  for select using (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = workspace_subscriptions.workspace_id and wm.user_id = auth.uid()
  ));
-- Écriture : service_role uniquement (checkout Stripe, webhooks, ops).

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Journal d'usage (append-only) + compteurs agrégés
-- ════════════════════════════════════════════════════════════════════════════
-- Le journal est la source de vérité (audit, refacturation, litige). Les
-- compteurs servent au contrôle de quota en O(1) : lire 400 000 lignes de
-- journal à chaque tour d'agent n'est pas tenable.
create table if not exists public.usage_ledger (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  occurred_at timestamptz not null default now(),
  period_start timestamptz not null,
  provider text not null,
  sku text not null default '',
  unit text not null,
  quantity numeric(18,4) not null default 0,
  -- COGS — privé.
  unit_cost_eur numeric(20,10) not null default 0,
  cost_eur numeric(18,8) not null default 0,
  -- Facturé au client, en crédits fractionnaires (pas d'arrondi à la hausse :
  -- une recherche vectorielle à 0,004 crédit ne doit pas être facturée 1).
  billed_credits numeric(18,4) not null default 0,
  billable boolean not null default true,
  feature text,
  task text,
  run_id uuid,
  agent_id uuid,
  user_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  -- Rejoue sans double comptage (retry d'edge function, tick redélivré).
  idempotency_key text
);
create unique index if not exists uq_usage_ledger_idem
  on public.usage_ledger(idempotency_key) where idempotency_key is not null;
create index if not exists idx_usage_ledger_ws on public.usage_ledger(workspace_id, occurred_at desc);
create index if not exists idx_usage_ledger_period on public.usage_ledger(workspace_id, period_start);
create index if not exists idx_usage_ledger_run on public.usage_ledger(run_id) where run_id is not null;
create index if not exists idx_usage_ledger_agent on public.usage_ledger(agent_id) where agent_id is not null;

alter table public.usage_ledger enable row level security;
-- Aucune policy : contient le COGS. Les clients passent par la vue ci-dessous.

-- Vue client : mêmes lignes, sans un seul euro de coût fournisseur.
create or replace view public.workspace_usage_ledger as
  select l.id, l.workspace_id, l.project_id, l.occurred_at, l.period_start,
         l.provider, l.sku, l.unit, l.quantity, l.billed_credits, l.billable,
         l.feature, l.task, l.run_id, l.agent_id, l.user_id
    from public.usage_ledger l
   where exists (
     select 1 from public.workspace_members wm
      where wm.workspace_id = l.workspace_id and wm.user_id = auth.uid()
   );
grant select on public.workspace_usage_ledger to authenticated;

comment on view public.workspace_usage_ledger is
  'Journal d''usage visible par les membres : quantités et crédits, sans les coûts fournisseurs.';

-- Compteurs par (workspace, période, métrique). Métriques : credits,
-- credits.<provider>, credits.overage, tokens_in, tokens_out, agent_runs, …
create table if not exists public.usage_counters (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  period_start timestamptz not null,
  metric text not null,
  value numeric(18,4) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, period_start, metric)
);
alter table public.usage_counters enable row level security;
drop policy if exists "Members read their counters" on public.usage_counters;
create policy "Members read their counters" on public.usage_counters
  for select using (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = usage_counters.workspace_id and wm.user_id = auth.uid()
  ));

-- Événements de quota (avertissement 80 %, blocage) : sert l'UI et les relances.
create table if not exists public.billing_events (
  id bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in (
    'period_rollover','threshold_80','threshold_100','blocked','unblocked',
    'topup','plan_change','overage_started','overage_capped'
  )),
  message text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_billing_events_ws on public.billing_events(workspace_id, created_at desc);
alter table public.billing_events enable row level security;
drop policy if exists "Members read billing events" on public.billing_events;
create policy "Members read billing events" on public.billing_events
  for select using (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = billing_events.workspace_id and wm.user_id = auth.uid()
  ));

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Résolution de tarif → crédits
-- ════════════════════════════════════════════════════════════════════════════
-- Ordre de préférence : exact > prefix > contains > joker fournisseur > joker
-- global. Le joker global est délibérément cher : un fournisseur branché sans
-- tarif sur-facture le client (visible, corrigeable) plutôt que de saigner la marge.
create or replace function public.resolve_ai_rate(
  p_provider text, p_sku text, p_unit text
) returns table (unit_cost_eur numeric, margin_multiplier numeric, matched_sku text)
language sql stable security definer set search_path = public as $$
  select r.unit_cost_eur, r.margin_multiplier, r.sku
    from public.ai_provider_rates r
   where r.unit = p_unit
     and (r.effective_to is null or r.effective_to > now())
     and r.effective_from <= now()
     and (
       (r.provider = p_provider and r.match_mode = 'exact'    and r.sku = coalesce(p_sku,''))
    or (r.provider = p_provider and r.match_mode = 'prefix'   and coalesce(p_sku,'') like r.sku || '%')
    or (r.provider = p_provider and r.match_mode = 'contains' and position(r.sku in coalesce(p_sku,'')) > 0)
    or (r.provider = p_provider and r.match_mode = 'wildcard')
    or (r.provider = '*'        and r.match_mode = 'wildcard')
     )
   order by
     case when r.provider = '*' then 3
          when r.match_mode = 'wildcard' then 2
          when r.match_mode = 'exact' then 0
          else 1 end,
     length(r.sku) desc,
     r.effective_from desc
   limit 1;
$$;

-- Coût fournisseur (€) → crédits facturés.
create or replace function public.credits_for_cost(p_cost_eur numeric, p_multiplier numeric default 1)
returns numeric language sql stable security definer set search_path = public as $$
  select round(
    (coalesce(p_cost_eur,0) * 1000000.0 / nullif(c.credit_cogs_micro_eur, 0)) * coalesce(p_multiplier, 1),
    4
  )
  from public.billing_config c where c.id;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Période courante (création paresseuse + bascule mensuelle)
-- ════════════════════════════════════════════════════════════════════════════
-- Pas de cron : la période bascule à la première consommation ou au premier
-- affichage après period_end. Un workspace inactif n'a rien à basculer.
create or replace function public.billing_current_period(p_workspace uuid)
returns public.workspace_subscriptions
language plpgsql security definer set search_path = public as $$
declare
  v_sub public.workspace_subscriptions;
  v_plan public.billing_plans;
  v_guard int := 0;
begin
  select * into v_sub from public.workspace_subscriptions where workspace_id = p_workspace;

  if not found then
    select * into v_plan from public.billing_plans where code = 'free';
    insert into public.workspace_subscriptions (workspace_id, plan_code, included_credits, seats,
                                                overage_cap_credits)
    values (p_workspace, 'free', coalesce(v_plan.included_credits, 0), 1,
            coalesce(v_plan.default_overage_cap_credits, 0))
    on conflict (workspace_id) do nothing;
    select * into v_sub from public.workspace_subscriptions where workspace_id = p_workspace;
  end if;

  -- Bascule autant de fois que nécessaire (workspace dormant depuis 3 mois).
  while v_sub.period_end <= now() and v_guard < 60 loop
    v_guard := v_guard + 1;
    select * into v_plan from public.billing_plans where code = v_sub.plan_code;
    update public.workspace_subscriptions s
       set period_start = s.period_end,
           period_end   = s.period_end + interval '1 month',
           included_credits = coalesce(v_plan.included_credits, s.included_credits),
           overage_cap_credits = case when s.overage_enabled then s.overage_cap_credits else 0 end,
           updated_at = now()
     where s.workspace_id = p_workspace
     returning * into v_sub;
  end loop;

  if v_guard > 0 then
    insert into public.billing_events (workspace_id, kind, message, payload)
    values (p_workspace, 'period_rollover',
            'Nouvelle période de facturation', jsonb_build_object('periods', v_guard,
            'period_start', v_sub.period_start, 'period_end', v_sub.period_end));
  end if;

  return v_sub;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Compteurs de ressources (limites non-token : services, agents, stockage…)
-- ════════════════════════════════════════════════════════════════════════════
-- Volume stocké, en Mo. Deux gisements, tous deux rattachés au workspace par le
-- projet : les objets Storage (les fichiers déposés — buckets préfixés par
-- project_id) et le texte extrait qui vit en base (chunks RAG vectorisés).
-- Le calcul somme storage.objects — c'est un scan. Il est donc appelé aux points
-- de dépôt/ingestion, jamais dans la boucle d'agent, et son résultat est mémorisé
-- une heure dans usage_counters (cf. billing_resource_count).
create or replace function public.billing_storage_mb(p_workspace uuid)
returns numeric language plpgsql security definer set search_path = public, storage as $$
declare
  v_objects bigint := 0;
  v_text bigint := 0;
  v_mb numeric;
begin
  begin
    select coalesce(sum((o.metadata ->> 'size')::bigint), 0) into v_objects
      from storage.objects o
     where split_part(o.name, '/', 1) in (
       select p.id::text from public.projects p where p.workspace_id = p_workspace
     );
  exception when others then
    v_objects := 0;  -- schéma storage inaccessible (tests locaux) : on n'échoue pas
  end;

  begin
    select coalesce(sum(octet_length(c.content)), 0) into v_text
      from public.rag_chunks c where c.workspace_id = p_workspace;
  exception when undefined_table or undefined_column then
    v_text := 0;
  end;

  v_mb := round((v_objects + v_text) / 1048576.0, 2);

  insert into public.usage_counters (workspace_id, period_start, metric, value)
  select p_workspace, s.period_start, 'storage_mb', v_mb
    from public.workspace_subscriptions s where s.workspace_id = p_workspace
  on conflict (workspace_id, period_start, metric)
  do update set value = excluded.value, updated_at = now();

  return v_mb;
end;
$$;

-- Nom lisible d'une métrique : le message de blocage part vers l'utilisateur
-- final, il ne doit pas parler « knowledge_collections ».
create or replace function public.billing_metric_label(p_metric text)
returns text language sql immutable as $$
  select case p_metric
    when 'services' then 'services'
    when 'agents' then 'agents'
    when 'seats' then 'sièges'
    when 'projects' then 'projets'
    when 'knowledge_collections' then 'collections de connaissances'
    when 'mcp_servers' then 'serveurs MCP'
    when 'scheduled_agents' then 'agents planifiés'
    when 'storage_mb' then 'stockage (Mo)'
    when 'concurrent_runs' then 'exécutions simultanées'
    else p_metric end;
$$;

-- Compté sur les tables réelles, pas sur un compteur incrémental : un agent
-- supprimé doit libérer son quota immédiatement.
-- VOLATILE (pas `stable`) : la branche storage_mb met son résultat en cache.
create or replace function public.billing_resource_count(p_workspace uuid, p_metric text)
returns numeric language plpgsql security definer set search_path = public as $$
declare v numeric;
begin
  case p_metric
    when 'agents' then
      select count(*) into v from public.internal_agents where workspace_id = p_workspace;
    when 'services' then
      select count(*) into v from public.service_dashboards where workspace_id = p_workspace;
    when 'scheduled_agents' then
      select count(*) into v from public.internal_agents
       where workspace_id = p_workspace and coalesce(schedule, 'manual') <> 'manual';
    when 'seats' then
      select count(*) into v from public.workspace_members where workspace_id = p_workspace;
    when 'projects' then
      select count(*) into v from public.projects where workspace_id = p_workspace;
    when 'knowledge_collections' then
      select count(*) into v from public.rag_collections where workspace_id = p_workspace;
    when 'mcp_servers' then
      select count(*) into v from public.mcp_servers where workspace_id = p_workspace;
    when 'concurrent_runs' then
      -- Limite de débit, pas de volume : elle empêche un workspace de saturer
      -- la file d'exécution (et de brûler ses crédits en parallèle).
      select count(*) into v from public.internal_agent_runs r
       where r.workspace_id = p_workspace and r.status in ('queued','running');
    when 'storage_mb' then
      -- Cache d'une heure : un affichage de page ne doit pas relancer le scan.
      select c.value into v from public.usage_counters c
        join public.workspace_subscriptions s on s.workspace_id = c.workspace_id
       where c.workspace_id = p_workspace and c.metric = 'storage_mb'
         and c.period_start = s.period_start and c.updated_at > now() - interval '1 hour';
      if v is null then v := public.billing_storage_mb(p_workspace); end if;
    else v := 0;
  end case;
  return coalesce(v, 0);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Contrôle de quota — appelé AVANT toute dépense
-- ════════════════════════════════════════════════════════════════════════════
-- Renvoie { allowed, reason, code, remaining, limit, usage, plan, ... }.
-- p_metric = 'credits' → contrôle de solde ; sinon limite de ressource.
create or replace function public.billing_check_quota(
  p_workspace uuid, p_metric text default 'credits', p_amount numeric default 0
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sub public.workspace_subscriptions;
  v_plan public.billing_plans;
  v_used numeric;
  v_limit numeric;
  v_remaining numeric;
  v_overage_used numeric;
begin
  if p_workspace is null then
    -- Usage non attribuable (tâche système) : on mesure, on ne bloque pas.
    return jsonb_build_object('allowed', true, 'code', 'unscoped', 'remaining', null);
  end if;

  v_sub := public.billing_current_period(p_workspace);
  select * into v_plan from public.billing_plans where code = v_sub.plan_code;

  if v_sub.hard_blocked then
    return jsonb_build_object('allowed', false, 'code', 'blocked',
      'reason', coalesce(v_sub.block_reason, 'Espace de travail bloqué. Contactez le support.'),
      'plan', v_sub.plan_code);
  end if;

  if v_sub.status in ('canceled') then
    return jsonb_build_object('allowed', false, 'code', 'subscription_inactive',
      'reason', 'Abonnement résilié — réactivez une offre pour relancer les agents.',
      'plan', v_sub.plan_code);
  end if;

  -- ── Limites de ressources ────────────────────────────────────────────────
  if p_metric <> 'credits' then
    v_limit := coalesce((v_plan.limits ->> p_metric)::numeric, -1);
    if v_limit < 0 then
      return jsonb_build_object('allowed', true, 'code', 'unlimited', 'limit', null,
        'metric', p_metric, 'plan', v_sub.plan_code);
    end if;
    v_used := public.billing_resource_count(p_workspace, p_metric);
    if v_used + greatest(p_amount, 0) > v_limit then
      return jsonb_build_object('allowed', false, 'code', 'limit_reached',
        'reason', format('Offre %s : limite de %s %s atteinte (%s utilisés). Passez à l''offre supérieure pour en ajouter.',
                         v_plan.name, v_limit::bigint, public.billing_metric_label(p_metric), v_used::bigint),
        'metric', p_metric, 'label', public.billing_metric_label(p_metric),
        'usage', v_used, 'limit', v_limit, 'plan', v_sub.plan_code);
    end if;
    return jsonb_build_object('allowed', true, 'code', 'ok', 'metric', p_metric,
      'usage', v_used, 'limit', v_limit, 'remaining', v_limit - v_used, 'plan', v_sub.plan_code);
  end if;

  -- ── Crédits ──────────────────────────────────────────────────────────────
  if v_sub.byo_provider_keys then
    return jsonb_build_object('allowed', true, 'code', 'byo_keys', 'plan', v_sub.plan_code);
  end if;

  select coalesce(value, 0) into v_used from public.usage_counters
   where workspace_id = p_workspace and period_start = v_sub.period_start and metric = 'credits';
  v_used := coalesce(v_used, 0);
  select coalesce(value, 0) into v_overage_used from public.usage_counters
   where workspace_id = p_workspace and period_start = v_sub.period_start and metric = 'credits.overage';
  v_overage_used := coalesce(v_overage_used, 0);

  v_remaining := (v_sub.included_credits - v_used) + v_sub.topup_credits;

  if v_remaining - greatest(p_amount, 0) > 0 then
    return jsonb_build_object('allowed', true, 'code', 'ok', 'metric', 'credits',
      'usage', v_used, 'limit', v_sub.included_credits, 'topup', v_sub.topup_credits,
      'remaining', v_remaining, 'plan', v_sub.plan_code,
      'period_end', v_sub.period_end);
  end if;

  if v_sub.overage_enabled and v_overage_used < v_sub.overage_cap_credits then
    return jsonb_build_object('allowed', true, 'code', 'overage', 'metric', 'credits',
      'usage', v_used, 'limit', v_sub.included_credits, 'remaining', 0,
      'overage_used', v_overage_used, 'overage_cap', v_sub.overage_cap_credits,
      'plan', v_sub.plan_code, 'period_end', v_sub.period_end);
  end if;

  return jsonb_build_object('allowed', false,
    'code', case when v_sub.overage_enabled then 'overage_capped' else 'credits_exhausted' end,
    'reason', case when v_sub.overage_enabled
      then 'Plafond de dépassement atteint. Relevez le plafond ou ajoutez un pack de crédits.'
      else 'Crédits IA épuisés pour cette période. Ajoutez un pack de crédits ou changez d''offre.' end,
    'metric', 'credits', 'usage', v_used, 'limit', v_sub.included_credits,
    'remaining', 0, 'plan', v_sub.plan_code, 'period_end', v_sub.period_end);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 10. Enregistrement d'une consommation (service_role uniquement)
-- ════════════════════════════════════════════════════════════════════════════
-- Un appel = une ligne de journal + les compteurs. Le débit des packs prépayés
-- se fait ici, pas au calcul d'affichage : `topup_credits` doit survivre à la
-- remise à zéro mensuelle des compteurs.
create or replace function public.meter_ai_usage(
  p_workspace uuid,
  p_provider text,
  p_sku text,
  p_unit text,
  p_quantity numeric,
  p_project uuid default null,
  p_feature text default null,
  p_task text default null,
  p_run_id uuid default null,
  p_agent_id uuid default null,
  p_user_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_idempotency_key text default null,
  p_billable boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sub public.workspace_subscriptions;
  v_rate record;
  v_cost numeric := 0;
  v_credits numeric := 0;
  v_used numeric := 0;
  v_before numeric := 0;
  v_overflow numeric := 0;
  v_from_topup numeric := 0;
  v_overage numeric := 0;
  v_pct numeric;
begin
  if coalesce(p_quantity, 0) <= 0 then
    return jsonb_build_object('ok', true, 'skipped', 'zero_quantity');
  end if;

  select r.unit_cost_eur, r.margin_multiplier, r.matched_sku
    into v_rate from public.resolve_ai_rate(p_provider, p_sku, p_unit) r;

  v_cost := round(coalesce(v_rate.unit_cost_eur, 0) * p_quantity, 8);
  v_credits := coalesce(public.credits_for_cost(v_cost, coalesce(v_rate.margin_multiplier, 1)), 0);

  if p_workspace is null then
    -- Usage système non rattachable (tâche de plateforme) : le journal est
    -- indexé par workspace, il n'y a rien à y écrire. Le coût reste visible
    -- dans les logs de la fonction appelante.
    return jsonb_build_object('ok', true, 'skipped', 'unscoped', 'cost_eur', v_cost);
  end if;

  v_sub := public.billing_current_period(p_workspace);
  if v_sub.byo_provider_keys then
    p_billable := false;
  end if;
  if not p_billable then
    -- Ni crédits, ni coût. Les deux cas de non-facturation ont un COGS
    -- réellement nul pour nous : soit le client paie le fournisseur avec ses
    -- propres clés, soit la ligne est une synthèse dont la dépense a déjà été
    -- comptée. Laisser cost_eur ici fausserait billing_margin_report.
    v_credits := 0;
    v_cost := 0;
  end if;

  begin
    insert into public.usage_ledger (workspace_id, project_id, period_start, provider, sku, unit,
      quantity, unit_cost_eur, cost_eur, billed_credits, billable, feature, task, run_id, agent_id,
      user_id, metadata, idempotency_key)
    values (p_workspace, p_project, v_sub.period_start, p_provider, coalesce(p_sku,''), p_unit,
      p_quantity, coalesce(v_rate.unit_cost_eur,0), v_cost, v_credits, p_billable, p_feature, p_task,
      p_run_id, p_agent_id, p_user_id, coalesce(p_metadata,'{}'::jsonb), p_idempotency_key);
  exception when unique_violation then
    -- Rejeu du même événement : déjà compté.
    return jsonb_build_object('ok', true, 'skipped', 'duplicate');
  end;

  -- Compteurs : total, par fournisseur, et unités brutes pour l'analyse.
  -- Le total AVANT est déduit du total APRÈS renvoyé par l'upsert, et non lu
  -- séparément : deux sous-agents qui facturent en parallèle liraient sinon le
  -- même « avant » et se partageraient mal la réserve prépayée. L'upsert prend
  -- un verrou de ligne, donc chaque transaction obtient un total distinct.
  insert into public.usage_counters (workspace_id, period_start, metric, value)
  values (p_workspace, v_sub.period_start, 'credits', v_credits)
  on conflict (workspace_id, period_start, metric)
  do update set value = public.usage_counters.value + excluded.value, updated_at = now()
  returning value into v_used;
  v_before := v_used - v_credits;

  insert into public.usage_counters (workspace_id, period_start, metric, value)
  values (p_workspace, v_sub.period_start, 'credits.' || p_provider, v_credits)
  on conflict (workspace_id, period_start, metric)
  do update set value = public.usage_counters.value + excluded.value, updated_at = now();

  if p_unit in ('token_in','token_out','token') then
    insert into public.usage_counters (workspace_id, period_start, metric, value)
    values (p_workspace, v_sub.period_start,
            case p_unit when 'token_in' then 'tokens_in' when 'token_out' then 'tokens_out' else 'tokens' end,
            p_quantity)
    on conflict (workspace_id, period_start, metric)
    do update set value = public.usage_counters.value + excluded.value, updated_at = now();
  end if;

  -- Débit des packs prépayés puis du dépassement, dans cet ordre.
  v_overflow := least(v_credits, greatest(v_used - v_sub.included_credits, 0));
  if v_overflow > 0 then
    v_from_topup := least(v_overflow, v_sub.topup_credits);
    v_overage := v_overflow - v_from_topup;
    if v_from_topup > 0 then
      update public.workspace_subscriptions
         set topup_credits = topup_credits - v_from_topup, updated_at = now()
       where workspace_id = p_workspace;
    end if;
    if v_overage > 0 then
      insert into public.usage_counters (workspace_id, period_start, metric, value)
      values (p_workspace, v_sub.period_start, 'credits.overage', v_overage)
      on conflict (workspace_id, period_start, metric)
      do update set value = public.usage_counters.value + excluded.value, updated_at = now();
    end if;
  end if;

  -- Franchissements de seuil : une seule notification par période et par seuil.
  if v_sub.included_credits > 0 then
    v_pct := v_used * 100.0 / v_sub.included_credits;
    if v_pct >= 100 and v_before * 100.0 / v_sub.included_credits < 100 then
      insert into public.billing_events (workspace_id, kind, message, payload)
      values (p_workspace, 'threshold_100', 'Crédits inclus épuisés',
              jsonb_build_object('used', v_used, 'included', v_sub.included_credits));
    elsif v_pct >= 80 and v_before * 100.0 / v_sub.included_credits < 80 then
      insert into public.billing_events (workspace_id, kind, message, payload)
      values (p_workspace, 'threshold_80', '80 % des crédits inclus consommés',
              jsonb_build_object('used', v_used, 'included', v_sub.included_credits));
    end if;
  end if;

  return jsonb_build_object(
    'ok', true, 'cost_eur', v_cost, 'credits', v_credits, 'matched_sku', v_rate.matched_sku,
    'used', v_used, 'included', v_sub.included_credits,
    'remaining', (v_sub.included_credits - v_used) + v_sub.topup_credits,
    'overage', v_overage
  );
end;
$$;

revoke execute on function public.meter_ai_usage(uuid,text,text,text,numeric,uuid,text,text,uuid,uuid,uuid,jsonb,text,boolean) from public, anon, authenticated;

-- Plafond par exécution : un agent qui boucle est le seul scénario capable de
-- vider un forfait en une nuit. `max_run_credits` le borne indépendamment du
-- solde restant. Retourne { credits, cap, exceeded }.
create or replace function public.billing_run_budget(p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_ws uuid;
  v_credits numeric := 0;
  v_cap numeric;
begin
  select workspace_id into v_ws from public.internal_agent_runs where id = p_run_id;
  if v_ws is null then return jsonb_build_object('credits', 0, 'cap', null, 'exceeded', false); end if;

  select coalesce(sum(billed_credits), 0) into v_credits
    from public.usage_ledger where run_id = p_run_id;

  select (bp.limits ->> 'max_run_credits')::numeric into v_cap
    from public.workspace_subscriptions ws
    join public.billing_plans bp on bp.code = ws.plan_code
   where ws.workspace_id = v_ws;

  return jsonb_build_object(
    'credits', round(v_credits, 2),
    'cap', v_cap,
    'exceeded', v_cap is not null and v_cap > 0 and v_credits >= v_cap);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 11. Vue « droits » pour l'UI
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.billing_entitlements(p_workspace uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sub public.workspace_subscriptions;
  v_plan public.billing_plans;
  v_used numeric;
  v_overage numeric;
  v_counters jsonb;
  v_resources jsonb := '{}'::jsonb;
  v_key text;
begin
  if p_workspace is null then return jsonb_build_object('error','workspace required'); end if;
  if not exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = p_workspace and wm.user_id = auth.uid()) then
    return jsonb_build_object('error','forbidden');
  end if;

  v_sub := public.billing_current_period(p_workspace);
  select * into v_plan from public.billing_plans where code = v_sub.plan_code;

  select coalesce(value,0) into v_used from public.usage_counters
   where workspace_id = p_workspace and period_start = v_sub.period_start and metric = 'credits';
  select coalesce(value,0) into v_overage from public.usage_counters
   where workspace_id = p_workspace and period_start = v_sub.period_start and metric = 'credits.overage';

  select coalesce(jsonb_object_agg(metric, value), '{}'::jsonb) into v_counters
    from public.usage_counters
   where workspace_id = p_workspace and period_start = v_sub.period_start;

  -- Consommation réelle de chaque ressource dénombrable. On n'itère PAS sur
  -- toutes les clés de `limits` : max_run_credits ou ledger_retention_days sont
  -- des réglages, pas des compteurs — les afficher « 0 / 4000 » n'a aucun sens.
  foreach v_key in array array['services','agents','seats','projects',
                               'knowledge_collections','mcp_servers',
                               'scheduled_agents','storage_mb'] loop
    if v_plan.limits ? v_key then
      v_resources := v_resources || jsonb_build_object(
        v_key, jsonb_build_object(
          'used', public.billing_resource_count(p_workspace, v_key),
          'limit', (v_plan.limits ->> v_key)::numeric,
          'label', public.billing_metric_label(v_key)));
    end if;
  end loop;

  return jsonb_build_object(
    'plan', jsonb_build_object(
      'code', v_plan.code, 'name', v_plan.name, 'tagline', v_plan.tagline,
      'price_cents_eur', v_plan.price_cents_eur, 'is_quote', v_plan.is_quote,
      'limits', v_plan.limits, 'features', v_plan.features,
      'included_seats', v_plan.included_seats,
      'overage_micro_eur_per_credit', v_plan.overage_micro_eur_per_credit),
    'subscription', jsonb_build_object(
      'status', v_sub.status, 'period_start', v_sub.period_start, 'period_end', v_sub.period_end,
      'seats', v_sub.seats, 'hard_blocked', v_sub.hard_blocked,
      'byo_provider_keys', v_sub.byo_provider_keys,
      'overage_enabled', v_sub.overage_enabled, 'overage_cap_credits', v_sub.overage_cap_credits,
      'trial_ends_at', v_sub.trial_ends_at),
    'credits', jsonb_build_object(
      'included', v_sub.included_credits,
      'used', coalesce(v_used,0),
      'topup', v_sub.topup_credits,
      'overage_used', coalesce(v_overage,0),
      'remaining', greatest((v_sub.included_credits - coalesce(v_used,0)) + v_sub.topup_credits, 0),
      'percent', case when v_sub.included_credits > 0
                      then round(coalesce(v_used,0) * 100.0 / v_sub.included_credits, 1) else 0 end),
    'counters', v_counters,
    'resources', v_resources
  );
end;
$$;

-- Répartition de la consommation (par fournisseur / fonctionnalité / agent).
create or replace function public.billing_usage_breakdown(
  p_workspace uuid, p_dimension text default 'provider', p_days int default 30
) returns table (label text, credits numeric, quantity numeric, events bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.workspace_members wm
                  where wm.workspace_id = p_workspace and wm.user_id = auth.uid()) then
    raise exception 'forbidden';
  end if;
  return query
  select coalesce(
           case p_dimension
             when 'feature' then l.feature
             when 'agent'   then l.agent_id::text
             when 'sku'     then l.sku
             else l.provider end, '—') as label,
         round(sum(l.billed_credits), 2) as credits,
         round(sum(l.quantity), 0) as quantity,
         count(*) as events
    from public.usage_ledger l
   where l.workspace_id = p_workspace
     and l.occurred_at > now() - make_interval(days => greatest(p_days, 1))
     and l.billable   -- ne montrer que ce qui a réellement consommé des crédits
   group by 1
   order by 2 desc
   limit 50;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 12. Contrôle de marge (interne)
-- ════════════════════════════════════════════════════════════════════════════
-- Vérifie que la réalité colle au modèle : revenu reconnu vs COGS réel, par
-- workspace et par période. Sert d'alerte si un tarif fournisseur a bougé sans
-- que la grille soit mise à jour. service_role uniquement.
create or replace function public.billing_margin_report(p_days int default 30)
returns table (
  workspace_id uuid, plan_code text, revenue_eur numeric, cogs_eur numeric,
  credits_billed numeric, margin_pct numeric
)
language sql stable security definer set search_path = public as $$
  with spend as (
    select l.workspace_id,
           sum(l.cost_eur) as cogs,
           sum(l.billed_credits) as credits
      from public.usage_ledger l
     where l.occurred_at > now() - make_interval(days => greatest(p_days,1))
       and l.billable          -- les lignes de synthèse ne sont pas un coût réel
     group by 1
  )
  select s.workspace_id,
         sub.plan_code,
         round(sub.price_share + (s.credits * cfg.credit_list_micro_eur / 1000000.0), 2) as revenue_eur,
         round(s.cogs, 4) as cogs_eur,
         round(s.credits, 2) as credits_billed,
         case when (sub.price_share + s.credits * cfg.credit_list_micro_eur / 1000000.0) > 0
              then round(100 * (1 - s.cogs / (sub.price_share + s.credits * cfg.credit_list_micro_eur / 1000000.0)), 2)
              else null end as margin_pct
    from spend s
    join (
      select ws.workspace_id, ws.plan_code,
             (bp.price_cents_eur / 100.0) as price_share
        from public.workspace_subscriptions ws
        join public.billing_plans bp on bp.code = ws.plan_code
    ) sub on sub.workspace_id = s.workspace_id
   cross join public.billing_config cfg
   where cfg.id
   order by margin_pct nulls last;
$$;
revoke execute on function public.billing_margin_report(int) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 12 ter. Application d'un paiement (service_role uniquement)
-- ════════════════════════════════════════════════════════════════════════════
-- Idempotence des achats. Une session Stripe peut être confirmée deux fois (le
-- client rafraîchit la page de retour, deux onglets ouverts) : sans cette table,
-- un pack de crédits serait appliqué deux fois. La clé primaire fait le travail.
create table if not exists public.billing_checkout_sessions (
  session_id text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('plan','pack')),
  reference text not null default '',
  applied_at timestamptz not null default now()
);
alter table public.billing_checkout_sessions enable row level security;
-- Aucune policy : écrit et lu par la fonction de checkout (service_role).

-- Changement d'offre : la période REDÉMARRE et l'allocation est immédiate. Le
-- client qui paie en milieu de mois travaille tout de suite ; il faut repasser
-- par un paiement Stripe pour rejouer l'opération, elle n'est donc pas
-- exploitable comme remise à zéro gratuite des compteurs.
create or replace function public.billing_apply_plan(
  p_workspace uuid, p_plan text,
  p_stripe_customer text default null, p_stripe_subscription text default null,
  p_seats int default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_plan public.billing_plans; v_prev text;
begin
  select * into v_plan from public.billing_plans where code = p_plan and is_active;
  if not found then raise exception 'Offre inconnue: %', p_plan; end if;

  perform public.billing_current_period(p_workspace);
  select plan_code into v_prev from public.workspace_subscriptions where workspace_id = p_workspace;

  update public.workspace_subscriptions set
    plan_code = v_plan.code,
    status = 'active',
    period_start = now(),
    period_end = now() + interval '1 month',
    included_credits = v_plan.included_credits,
    overage_cap_credits = case when overage_enabled then v_plan.default_overage_cap_credits else 0 end,
    seats = coalesce(p_seats, greatest(seats, 1)),
    hard_blocked = false, block_reason = null,
    stripe_customer_id = coalesce(p_stripe_customer, stripe_customer_id),
    stripe_subscription_id = coalesce(p_stripe_subscription, stripe_subscription_id),
    updated_at = now()
  where workspace_id = p_workspace;

  insert into public.billing_events (workspace_id, kind, message, payload)
  values (p_workspace, 'plan_change', format('Offre %s activée', v_plan.name),
          jsonb_build_object('from', v_prev, 'to', v_plan.code,
                             'included_credits', v_plan.included_credits));

  return jsonb_build_object('ok', true, 'plan', v_plan.code,
                            'included_credits', v_plan.included_credits);
end;
$$;
revoke execute on function public.billing_apply_plan(uuid,text,text,text,int) from public, anon, authenticated;

-- Recharge : les crédits d'un pack se REPORTENT d'une période à l'autre (le
-- client les a payés), contrairement à l'allocation mensuelle qui expire.
create or replace function public.billing_apply_topup(
  p_workspace uuid, p_credits numeric, p_reference text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_balance numeric;
begin
  if coalesce(p_credits, 0) <= 0 then raise exception 'Montant de recharge invalide'; end if;
  perform public.billing_current_period(p_workspace);
  update public.workspace_subscriptions
     set topup_credits = topup_credits + p_credits, updated_at = now()
   where workspace_id = p_workspace
   returning topup_credits into v_balance;

  insert into public.billing_events (workspace_id, kind, message, payload)
  values (p_workspace, 'topup', format('%s crédits ajoutés', p_credits::bigint),
          jsonb_build_object('credits', p_credits, 'reference', p_reference));

  return jsonb_build_object('ok', true, 'topup_credits', v_balance);
end;
$$;
revoke execute on function public.billing_apply_topup(uuid,numeric,text) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 12 bis. Application des limites de ressources (services, agents, sièges…)
-- ════════════════════════════════════════════════════════════════════════════
-- Par TRIGGER et non dans l'UI : un agent se crée depuis le front, depuis une
-- edge function, depuis un autre agent (spawn) et depuis l'assistant. Un seul
-- point d'application est la seule façon que la limite soit vraie partout.
--
-- Échappatoire volontaire : `set local app.skip_billing_limits = 'on'` permet
-- aux migrations et aux scripts d'ops d'insérer sans être bloqués.
create or replace function public.billing_enforce_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_metric text := tg_argv[0];
  v_res jsonb;
begin
  if coalesce(current_setting('app.skip_billing_limits', true), '') = 'on' then
    return new;
  end if;
  if new.workspace_id is null then return new; end if;

  v_res := public.billing_check_quota(new.workspace_id, v_metric, 1);
  if not coalesce((v_res ->> 'allowed')::boolean, true) then
    raise exception '%', coalesce(v_res ->> 'reason', 'Limite de l''offre atteinte.')
      using errcode = 'check_violation', hint = 'billing_limit';
  end if;
  return new;
end;
$$;

do $$
declare t record;
begin
  for t in
    select * from (values
      ('internal_agents',    'agents'),
      ('service_dashboards', 'services'),
      ('projects',           'projects'),
      ('rag_collections',    'knowledge_collections'),
      ('mcp_servers',        'mcp_servers'),
      ('workspace_members',  'seats')
    ) as v(tbl, metric)
  loop
    execute format('drop trigger if exists trg_billing_limit_%1$s on public.%1$s', t.tbl);
    execute format(
      'create trigger trg_billing_limit_%1$s before insert on public.%1$s
       for each row execute function public.billing_enforce_limit(%2$L)', t.tbl, t.metric);
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 13. Synchronisation avec workspaces.plan (code existant)
-- ════════════════════════════════════════════════════════════════════════════
-- Des vues lisent encore `workspaces.plan`. On le garde aligné pour ne pas
-- casser l'existant, l'abonnement restant la source de vérité.
create or replace function public.sync_workspace_plan() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.workspaces set plan = new.plan_code where id = new.workspace_id;
  return new;
end;
$$;
drop trigger if exists trg_sync_workspace_plan on public.workspace_subscriptions;
create trigger trg_sync_workspace_plan
  after insert or update of plan_code on public.workspace_subscriptions
  for each row execute function public.sync_workspace_plan();

-- ════════════════════════════════════════════════════════════════════════════
-- 14. Seed — offres
-- ════════════════════════════════════════════════════════════════════════════
-- Règle de construction : valeur catalogue des crédits inclus (1 000 crédits = 1 €)
-- maintenue SOUS le prix du plan. Le plan couvre donc la plateforme ET laisse la
-- marge au-dessus du plancher de 80 %, même si le client consomme tout :
--   individual  29 € →  12 000 crédits → COGS max  2,40 € → marge 91,7 %
--   pro         99 € →  60 000 crédits → COGS max 12,00 € → marge 87,9 %
--   agencies   349 € → 220 000 crédits → COGS max 44,00 € → marge 87,4 %
--   enterprise      → volume négocié, plancher 80 % contractuel
--
-- `free` n'est pas commercialisé (is_public = false) : c'est l'état par défaut
-- d'un workspace tant qu'aucune offre n'est souscrite — un essai borné à
-- 0,40 € de COGS. Sans lui, créer un workspace poserait le client sur un plan
-- payant qu'il n'a pas acheté.
--
-- Stockage : Supabase Storage coûte ~0,021 €/Go/mois. 200 Go sur l'offre
-- agencies = ~4 € de COGS pour 349 € — la limite protège l'abus, pas la marge.
insert into public.billing_plans (code, name, tagline, price_cents_eur, annual_price_cents_eur,
  is_quote, included_credits, overage_micro_eur_per_credit, default_overage_cap_credits,
  included_seats, extra_seat_cents_eur, limits, features, is_public, sort_order) values
('free', 'Découverte', 'Essai borné : évaluer les agents et la gouvernance.', 0, 0, false,
  2000, 1500, 0, 2, 0,
  '{"services":1,"agents":2,"seats":2,"projects":1,"knowledge_collections":1,"storage_mb":200,"mcp_servers":0,"scheduled_agents":0,"concurrent_runs":1,"max_run_credits":400,"ledger_retention_days":30}'::jsonb,
  '{"agent_runtime":true,"governance_registry":true,"guardrails_runtime":false,"hitl_approvals":false,"audit_export":false,"sso":false,"byo_keys":false,"priority_support":false}'::jsonb, false, 0),
('individual', 'Individual', 'Un opérateur, ses agents et son service.', 2900, 29000, false,
  12000, 1500, 6000, 1, 900,
  '{"services":1,"agents":3,"seats":1,"projects":2,"knowledge_collections":3,"storage_mb":2048,"mcp_servers":1,"scheduled_agents":2,"concurrent_runs":1,"max_run_credits":800,"ledger_retention_days":90}'::jsonb,
  '{"agent_runtime":true,"governance_registry":true,"guardrails_runtime":true,"hitl_approvals":false,"audit_export":false,"sso":false,"byo_keys":false,"priority_support":false}'::jsonb, true, 1),
('pro', 'Pro', 'Une équipe, un parc d''agents supervisé.', 9900, 99000, false,
  60000, 1500, 40000, 5, 1500,
  '{"services":3,"agents":10,"seats":5,"projects":10,"knowledge_collections":15,"storage_mb":20480,"mcp_servers":5,"scheduled_agents":10,"concurrent_runs":3,"max_run_credits":4000,"ledger_retention_days":365}'::jsonb,
  '{"agent_runtime":true,"governance_registry":true,"guardrails_runtime":true,"hitl_approvals":true,"audit_export":true,"sso":false,"byo_keys":false,"priority_support":true}'::jsonb, true, 2),
('agencies', 'Agencies', 'Plusieurs clients, plusieurs services, gouvernance opposable.', 34900, 349000, false,
  220000, 1500, 150000, 20, 1900,
  '{"services":15,"agents":50,"seats":20,"projects":50,"knowledge_collections":75,"storage_mb":204800,"mcp_servers":25,"scheduled_agents":50,"concurrent_runs":10,"max_run_credits":15000,"ledger_retention_days":730}'::jsonb,
  '{"agent_runtime":true,"governance_registry":true,"guardrails_runtime":true,"hitl_approvals":true,"audit_export":true,"sso":true,"byo_keys":false,"priority_support":true,"white_label":true}'::jsonb, true, 3),
('enterprise', 'Enterprise', 'Engagement de volume, clés dédiées, SLA.', 0, 0, true,
  1000000, 1200, 1000000, 100, 0,
  '{"services":-1,"agents":-1,"seats":-1,"projects":-1,"knowledge_collections":-1,"storage_mb":-1,"mcp_servers":-1,"scheduled_agents":-1,"concurrent_runs":50,"max_run_credits":100000,"ledger_retention_days":1095}'::jsonb,
  '{"agent_runtime":true,"governance_registry":true,"guardrails_runtime":true,"hitl_approvals":true,"audit_export":true,"sso":true,"byo_keys":true,"priority_support":true,"white_label":true,"dedicated_support":true}'::jsonb, true, 4)
on conflict (code) do update set
  is_public = excluded.is_public,
  name = excluded.name, tagline = excluded.tagline,
  price_cents_eur = excluded.price_cents_eur,
  annual_price_cents_eur = excluded.annual_price_cents_eur,
  is_quote = excluded.is_quote,
  included_credits = excluded.included_credits,
  overage_micro_eur_per_credit = excluded.overage_micro_eur_per_credit,
  default_overage_cap_credits = excluded.default_overage_cap_credits,
  included_seats = excluded.included_seats,
  extra_seat_cents_eur = excluded.extra_seat_cents_eur,
  limits = excluded.limits, features = excluded.features, sort_order = excluded.sort_order;

-- Packs prépayés : le prix au crédit baisse avec le volume mais ne descend
-- jamais sous le plancher (1 000 crédits pour 1,00 € = exactement 80 %).
insert into public.credit_packs (code, name, credits, price_cents_eur, sort_order) values
('pack_50k',  '50 000 crédits',    50000,   6000, 0),
('pack_200k', '200 000 crédits',  200000,  22000, 1),
('pack_1m',   '1 000 000 crédits', 1000000, 100000, 2)
on conflict (code) do update set
  name = excluded.name, credits = excluded.credits,
  price_cents_eur = excluded.price_cents_eur, sort_order = excluded.sort_order;

-- ════════════════════════════════════════════════════════════════════════════
-- 15. Seed — grille fournisseurs (COGS en EUR)
-- ════════════════════════════════════════════════════════════════════════════
-- Tarifs alignés sur _shared/llm-pricing.ts (source existante du projet) pour
-- que l'estimation historique et la facturation racontent la même chose.
-- Unités : token_in / token_out par TOKEN (d'où les 10 décimales).
insert into public.ai_provider_rates (provider, sku, unit, unit_cost_eur, margin_multiplier, match_mode, notes) values
-- ── DeepSeek — le moteur des agents ─────────────────────────────────────────
('deepseek','deepseek-chat','token_in',      0.00000025, 1.0, 'contains','0,25 €/M tokens'),
('deepseek','deepseek-chat','token_out',     0.00000100, 1.0, 'contains','1,00 €/M tokens'),
('deepseek','deepseek-reasoner','token_in',  0.00000050, 1.0, 'contains','0,50 €/M tokens'),
('deepseek','deepseek-reasoner','token_out', 0.00000200, 1.0, 'contains','2,00 €/M tokens'),
('deepseek','deepseek-v4','token_in',        0.00000030, 1.0, 'contains','0,30 €/M tokens'),
('deepseek','deepseek-v4','token_out',       0.00000120, 1.0, 'contains','1,20 €/M tokens'),
('deepseek','*','token_in',                  0.00000050, 1.0, 'wildcard','Modèle DeepSeek inconnu — tarif prudent'),
('deepseek','*','token_out',                 0.00000200, 1.0, 'wildcard','Modèle DeepSeek inconnu — tarif prudent'),
-- ── Jina — vectorisation, reranking, lecture web ────────────────────────────
('jina','jina-embeddings','token',           0.00000002, 1.0, 'contains','0,02 €/M tokens'),
('jina','jina-reranker','token',             0.00000002, 1.0, 'contains','0,02 €/M tokens'),
('jina','reader','token',                    0.00000002, 1.0, 'contains','r.jina.ai — facturé au token'),
('jina','*','token',                         0.00000005, 1.0, 'wildcard','Produit Jina inconnu — tarif prudent'),
('jina','*','request',                       0.00010000, 1.0, 'wildcard','Appel Jina non tokenisé'),
-- ── Groq — hors rotation aujourd''hui, grille prête ─────────────────────────
('groq','llama-3.3-70b','token_in',          0.00000055, 1.0, 'contains',null),
('groq','llama-3.3-70b','token_out',         0.00000075, 1.0, 'contains',null),
('groq','llama-3.1-8b','token_in',           0.00000005, 1.0, 'contains',null),
('groq','llama-3.1-8b','token_out',          0.00000008, 1.0, 'contains',null),
('groq','*','token_in',                      0.00000060, 1.0, 'wildcard','Modèle Groq inconnu — tarif prudent'),
('groq','*','token_out',                     0.00000090, 1.0, 'wildcard','Modèle Groq inconnu — tarif prudent'),
-- ── Endpoint auto-hébergé (RunPod / vLLM) : coût GPU, pas coût token ────────
('hosted','*','token_in',                    0.00000030, 1.0, 'wildcard','Estimation — le coût réel est horaire (aiops_infra_cost_ledger)'),
('hosted','*','token_out',                   0.00000060, 1.0, 'wildcard','Estimation — le coût réel est horaire'),
-- ── Voix / média (déjà consommés par le produit) ────────────────────────────
('deepgram','nova','minute',                 0.00400000, 1.2, 'contains','Transcription — multiplicateur 1,2 (usage temps réel)'),
('deepgram','*','minute',                    0.00500000, 1.2, 'wildcard',null),
('fal','flux','image',                       0.02500000, 1.3, 'contains','Génération d''image — multiplicateur 1,3'),
('fal','*','second',                         0.05000000, 1.3, 'wildcard','Vidéo — facturée à la seconde générée'),
('openai','gpt-image','image',               0.04000000, 1.3, 'contains',null),
-- ── Stockage — la limite de plan est dure, ce tarif sert au dépassement négocié ─
('storage','supabase','gb_month',            0.02100000, 1.0, 'contains','~0,021 €/Go/mois'),
-- ── Joker global : tout fournisseur branché sans tarif ──────────────────────
-- Délibérément 3 à 10× au-dessus du marché : une intégration oubliée doit
-- sur-facturer des crédits (visible en support) et jamais entamer la marge.
('*','*','token_in',                         0.00000200, 1.0, 'wildcard','TARIF JOKER — définir la vraie grille du fournisseur'),
('*','*','token_out',                        0.00000600, 1.0, 'wildcard','TARIF JOKER — définir la vraie grille du fournisseur'),
('*','*','token',                            0.00000200, 1.0, 'wildcard','TARIF JOKER'),
('*','*','request',                          0.00200000, 1.0, 'wildcard','TARIF JOKER'),
('*','*','second',                           0.00500000, 1.0, 'wildcard','TARIF JOKER'),
('*','*','minute',                           0.01000000, 1.0, 'wildcard','TARIF JOKER'),
('*','*','image',                            0.05000000, 1.0, 'wildcard','TARIF JOKER'),
('*','*','character',                        0.00001000, 1.0, 'wildcard','TARIF JOKER'),
('*','*','gb_month',                         0.03000000, 1.0, 'wildcard','TARIF JOKER')
on conflict do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- 16. Rattrapage : un abonnement pour chaque workspace existant
-- ════════════════════════════════════════════════════════════════════════════
-- Les anciens libellés de workspaces.plan (starter / team) n'existent plus dans
-- le catalogue : on les reporte sur l'offre équivalente plutôt que de rétrograder
-- un client payant vers Découverte.
insert into public.workspace_subscriptions (workspace_id, plan_code, included_credits, seats, overage_cap_credits)
select w.id, p.code, p.included_credits,
       greatest((select count(*) from public.workspace_members m where m.workspace_id = w.id), 1),
       0
  from public.workspaces w
  join public.billing_plans p on p.code = case coalesce(w.plan, 'free')
    when 'starter' then 'individual'
    when 'team'    then 'agencies'
    when 'scale'   then 'agencies'
    when 'pro'     then 'pro'
    when 'individual' then 'individual'
    when 'agencies'   then 'agencies'
    when 'enterprise' then 'enterprise'
    else 'free' end
 on conflict (workspace_id) do nothing;

do $$
begin
  begin alter publication supabase_realtime add table public.usage_counters; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.workspace_subscriptions; exception when duplicate_object then null; end;
end $$;
