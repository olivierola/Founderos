// stripe-webhook — endpoint signé qui fait de Stripe la source de vérité du
// paiement. Complète `create-checkout`, qui ne couvrait que le premier achat.
//
// CE QU'IL FERME
//   checkout.session.completed          → offre activée / crédits ajoutés
//   checkout.session.async_payment_*    → virement SEPA : payé plus tard, ou pas
//   invoice.paid                        → RENOUVELLEMENT (personne n'ouvre le
//                                         navigateur le 1er du mois)
//   invoice.payment_failed              → impayé : bandeau, puis suspension à
//                                         l'épuisement des relances Stripe
//   customer.subscription.updated       → résiliation programmée, pause,
//                                         changement d'offre au portail
//   customer.subscription.deleted       → fin d'abonnement → offre Découverte
//   charge.refunded                     → crédits repris
//   charge.dispute.created              → suspension (chargeback)
//
// CONFIGURATION (une fois)
//   1. Stripe Dashboard → Developers → Webhooks → « Add endpoint »
//      URL : https://<projet>.supabase.co/functions/v1/stripe-webhook
//      Événements : les huit ci-dessus.
//   2. `supabase secrets set FOUNDEROS_STRIPE_WEBHOOK_SECRET=whsec_…`
//   3. Déployer avec --no-verify-jwt (Stripe n'envoie pas de JWT Supabase).
//
// CONTRAT DE RÉPONSE — c'est ce qui fait la robustesse :
//   200  traité, ignoré, ou déjà vu   → Stripe passe à la suite
//   400  signature invalide           → requête rejetée, aucune relance utile
//   500  erreur de traitement         → Stripe RELANCE (jusqu'à 3 jours)
// Renvoyer 200 sur une erreur perdrait l'événement définitivement : un
// renouvellement raté deviendrait un client sans crédits, sans trace.

import { createServiceClient } from "../_shared/supabase-admin.ts";
import { applyCheckoutSession, stripeApi, stripeId, verifyStripeSignature } from "../_shared/billing-stripe.ts";
import type { StripeCheckoutSession } from "../_shared/billing-stripe.ts";

type Json = Record<string, unknown>;

const WEBHOOK_SECRET = () =>
  Deno.env.get("FOUNDEROS_STRIPE_WEBHOOK_SECRET") ?? Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

// Événements traités. Tout le reste est journalisé « ignored » : un endpoint
// abonné à plus large que nécessaire ne doit pas produire d'erreurs.
const HANDLED = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
  "charge.dispute.created",
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ts = (unix: unknown): string | null =>
  typeof unix === "number" && unix > 0 ? new Date(unix * 1000).toISOString() : null;

// ── Compatibilité de version d'API ───────────────────────────────────────────
// Stripe déplace des champs entre versions majeures, et un compte peut recevoir
// les webhooks dans une version différente de celle de nos appels REST. Deux
// déplacements nous concernent :
//   • `invoice.subscription` → `invoice.parent.subscription_details.subscription`
//   • `subscription.current_period_*` → `subscription.items.data[].current_period_*`
// On lit les deux emplacements. Un webhook qui casse à la prochaine montée de
// version, c'est un mois de renouvellements perdus avant qu'on s'en aperçoive.

function invoiceSubscriptionId(inv: Json): string | null {
  const direct = stripeId(inv.subscription);
  if (direct) return direct;
  const parent = inv.parent as { subscription_details?: { subscription?: unknown } } | undefined;
  return stripeId(parent?.subscription_details?.subscription);
}

function subscriptionPeriod(sub: Json): { start: string | null; end: string | null } {
  const item = ((sub.items as { data?: Array<Json> } | undefined)?.data ?? [])[0];
  return {
    start: ts(sub.current_period_start) ?? ts(item?.current_period_start),
    end: ts(sub.current_period_end) ?? ts(item?.current_period_end),
  };
}

type Admin = ReturnType<typeof createServiceClient>;

