// create-checkout — Stripe Checkout pour les offres Anduran et les packs de crédits.
// Utilise la clé du compte Stripe d'Anduran (FOUNDEROS_STRIPE_SECRET_KEY, ou à
// défaut STRIPE_SECRET_KEY), jamais celle d'un workspace.
//
// Body:
//   { workspace_id, plan }               → session d'abonnement
//   { workspace_id, pack }               → session de paiement unique (recharge)
//   { workspace_id, action: "confirm", session_id } → applique l'achat au retour
//   { workspace_id, action: "portal" }   → portail client Stripe (carte,
//                                          factures, résiliation)
//
// Les prix ne sont plus dans le code : ils viennent de billing_plans /
// credit_packs (migration 0194), qui portent aussi les crédits inclus. Une
// grille tarifaire qui vit à deux endroits finit toujours par diverger.
//
// `confirm` n'est plus le seul chemin d'application : `stripe-webhook`
// (migration 0200) applique les mêmes achats côté serveur, et prend en charge
// tout ce que le retour navigateur ne peut pas voir (renouvellements, échecs de
// paiement, résiliations). Les deux passent par `applyCheckoutSession`, dont le
// verrou d'idempotence arbitre la course. `confirm` reste utile : il rend la
// page de retour immédiatement juste, sans attendre la livraison du webhook.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { applyCheckoutSession, stripeApi } from "../_shared/billing-stripe.ts";
import type { StripeCheckoutSession } from "../_shared/billing-stripe.ts";

