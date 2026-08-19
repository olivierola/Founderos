-- 0200_stripe_webhook.sql
-- Webhook Stripe : le paiement devient une source de vérité serveur.
--
-- CE QUI MANQUAIT (dette assumée par 0194)
-- L'achat était appliqué au retour navigateur (`create-checkout` action
-- `confirm`). Ça marche pour le premier paiement — le client est là, il revient
-- sur la page. Ça ne couvre RIEN du cycle de vie suivant :
--   • le renouvellement mensuel (personne n'ouvre le navigateur le 1er du mois) ;
--   • l'échec de prélèvement (carte expirée) : le client garde ses crédits ;
--   • la résiliation depuis le portail Stripe : l'offre reste active chez nous ;
--   • le remboursement / l'impayé contesté : les crédits restent acquis.
-- Ces quatre trous sont des trous de revenu. Ils se ferment avec un webhook signé.
--
-- PRINCIPE
-- Stripe est la source de vérité de l'ÉTAT DE PAIEMENT ; nous restons la source
-- de vérité de l'ALLOCATION (crédits, limites). Le webhook traduit l'un en
-- l'autre, et chaque traduction est idempotente : Stripe redélivre le même
-- événement en cas de 500, et redélivre parfois un événement déjà traité.
--
-- TROIS VERROUS D'IDEMPOTENCE, à trois niveaux différents (une seule couche
-- laisserait toujours passer un cas) :
--   1. `billing_webhook_events` — le même `event_id` n'est traité qu'une fois ;
--   2. `billing_checkout_sessions` (0194) — la même session d'achat n'est
--      appliquée qu'une fois, que ce soit par le webhook OU par le retour
--      navigateur, les deux courses arrivant en parallèle ;
--   3. `billing_apply_renewal` — la même période n'est ré-allouée qu'une fois
--      (Stripe émet `invoice.paid` ET `invoice.payment_succeeded`).

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Journal des événements reçus (idempotence + audit)
-- ════════════════════════════════════════════════════════════════════════════
-- Conservé même pour les événements ignorés : quand un client affirme avoir
-- payé, la première question est « qu'est-ce que Stripe nous a envoyé, et
-- quand ». Sans ce journal la réponse est « on ne sait pas ».
create table if not exists public.billing_webhook_events (
  event_id text primary key,                 -- evt_… (identifiant Stripe)
  type text not null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  status text not null default 'received'
    check (status in ('received','processed','ignored','failed')),
  attempts int not null default 1,
  error text,
  -- Objet de l'événement uniquement (pas l'enveloppe) : suffisant pour rejouer
  -- à la main, et on ne stocke pas de données de carte — Stripe n'en envoie pas.
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists idx_billing_webhook_events_ws
  on public.billing_webhook_events(workspace_id, received_at desc);
create index if not exists idx_billing_webhook_events_status
  on public.billing_webhook_events(status, received_at desc) where status <> 'processed';

alter table public.billing_webhook_events enable row level security;
-- Aucune policy : journal interne (service_role uniquement).

comment on table public.billing_webhook_events is
  'Événements Stripe reçus. Clé primaire = event_id : le rejeu d''un webhook ne réapplique rien.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Colonnes d'état d'abonnement
-- ════════════════════════════════════════════════════════════════════════════
-- `cancel_at_period_end` : résilié mais payé jusqu'à la fin de période. L'UI doit
-- le dire — un client qui a résilié et voit « Offre actuelle : Pro » croit que sa
-- résiliation n'a pas été prise en compte, et rappelle le support.
alter table public.workspace_subscriptions
  add column if not exists cancel_at_period_end boolean not null default false;
-- Dernier échec de prélèvement : sert la relance (dunning) et le bandeau UI.
alter table public.workspace_subscriptions
  add column if not exists past_due_since timestamptz;
-- URL de la facture impayée : le bandeau « mettez à jour votre carte » doit
-- pointer quelque part. Fournie par Stripe (hosted_invoice_url).
alter table public.workspace_subscriptions
  add column if not exists payment_action_url text;
-- Cause machine du blocage. `block_reason` est lu tel quel par
-- `billing_check_quota` et affiché à l'utilisateur : y écrire un code technique
-- lui montrerait « payment_failed » en pleine interface. Les deux colonnes ont
-- donc deux publics différents.
alter table public.workspace_subscriptions
  add column if not exists block_code text;