/** Métadonnées d'un objet Stripe, quel que soit son type. */
function metaOf(obj: Json): Record<string, string> {
  return (obj.metadata ?? {}) as Record<string, string>;
}

/**
 * À quel workspace se rattache cet objet ?
 *
 * Les métadonnées d'abord (posées à la création de la session ET sur
 * l'abonnement), puis les identifiants Stripe déjà enregistrés. Un événement
 * `customer.subscription.*` ne porte PAS les métadonnées de la session de
 * checkout : sans le repli par abonnement/client, tous les renouvellements
 * tomberaient dans le vide.
 */
async function resolveWorkspace(
  admin: Admin,
  obj: Json,
  hints: { subscription?: string | null; customer?: string | null } = {},
): Promise<string | null> {
  const meta = metaOf(obj);
  const { data } = await admin.rpc("billing_workspace_for_stripe", {
    p_workspace: meta.workspace_id ?? (obj.client_reference_id as string | null) ?? null,
    p_subscription: hints.subscription ?? stripeId(obj.subscription) ?? null,
    p_customer: hints.customer ?? stripeId(obj.customer) ?? null,
  });
  return (data as string | null) ?? null;
}

/** Code d'offre correspondant au prix d'un abonnement Stripe. */
async function planForSubscription(admin: Admin, sub: Json): Promise<string | null> {
  const items = (sub.items as { data?: Array<{ price?: { id?: string } }> } | undefined)?.data ?? [];
  const priceId = items[0]?.price?.id;
  if (!priceId) return null;
  const { data } = await admin.rpc("billing_plan_for_price", { p_price: priceId });
  return (data as string | null) ?? null;
}