const APP_URL = () => Deno.env.get("APP_URL") ?? "http://localhost:5173";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, plan, pack, action, session_id, return_path } = await req.json();
    if (!workspace_id) return jsonResponse({ error: "workspace_id requis" }, { status: 400 });

    const admin = createServiceClient();
    const { data: m } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!m || m.role !== "owner") {
      return jsonResponse({ error: "Seul le propriétaire peut gérer l'abonnement" }, { status: 403 });
    }

    // ── Appliquer un achat au retour de Stripe ───────────────────────────────
    if (action === "confirm") {
      if (!session_id) return jsonResponse({ error: "session_id requis" }, { status: 400 });
      const session = await stripeApi<StripeCheckoutSession>(
        `checkout/sessions/${encodeURIComponent(String(session_id))}`,
      );
      if (session.payment_status !== "paid" && session.status !== "complete") {
        return jsonResponse({ ok: false, pending: true, status: session.status }, { status: 202 });
      }

      // Le workspace vient des métadonnées de la session, jamais du corps de la
      // requête : sinon n'importe quel owner pourrait créditer son workspace
      // avec l'identifiant d'une session payée par quelqu'un d'autre. C'est
      // `applyCheckoutSession` qui compare les deux.
      const res = await applyCheckoutSession(admin, session, String(workspace_id));
      if (!res.ok) {
        const forbidden = res.error?.includes("ne concerne pas");
        return jsonResponse({ error: res.error }, { status: forbidden ? 403 : 400 });
      }
      return jsonResponse({
        ok: true,
        applied: res.applied,
        already_applied: res.already_applied ?? false,
        result: res.result,
      });
    }

    // ── Portail client Stripe ────────────────────────────────────────────────
    // Moyen de paiement, factures, résiliation : tout ce qui suit l'achat vit
    // là-bas. Le reconstruire chez nous demanderait de manipuler des données de
    // carte — le portail hébergé est aussi la réponse la plus sûre.
    // Les changements faits dans le portail nous reviennent par webhook.
    if (action === "portal") {
      const { data: sub } = await admin
        .from("workspace_subscriptions")
        .select("stripe_customer_id")
        .eq("workspace_id", workspace_id).maybeSingle();
      if (!sub?.stripe_customer_id) {
        return jsonResponse(
          {
            error: "Aucun abonnement à gérer",
            detail: "Cet espace n'a pas encore de paiement enregistré.",
          },
          { status: 400 },
        );
      }
      const form = new URLSearchParams({
        customer: sub.stripe_customer_id,
        return_url: `${APP_URL()}${typeof return_path === "string" && return_path.startsWith("/") ? return_path : "/app"}`,
      });
      const portal = await stripeApi<{ url: string }>("billing_portal/sessions", {
        method: "POST", form,
      });
      return jsonResponse({ ok: true, url: portal.url });
    }

    // ── Créer une session de paiement ────────────────────────────────────────
    if (!plan && !pack) return jsonResponse({ error: "plan ou pack requis" }, { status: 400 });

    let priceId: string | null = null;
    let mode: "subscription" | "payment" = "subscription";
    const metadata: Record<string, string> = { workspace_id };

    if (plan) {
      const { data: row } = await admin
        .from("billing_plans")
        .select("code, name, stripe_price_id, is_quote, price_cents_eur")
        .eq("code", plan).eq("is_active", true).maybeSingle();
      if (!row) return jsonResponse({ error: "Offre inconnue" }, { status: 400 });
      if (row.is_quote) {
        return jsonResponse(
          { error: "Cette offre se souscrit sur devis", detail: "Contactez l'équipe commerciale." },
          { status: 400 },
        );
      }
      priceId = row.stripe_price_id;
      mode = "subscription";
      metadata.plan = row.code;
    } else {
      const { data: row } = await admin
        .from("credit_packs").select("code, name, stripe_price_id").eq("code", pack)
        .eq("is_active", true).maybeSingle();
      if (!row) return jsonResponse({ error: "Pack inconnu" }, { status: 400 });
      priceId = row.stripe_price_id;
      mode = "payment";
      metadata.pack = row.code;
    }

    if (!priceId) {
      return jsonResponse(
        {
          error: "Paiement pas encore configuré",
          detail: `Aucun price Stripe pour « ${plan ?? pack} ». Renseignez stripe_price_id dans ${plan ? "billing_plans" : "credit_packs"}.`,
        },
        { status: 503 },
      );
    }

    const { data: currentSub } = await admin
      .from("workspace_subscriptions")
      .select("stripe_customer_id, stripe_subscription_id")
      .eq("workspace_id", workspace_id).maybeSingle();

    // ── Changement d'offre d'un client déjà abonné ───────────────────────────
    // Une nouvelle session de checkout créerait un SECOND abonnement Stripe : le
    // client paierait deux offres, et deux `invoice.paid` se disputeraient son
    // plan. On modifie donc l'abonnement existant.
    // `always_invoice` facture le prorata immédiatement, ce qui déclenche
    // `invoice.paid` et donc l'allocation tout de suite : sans ça, un client qui
    // monte d'offre paierait aujourd'hui pour des crédits le mois prochain.
    if (mode === "subscription" && currentSub?.stripe_subscription_id) {
      const existingSub = await stripeApi<{
        id: string;
        status: string;
        items?: { data?: Array<{ id: string; price?: { id?: string } }> };
      }>(`subscriptions/${encodeURIComponent(currentSub.stripe_subscription_id)}`).catch(() => null);

      const item = existingSub?.items?.data?.[0];
      const live = existingSub && !["canceled", "incomplete_expired"].includes(existingSub.status);

      if (live && item) {
        if (item.price?.id === priceId) {
          return jsonResponse({ ok: true, unchanged: true, plan: metadata.plan });
        }
        const upd = new URLSearchParams({
          "items[0][id]": item.id,
          "items[0][price]": priceId,
          proration_behavior: "always_invoice",
          // Un changement d'offre annule une résiliation programmée : le client
          // qui choisit une nouvelle offre ne veut pas qu'elle s'arrête au 30.
          cancel_at_period_end: "false",
        });
        for (const [k, v] of Object.entries(metadata)) upd.set(`metadata[${k}]`, v);
        await stripeApi(`subscriptions/${encodeURIComponent(existingSub.id)}`, {
          method: "POST", form: upd,
          // Protège du double clic, pas plus. Le compartiment d'une minute est
          // délibéré : une clé Stripe vit 24 h, et une clé stable ferait rejouer
          // la réponse d'hier si le client fait pro → individual → pro dans la
          // journée. Il resterait alors sur pro chez nous, facturé individual
          // chez Stripe — une fuite invisible, bien pire qu'un prorata en trop.
          idempotencyKey: `plan-change:${workspace_id}:${priceId}:${Math.floor(Date.now() / 60_000)}`,
        });

        // Appliqué tout de suite plutôt qu'à la livraison du webhook : le client
        // vient de cliquer, il doit voir son offre changer. Le webhook repassera
        // derrière avec les vraies dates de période — même résultat.
        const { error } = await admin.rpc("billing_apply_plan", {
          p_workspace: workspace_id,
          p_plan: metadata.plan,
          p_stripe_customer: currentSub.stripe_customer_id,
          p_stripe_subscription: existingSub.id,
          p_seats: null,
        });
        if (error) throw new Error(error.message);
        return jsonResponse({ ok: true, updated: true, plan: metadata.plan });
      }
    }

    const form = new URLSearchParams({
      mode,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: `${APP_URL()}/billing-success?session_id={CHECKOUT_SESSION_ID}&ws=${workspace_id}`,
      cancel_url: `${APP_URL()}/app`,
      // Second porteur du workspace, indépendant des métadonnées : si un jour
      // une session en est dépourvue, le rattachement tient encore.
      client_reference_id: workspace_id,
    });

    // Réutiliser le client Stripe déjà connu : un client par achat éclaterait
    // l'historique de facturation en autant de fiches, et le portail n'en
    // montrerait qu'une. C'est aussi ce qui permet au webhook de retrouver le
    // workspace depuis un événement qui ne porte pas nos métadonnées.
    if (currentSub?.stripe_customer_id) {
      form.set("customer", currentSub.stripe_customer_id);
    } else {
      form.set("customer_email", userData.user.email ?? "");
      // Sans ça, un paiement unique ne crée aucun client Stripe : plus de
      // portail, et un remboursement impossible à rattacher.
      if (mode === "payment") form.set("customer_creation", "always");
    }

    for (const [k, v] of Object.entries(metadata)) form.set(`metadata[${k}]`, v);
    if (mode === "subscription") {
      // PIÈGE : un événement `customer.subscription.*` ne porte PAS les
      // métadonnées de la session de checkout. Sans cette recopie sur
      // l'abonnement lui-même, aucun renouvellement ni aucune résiliation ne
      // saurait à quel workspace il se rapporte.
      for (const [k, v] of Object.entries(metadata)) form.set(`subscription_data[metadata][${k}]`, v);
    }

    const session = await stripeApi<{ url: string }>("checkout/sessions", {
      method: "POST", form,
    });
    return jsonResponse({ ok: true, url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: msg }, { status: msg.startsWith("Stripe:") ? 502 : 500 });
  }
});