-- Nouveaux types d'événements de facturation (le check de 0194 ne les connaît pas).
alter table public.billing_events drop constraint if exists billing_events_kind_check;
alter table public.billing_events add constraint billing_events_kind_check check (kind in (
  'period_rollover','threshold_80','threshold_100','blocked','unblocked',
  'topup','plan_change','overage_started','overage_capped',
  -- ajoutés par le webhook :
  'renewal','payment_failed','payment_recovered','subscription_updated',
  'subscription_canceled','refund','dispute'
));

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Résolution : d'un objet Stripe vers un workspace
-- ════════════════════════════════════════════════════════════════════════════
-- Trois chemins, du plus fiable au plus tolérant. Les métadonnées sont posées à
-- la création de la session ET sur l'abonnement (`subscription_data[metadata]`),
-- parce qu'un événement `customer.subscription.*` ne porte PAS les métadonnées
-- de la session de checkout — piège classique qui fait rater tous les
-- renouvellements.
create or replace function public.billing_workspace_for_stripe(
  p_workspace text default null,
  p_subscription text default null,
  p_customer text default null
) returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_ws uuid;
begin
  if coalesce(p_workspace, '') <> '' then
    begin
      v_ws := p_workspace::uuid;
    exception when invalid_text_representation then
      v_ws := null;
    end;
    if v_ws is not null and exists (select 1 from public.workspaces w where w.id = v_ws) then
      return v_ws;
    end if;
  end if;

  if coalesce(p_subscription, '') <> '' then
    select workspace_id into v_ws from public.workspace_subscriptions
     where stripe_subscription_id = p_subscription limit 1;
    if v_ws is not null then return v_ws; end if;
  end if;

  if coalesce(p_customer, '') <> '' then
    select workspace_id into v_ws from public.workspace_subscriptions
     where stripe_customer_id = p_customer limit 1;
    if v_ws is not null then return v_ws; end if;
  end if;

  return null;
end;
$$;

-- Prix Stripe → code d'offre. Permet de suivre un changement d'offre fait
-- depuis le portail Stripe (upgrade/downgrade hors de notre UI).
create or replace function public.billing_plan_for_price(p_price text)
returns text language sql stable security definer set search_path = public as $$
  select code from public.billing_plans
   where p_price is not null
     and (stripe_price_id = p_price or stripe_price_id_annual = p_price)
   limit 1;
$$;

-- Ces deux résolveurs ne servent qu'au webhook. Les laisser ouverts exposerait
-- une correspondance client Stripe → workspace à n'importe quel compte connecté.
revoke execute on function public.billing_workspace_for_stripe(text,text,text)
  from public, anon, authenticated;