// ── Traitement d'un événement ────────────────────────────────────────────────
// Renvoie un résumé (journalisé) ou lève : lever = 500 = Stripe relance.
async function handleEvent(
  admin: Admin,
  type: string,
  obj: Json,
): Promise<{ workspace_id: string | null; summary: Json }> {
  switch (type) {
    // ── Achat ponctuel ou souscription initiale ──────────────────────────────
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = obj as unknown as StripeCheckoutSession;
      // Le virement SEPA passe par `completed` AVANT d'être payé : appliquer là
      // offrirait l'offre à qui n'a encore rien versé.
      if (session.payment_status === "unpaid") {
        return {
          workspace_id: await resolveWorkspace(admin, obj),
          summary: { skipped: "payment_pending", session: session.id },
        };
      }
      const res = await applyCheckoutSession(admin, session);
      if (!res.ok) throw new Error(res.error ?? "application de la session impossible");
      return {
        workspace_id: res.workspace_id ?? null,
        summary: { applied: res.applied ?? null, already_applied: !!res.already_applied },
      };
    }

    case "checkout.session.async_payment_failed": {
      const ws = await resolveWorkspace(admin, obj);
      // Rien à défaire : sans paiement, rien n'a été appliqué. On trace pour que
      // le support sache pourquoi le client dit avoir payé et n'a rien reçu.
      if (ws) {
        await admin.from("billing_events").insert({
          workspace_id: ws,
          kind: "payment_failed",
          message: "Paiement différé refusé — aucun crédit n'a été ajouté",
          payload: { session: obj.id },
        });
      }
      return { workspace_id: ws, summary: { logged: "async_payment_failed" } };
    }

    // ── Renouvellement mensuel ───────────────────────────────────────────────
    case "invoice.paid": {
      const subId = invoiceSubscriptionId(obj);
      const customerId = stripeId(obj.customer);
      // Une facture hors abonnement (paiement unique facturé) n'alloue rien :
      // les packs passent par la session de checkout, déjà traitée plus haut.
      if (!subId) return { workspace_id: null, summary: { skipped: "no_subscription" } };

      // L'abonnement est lu une fois : il porte l'offre souscrite (le prix n'est
      // pas sur la facture sous une forme exploitable), nos métadonnées, et au
      // besoin la période de repli.
      const sub = await stripeApi<Json>(`subscriptions/${subId}`);
      const plan = await planForSubscription(admin, sub);

      // La première facture peut arriver AVANT `checkout.session.completed` —
      // Stripe ne garantit pas l'ordre. Le workspace n'est alors pas encore
      // rattaché à ce client : on le lit sur les métadonnées de l'abonnement,
      // recopiées à la création de la session.
      const ws = await resolveWorkspace(admin, obj, { subscription: subId, customer: customerId })
        ?? await resolveWorkspace(admin, sub, { subscription: subId, customer: customerId });
      if (!ws) return { workspace_id: null, summary: { skipped: "workspace_introuvable" } };

      // La période vient de la ligne de facture : c'est la période RÉELLEMENT
      // payée. `period_end` de l'abonnement bouge en cours de route (upgrade,
      // proratisation), la ligne de facture non.
      const line = ((obj.lines as { data?: Array<{ period?: { start?: number; end?: number } }> })
        ?.data ?? [])[0];
      let start = ts(line?.period?.start);
      let end = ts(line?.period?.end);

      // Certaines factures (première période d'un essai) n'ont pas de période
      // de ligne exploitable — on la lit alors sur l'abonnement.
      if (!start || !end || start === end) {
        const period = subscriptionPeriod(sub);
        start = period.start ?? new Date().toISOString();
        end = period.end ?? new Date(Date.now() + 30 * 86_400_000).toISOString();
      }

      const { data, error } = await admin.rpc("billing_apply_renewal", {
        p_workspace: ws,
        p_period_start: start,
        p_period_end: end,
        p_plan: plan,
        p_customer: customerId,
        p_subscription: subId,
        p_invoice: obj.id as string,
      });
      if (error) throw new Error(error.message);
      return { workspace_id: ws, summary: (data ?? {}) as Json };
    }

    // ── Impayé ───────────────────────────────────────────────────────────────
    case "invoice.payment_failed": {
      const ws = await resolveWorkspace(admin, obj, {
        subscription: invoiceSubscriptionId(obj),
        customer: stripeId(obj.customer),
      });
      if (!ws) return { workspace_id: null, summary: { skipped: "workspace_introuvable" } };

      // Stripe relance 4 fois sur ~2 semaines ; `next_payment_attempt = null`
      // signale la dernière. Suspendre avant, c'est couper un client dont la
      // carte serait repassée deux jours plus tard.
      const isFinal = obj.next_payment_attempt == null;
      const { error } = await admin.rpc("billing_mark_payment_failed", {
        p_workspace: ws,
        p_invoice: (obj.id as string) ?? null,
        p_hosted_url: (obj.hosted_invoice_url as string) ?? null,
        p_final: isFinal,
        p_amount_cents: (obj.amount_due as number) ?? null,
      });
      if (error) throw new Error(error.message);
      return { workspace_id: ws, summary: { past_due: true, final: isFinal } };
    }

    // ── Cycle de vie de l'abonnement ─────────────────────────────────────────
    case "customer.subscription.updated": {
      const ws = await resolveWorkspace(admin, obj, {
        subscription: (obj.id as string) ?? null,
        customer: stripeId(obj.customer),
      });
      if (!ws) return { workspace_id: null, summary: { skipped: "workspace_introuvable" } };

      const paused = (obj.pause_collection as Json | null) != null;
      const { data, error } = await admin.rpc("billing_sync_subscription", {
        p_workspace: ws,
        p_status: paused ? "paused" : ((obj.status as string) ?? null),
        p_plan: await planForSubscription(admin, obj),
        p_cancel_at_period_end: !!obj.cancel_at_period_end,
        p_period_end: subscriptionPeriod(obj).end,
        p_customer: stripeId(obj.customer),
        p_subscription: (obj.id as string) ?? null,
      });
      if (error) throw new Error(error.message);
      return { workspace_id: ws, summary: (data ?? {}) as Json };
    }

    case "customer.subscription.deleted": {
      const ws = await resolveWorkspace(admin, obj, {
        subscription: (obj.id as string) ?? null,
        customer: stripeId(obj.customer),
      });
      if (!ws) return { workspace_id: null, summary: { skipped: "workspace_introuvable" } };
      const { data, error } = await admin.rpc("billing_end_subscription", {
        p_workspace: ws,
        p_reason: (obj.cancellation_details as { reason?: string } | null)?.reason ?? "stripe",
      });
      if (error) throw new Error(error.message);
      return { workspace_id: ws, summary: (data ?? {}) as Json };
    }

    // ── Remboursement : reprendre la marchandise ─────────────────────────────
    case "charge.refunded": {
      const ws = await resolveWorkspace(admin, obj, { customer: stripeId(obj.customer) });
      if (!ws) return { workspace_id: null, summary: { skipped: "workspace_introuvable" } };

      // Retrouver le pack via la session de checkout du paiement remboursé : le
      // nombre de crédits à reprendre est celui du pack, pas une règle de trois
      // sur le montant (les prix Stripe peuvent porter des remises).
      const paymentIntent = stripeId(obj.payment_intent);
      let credits = 0;
      let reference: string | null = null;
      if (paymentIntent) {
        const sessions = await stripeApi<{ data?: StripeCheckoutSession[] }>(
          `checkout/sessions?payment_intent=${encodeURIComponent(paymentIntent)}&limit=1`,
        );
        const session = sessions.data?.[0];
        const packCode = session?.metadata?.pack;
        if (session) reference = session.id;
        if (packCode) {
          const { data: pack } = await admin
            .from("credit_packs").select("credits").eq("code", packCode).maybeSingle();
          credits = Number(pack?.credits ?? 0);
          // Remboursement partiel : on reprend au prorata du montant rendu.
          // `amount_refunded` est CUMULÉ : deux remboursements partiels
          // successifs reprennent donc un peu large. `billing_revoke_credits`
          // plafonne à la réserve disponible et ne creuse jamais de solde
          // négatif — tenir un journal de remboursements pour ce cas de bord
          // coûterait plus cher que le cas lui-même.
          const total = Number(obj.amount ?? 0);
          const refunded = Number(obj.amount_refunded ?? 0);
          if (total > 0 && refunded > 0 && refunded < total) {
            credits = Math.floor((credits * refunded) / total);
          }
        }
      }

      if (credits > 0) {
        const { error } = await admin.rpc("billing_revoke_credits", {
          p_workspace: ws, p_credits: credits, p_reference: reference ?? (obj.id as string),
          p_kind: "refund",
        });
        if (error) throw new Error(error.message);
      } else {
        // Remboursement d'un abonnement : rien à reprendre côté packs, mais
        // l'événement doit rester lisible dans l'historique de facturation.
        await admin.from("billing_events").insert({
          workspace_id: ws, kind: "refund",
          message: "Paiement remboursé",
          payload: { charge: obj.id, amount_refunded: obj.amount_refunded },
        });
      }
      return { workspace_id: ws, summary: { revoked_credits: credits } };
    }

    case "charge.dispute.created": {
      // Un litige ne porte pas de `customer` : il faut remonter au paiement
      // contesté pour savoir qui est concerné.
      const chargeId = stripeId(obj.charge);
      let customerId: string | null = null;
      if (chargeId) {
        const charge = await stripeApi<Json>(`charges/${encodeURIComponent(chargeId)}`).catch(() => null);
        customerId = charge ? stripeId(charge.customer) : null;
      }
      const ws = await resolveWorkspace(admin, obj, { customer: customerId });
      if (!ws) return { workspace_id: null, summary: { skipped: "workspace_introuvable" } };
      const { error } = await admin.rpc("billing_block_for_dispute", {
        p_workspace: ws,
        p_charge: chargeId ?? (obj.id as string),
        p_amount_cents: (obj.amount as number) ?? null,
      });
      if (error) throw new Error(error.message);
      return { workspace_id: ws, summary: { blocked: true } };
    }

    default:
      return { workspace_id: null, summary: { ignored: type } };
  }
}