revoke execute on function public.billing_plan_for_price(text) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Renouvellement (invoice.paid)
-- ════════════════════════════════════════════════════════════════════════════
-- La période de facturation vient de Stripe, pas de `now() + 1 month` : c'est
-- Stripe qui décide quand le client est débité, et deux horloges qui dérivent
-- finissent par allouer des crédits à côté de la facture.
--
-- Idempotent par la période : si `period_start` est déjà celle de la facture,
-- l'allocation a déjà eu lieu. Sans ce garde-fou, `invoice.paid` suivi de
-- `invoice.payment_succeeded` remettrait les compteurs à zéro deux fois — soit
-- un mois de crédits offert à chaque renouvellement.
create or replace function public.billing_apply_renewal(
  p_workspace uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_plan text default null,
  p_customer text default null,
  p_subscription text default null,
  p_invoice text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sub public.workspace_subscriptions;
  v_plan public.billing_plans;
  v_start timestamptz := coalesce(p_period_start, now());
  v_end   timestamptz := coalesce(p_period_end, coalesce(p_period_start, now()) + interval '1 month');
  v_was_late boolean;
begin
  v_sub := public.billing_current_period(p_workspace);
  v_was_late := v_sub.status = 'past_due' or coalesce(v_sub.block_code, '') = 'payment_failed';

  -- ── Effets INCONDITIONNELS d'un paiement réussi ──────────────────────────
  -- Séparés de l'allocation à dessein. Un client suspendu pour impayé qui met à
  -- jour sa carte doit être débloqué même si l'allocation, elle, a déjà eu lieu
  -- (la bascule automatique de `billing_current_period` a pu passer avant nous).
  -- Fusionner les deux laissait le client payer et rester suspendu.
  update public.workspace_subscriptions set
    status = 'active',
    -- Seul un blocage pour impayé se lève ici. Un blocage manuel (abus) ou un
    -- litige bancaire ne se lèvent pas parce qu'une facture est passée.
    hard_blocked = case when block_code = 'payment_failed' then false else hard_blocked end,
    block_reason = case when block_code = 'payment_failed' then null else block_reason end,
    block_code   = case when block_code = 'payment_failed' then null else block_code end,
    past_due_since = null,
    payment_action_url = null,
    stripe_customer_id = coalesce(p_customer, stripe_customer_id),
    stripe_subscription_id = coalesce(p_subscription, stripe_subscription_id),
    updated_at = now()
  where workspace_id = p_workspace;

  if v_was_late then
    insert into public.billing_events (workspace_id, kind, message, payload)
    values (p_workspace, 'payment_recovered', 'Paiement régularisé — accès rétabli',
            jsonb_build_object('invoice', p_invoice));
  end if;

  -- ── Allocation, une seule fois par période ───────────────────────────────
  if v_sub.period_start = v_start then
    return jsonb_build_object('ok', true, 'skipped', 'already_allocated',
                              'recovered', v_was_late, 'period_start', v_start);
  end if;

  select * into v_plan from public.billing_plans
   where code = coalesce(p_plan, v_sub.plan_code) and is_active;
  if not found then
    select * into v_plan from public.billing_plans where code = v_sub.plan_code;
  end if;

  update public.workspace_subscriptions set
    plan_code = v_plan.code,
    period_start = v_start,
    period_end = v_end,
    included_credits = v_plan.included_credits,
    overage_cap_credits = case when overage_enabled then v_plan.default_overage_cap_credits else 0 end,
    updated_at = now()
  where workspace_id = p_workspace;

  insert into public.billing_events (workspace_id, kind, message, payload)
  values (p_workspace, 'renewal',
          format('Renouvellement %s — %s crédits alloués', v_plan.name, v_plan.included_credits),
          jsonb_build_object('plan', v_plan.code, 'invoice', p_invoice,
                             'period_start', v_start, 'period_end', v_end,
                             'included_credits', v_plan.included_credits));

  return jsonb_build_object('ok', true, 'plan', v_plan.code,
                            'included_credits', v_plan.included_credits,
                            'recovered', v_was_late,
                            'period_start', v_start, 'period_end', v_end);
end;
$$;
revoke execute on function public.billing_apply_renewal(uuid,timestamptz,timestamptz,text,text,text,text)
  from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Échec de prélèvement (invoice.payment_failed)
-- ════════════════════════════════════════════════════════════════════════════
-- On ne coupe PAS au premier échec : une carte refusée est le plus souvent un
-- plafond mensuel, pas un client parti. Stripe relance quatre fois sur ~2
-- semaines. On marque `past_due` (l'UI affiche la bannière et le lien de
-- paiement) et on ne bloque qu'à l'épuisement des relances — signalé par Stripe
-- avec `next_payment_attempt = null`.
create or replace function public.billing_mark_payment_failed(
  p_workspace uuid,
  p_invoice text default null,
  p_hosted_url text default null,
  p_final boolean default false,
  p_amount_cents int default null
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.billing_current_period(p_workspace);

  update public.workspace_subscriptions set
    status = 'past_due',
    past_due_since = coalesce(past_due_since, now()),
    payment_action_url = coalesce(p_hosted_url, payment_action_url),
    hard_blocked = case when p_final then true else hard_blocked end,
    block_reason = case when p_final
      then 'Paiement refusé après plusieurs tentatives. Mettez à jour votre moyen de paiement pour rétablir l''accès.'
      else block_reason end,
    block_code = case when p_final then 'payment_failed' else block_code end,
    updated_at = now()
  where workspace_id = p_workspace;

  insert into public.billing_events (workspace_id, kind, message, payload)
  values (p_workspace, 'payment_failed',
          case when p_final
            then 'Paiement définitivement refusé — espace suspendu'
            else 'Échec de prélèvement — mise à jour du moyen de paiement requise' end,
          jsonb_build_object('invoice', p_invoice, 'final', p_final,
                             'amount_cents', p_amount_cents, 'url', p_hosted_url));

  return jsonb_build_object('ok', true, 'final', p_final);
end;
$$;
revoke execute on function public.billing_mark_payment_failed(uuid,text,text,boolean,int)
  from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Synchronisation d'état (customer.subscription.updated)
-- ════════════════════════════════════════════════════════════════════════════
-- Un abonnement peut changer hors de notre UI : portail client Stripe, geste
-- commercial fait au Dashboard Stripe, pause de prélèvement. Cette fonction
-- recopie l'état sans toucher à l'allocation en cours — seule `invoice.paid`
-- alloue des crédits. Un changement d'offre non payé ne doit rien créditer.
create or replace function public.billing_sync_subscription(
  p_workspace uuid,
  p_status text default null,
  p_plan text default null,
  p_cancel_at_period_end boolean default null,
  p_period_end timestamptz default null,
  p_customer text default null,
  p_subscription text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sub public.workspace_subscriptions;
  v_plan public.billing_plans;
  v_status text;
begin
  v_sub := public.billing_current_period(p_workspace);

  -- Statuts Stripe → les nôtres. `incomplete`/`unpaid` n'ont pas d'équivalent :
  -- on les traite comme un impayé plutôt que d'élargir le check contraint.
  v_status := case coalesce(p_status, v_sub.status)
    when 'trialing' then 'trialing'
    when 'active' then 'active'
    when 'past_due' then 'past_due'
    when 'unpaid' then 'past_due'
    when 'incomplete' then 'past_due'
    when 'incomplete_expired' then 'canceled'
    when 'canceled' then 'canceled'
    when 'paused' then 'paused'
    else v_sub.status end;

  if p_plan is not null then
    select * into v_plan from public.billing_plans where code = p_plan and is_active;
  end if;

  update public.workspace_subscriptions set
    status = v_status,
    -- L'offre suit le prix Stripe, mais l'allocation reste celle de la période
    -- payée : monter d'offre au portail ne crédite qu'au prochain `invoice.paid`.
    plan_code = coalesce(v_plan.code, plan_code),
    cancel_at_period_end = coalesce(p_cancel_at_period_end, cancel_at_period_end),
    period_end = coalesce(p_period_end, period_end),
    past_due_since = case when v_status = 'past_due' then coalesce(past_due_since, now()) else null end,
    payment_action_url = case when v_status = 'past_due' then payment_action_url else null end,
    stripe_customer_id = coalesce(p_customer, stripe_customer_id),
    stripe_subscription_id = coalesce(p_subscription, stripe_subscription_id),
    updated_at = now()
  where workspace_id = p_workspace;

  if v_status is distinct from v_sub.status
     or coalesce(p_cancel_at_period_end, v_sub.cancel_at_period_end) is distinct from v_sub.cancel_at_period_end
     or (v_plan.code is not null and v_plan.code <> v_sub.plan_code) then
    insert into public.billing_events (workspace_id, kind, message, payload)
    values (p_workspace, 'subscription_updated',
            format('Abonnement mis à jour (%s)', v_status),
            jsonb_build_object('from_status', v_sub.status, 'to_status', v_status,
                               'from_plan', v_sub.plan_code, 'to_plan', coalesce(v_plan.code, v_sub.plan_code),
                               'cancel_at_period_end', coalesce(p_cancel_at_period_end, v_sub.cancel_at_period_end)));
  end if;

  return jsonb_build_object('ok', true, 'status', v_status,
                            'plan', coalesce(v_plan.code, v_sub.plan_code));
end;
$$;
revoke execute on function public.billing_sync_subscription(uuid,text,text,boolean,timestamptz,text,text)
  from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Fin d'abonnement (customer.subscription.deleted)
-- ════════════════════════════════════════════════════════════════════════════
-- Retour à l'offre Découverte, PAS un blocage. Stripe n'envoie cet événement
-- qu'une fois la période payée écoulée : à cet instant le client ne doit plus
-- rien, mais son travail (agents, collections, historique) lui appartient encore.
-- Le couper net transformerait une résiliation en perte de données perçue ; le
-- faire retomber sur le plan gratuit laisse la porte ouverte au retour.
--
-- Les crédits de packs prépayés (`topup_credits`) SURVIVENT : ils ont été payés
-- comptant, ils ne sont pas liés à l'abonnement.
create or replace function public.billing_end_subscription(
  p_workspace uuid, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prev text;
  v_free public.billing_plans;
begin
  perform public.billing_current_period(p_workspace);
  select plan_code into v_prev from public.workspace_subscriptions where workspace_id = p_workspace;
  select * into v_free from public.billing_plans where code = 'free';

  update public.workspace_subscriptions set
    plan_code = 'free',
    status = 'active',
    included_credits = coalesce(v_free.included_credits, 0),
    period_start = now(),
    period_end = now() + interval '1 month',
    overage_enabled = false,
    overage_cap_credits = 0,
    cancel_at_period_end = false,
    past_due_since = null,
    payment_action_url = null,
    stripe_subscription_id = null,
    updated_at = now()
  where workspace_id = p_workspace;

  insert into public.billing_events (workspace_id, kind, message, payload)
  values (p_workspace, 'subscription_canceled',
          'Abonnement terminé — retour à l''offre Découverte',
          jsonb_build_object('from', v_prev, 'reason', p_reason));

  return jsonb_build_object('ok', true, 'from', v_prev, 'to', 'free');
end;
$$;
revoke execute on function public.billing_end_subscription(uuid,text) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Remboursement / impayé contesté
-- ════════════════════════════════════════════════════════════════════════════
-- Un pack remboursé rend ses crédits : sans ça, rembourser un client lui laisse
-- la marchandise. Plancher à zéro — s'il a déjà consommé, on ne creuse pas une
-- dette négative qui bloquerait silencieusement le prochain achat.
create or replace function public.billing_revoke_credits(
  p_workspace uuid, p_credits numeric, p_reference text default null, p_kind text default 'refund'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_balance numeric; v_revoked numeric;
begin
  perform public.billing_current_period(p_workspace);
  select topup_credits into v_balance from public.workspace_subscriptions where workspace_id = p_workspace;
  v_revoked := least(greatest(coalesce(p_credits, 0), 0), coalesce(v_balance, 0));

  update public.workspace_subscriptions
     set topup_credits = greatest(coalesce(topup_credits, 0) - v_revoked, 0), updated_at = now()
   where workspace_id = p_workspace
   returning topup_credits into v_balance;

  insert into public.billing_events (workspace_id, kind, message, payload)
  values (p_workspace, p_kind,
          format('%s crédits repris (remboursement)', v_revoked::bigint),
          jsonb_build_object('credits', v_revoked, 'requested', p_credits, 'reference', p_reference));

  return jsonb_build_object('ok', true, 'revoked', v_revoked, 'topup_credits', v_balance);
end;
$$;
revoke execute on function public.billing_revoke_credits(uuid,numeric,text,text) from public, anon, authenticated;

-- Litige bancaire (chargeback) : suspension immédiate. Ce n'est pas un incident
-- de paiement, c'est une transaction contestée — la relance douce ne s'applique pas.
create or replace function public.billing_block_for_dispute(
  p_workspace uuid, p_charge text default null, p_amount_cents int default null
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.billing_current_period(p_workspace);
  update public.workspace_subscriptions
     set hard_blocked = true,
         block_reason = 'Paiement contesté auprès de la banque. Contactez le support pour rétablir l''accès.',
         block_code = 'dispute',
         updated_at = now()
   where workspace_id = p_workspace;

  insert into public.billing_events (workspace_id, kind, message, payload)
  values (p_workspace, 'dispute', 'Paiement contesté — espace suspendu',
          jsonb_build_object('charge', p_charge, 'amount_cents', p_amount_cents));

  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.billing_block_for_dispute(uuid,text,int) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Exposition à l'UI
-- ════════════════════════════════════════════════════════════════════════════
-- `billing_entitlements` (0194) ne renvoie ni la résiliation programmée ni le
-- lien de régularisation : sans eux l'UI ne peut pas afficher l'état réel de
-- l'abonnement. On étend l'objet `subscription` sans toucher au reste.
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
      'trial_ends_at', v_sub.trial_ends_at,
      'cancel_at_period_end', v_sub.cancel_at_period_end,
      'past_due_since', v_sub.past_due_since,
      'payment_action_url', v_sub.payment_action_url,
      -- L'UI a besoin de savoir s'il existe un abonnement Stripe à gérer (le
      -- bouton « gérer mon abonnement » n'a pas de sens sur l'offre gratuite).
      -- L'identifiant lui-même n'est pas exposé : il ne lui sert à rien.
      'has_stripe_subscription', v_sub.stripe_subscription_id is not null,
      'has_stripe_customer', v_sub.stripe_customer_id is not null),
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