Deno.serve(async (req) => {
  // Pas de CORS : aucun navigateur n'appelle cet endpoint, seul Stripe le fait.
  if (req.method !== "POST") return json({ error: "POST attendu" }, 405);

  // Le corps BRUT, avant tout parse : la signature couvre les octets reçus.
  const raw = await req.text();

  const verdict = await verifyStripeSignature(
    raw,
    req.headers.get("stripe-signature"),
    WEBHOOK_SECRET(),
  );
  if (!verdict.ok) {
    console.error("[stripe-webhook] signature rejetée:", verdict.reason);
    return json({ error: `Signature refusée: ${verdict.reason}` }, 400);
  }

  let event: { id?: string; type?: string; data?: { object?: Json } };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "Corps illisible" }, 400);
  }

  const eventId = event.id ?? "";
  const type = event.type ?? "";
  const obj = (event.data?.object ?? {}) as Json;
  if (!eventId || !type) return json({ error: "Événement sans id ni type" }, 400);

  const admin = createServiceClient();

  // ── Verrou d'idempotence ───────────────────────────────────────────────────
  // Stripe redélivre : après un 500, après un timeout, et parfois sans raison.
  // La clé primaire arbitre. Une livraison déjà traitée repart en 200 sans
  // rejouer l'effet ; une livraison précédemment en échec est REJOUÉE, sinon un
  // renouvellement perdu le resterait.
  const { error: lockErr } = await admin.from("billing_webhook_events").insert({
    event_id: eventId, type, payload: obj,
  });
  if (lockErr) {
    if (lockErr.code !== "23505") {
      console.error("[stripe-webhook] journal indisponible:", lockErr.message);
      return json({ error: "Journal d'événements indisponible" }, 500);
    }
    const { data: prev } = await admin
      .from("billing_webhook_events")
      .select("status, attempts, received_at")
      .eq("event_id", eventId).maybeSingle();

    if (prev && (prev.status === "processed" || prev.status === "ignored")) {
      return json({ ok: true, already_processed: true, event: eventId });
    }
    // Statut « received » récent = une autre livraison est en cours de
    // traitement. Deux traitements simultanés du même événement se marcheraient
    // dessus ; on laisse la première finir (Stripe ne relance pas un 200).
    const startedAt = prev?.received_at ? Date.parse(prev.received_at) : 0;
    if (prev?.status === "received" && Date.now() - startedAt < 120_000) {
      return json({ ok: true, in_flight: true, event: eventId });
    }
    await admin.from("billing_webhook_events")
      .update({ status: "received", attempts: (prev?.attempts ?? 1) + 1, error: null })
      .eq("event_id", eventId);
  }

  if (!HANDLED.has(type)) {
    await admin.from("billing_webhook_events")
      .update({ status: "ignored", processed_at: new Date().toISOString() })
      .eq("event_id", eventId);
    return json({ ok: true, ignored: type });
  }

  try {
    const { workspace_id, summary } = await handleEvent(admin, type, obj);
    await admin.from("billing_webhook_events").update({
      status: "processed",
      workspace_id,
      processed_at: new Date().toISOString(),
      error: null,
    }).eq("event_id", eventId);
    return json({ ok: true, event: eventId, type, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[stripe-webhook] ${type} (${eventId}):`, msg);
    await admin.from("billing_webhook_events").update({
      status: "failed", error: msg.slice(0, 500),
    }).eq("event_id", eventId);
    // 500 volontaire : Stripe relance. Un événement d'argent perdu ne se
    // rattrape pas tout seul.
    return json({ error: msg }, 500);
  }
});
