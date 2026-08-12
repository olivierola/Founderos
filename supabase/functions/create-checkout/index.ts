// create-checkout — Stripe Checkout pour les offres Anduran et les packs de crédits.
// Utilise FOUNDEROS_STRIPE_SECRET_KEY (le compte Stripe d'Anduran), pas celui du workspace.
//
// Body:
//   { workspace_id, plan }               → session d'abonnement
//   { workspace_id, pack }               → session de paiement unique (recharge)
//   { workspace_id, action: "confirm", session_id } → applique l'achat après retour
//
// Les prix ne sont plus dans le code : ils viennent de billing_plans /
// credit_packs (migration 0194), qui portent aussi les crédits inclus. Une
// grille tarifaire qui vit à deux endroits finit toujours par diverger.
//
// À FAIRE (dette assumée) : "confirm" est déclenché par le retour navigateur.
// C'est suffisant tant que le catalogue est simple, mais un webhook Stripe
// signé reste la source de vérité pour les renouvellements et les échecs de
// paiement — il occupera un slot de fonction dès qu'il y en aura un de libre
// (le projet est à 99/100).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

const APP_URL = () => Deno.env.get("APP_URL") ?? "http://localhost:5173";

async function stripe(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const key = Deno.env.get("FOUNDEROS_STRIPE_SECRET_KEY");
  if (!key) throw new Error("FOUNDEROS_STRIPE_SECRET_KEY absente des secrets Edge");
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(init.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe: ${data?.error?.message ?? res.status}`);
  return data;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, plan, pack, action, session_id } = await req.json();
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
      const session = await stripe(`checkout/sessions/${encodeURIComponent(String(session_id))}`, {
        method: "GET",
      });
      const meta = (session.metadata ?? {}) as Record<string, string>;
      // Le workspace vient des métadonnées de la session, jamais du corps de la
      // requête : sinon n'importe quel owner pourrait créditer son workspace
      // avec l'identifiant d'une session payée par quelqu'un d'autre.
      if (meta.workspace_id !== workspace_id) {
        return jsonResponse({ error: "Cette session ne concerne pas cet espace de travail" }, { status: 403 });
      }
      if (session.payment_status !== "paid" && session.status !== "complete") {
        return jsonResponse({ ok: false, pending: true, status: session.status }, { status: 202 });
      }

      // Verrou d'idempotence AVANT d'appliquer : la page de retour peut être
      // rafraîchie, et créditer un pack deux fois se remarque tout de suite.
      const { error: lockErr } = await admin.from("billing_checkout_sessions").insert({
        session_id: String(session.id ?? session_id),
        workspace_id,
        kind: meta.plan ? "plan" : "pack",
        reference: meta.plan ?? meta.pack ?? "",
      });
      if (lockErr) {
        // 23505 = déjà appliqué. Toute autre erreur est réelle et doit remonter.
        if (lockErr.code === "23505") return jsonResponse({ ok: true, already_applied: true });
        throw new Error(lockErr.message);
      }

      if (meta.plan) {
        const { data, error } = await admin.rpc("billing_apply_plan", {
          p_workspace: workspace_id,
          p_plan: meta.plan,
          p_stripe_customer: (session.customer as string) ?? null,
          p_stripe_subscription: (session.subscription as string) ?? null,
          p_seats: null,
        });
        if (error) throw new Error(error.message);
        return jsonResponse({ ok: true, applied: "plan", result: data });
      }
      if (meta.pack) {
        const { data: packRow } = await admin
          .from("credit_packs").select("credits").eq("code", meta.pack).maybeSingle();
        if (!packRow) return jsonResponse({ error: "Pack inconnu" }, { status: 400 });
        const { data, error } = await admin.rpc("billing_apply_topup", {
          p_workspace: workspace_id,
          p_credits: packRow.credits,
          p_reference: String(session.id ?? session_id),
        });
        if (error) throw new Error(error.message);
        return jsonResponse({ ok: true, applied: "topup", result: data });
      }
      return jsonResponse({ error: "Session sans offre ni pack" }, { status: 400 });
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

    const form = new URLSearchParams({
      mode,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: `${APP_URL()}/billing-success?session_id={CHECKOUT_SESSION_ID}&ws=${workspace_id}`,
      cancel_url: `${APP_URL()}/app`,
      customer_email: userData.user.email ?? "",
    });
    for (const [k, v] of Object.entries(metadata)) form.set(`metadata[${k}]`, v);

    const session = await stripe("checkout/sessions", { method: "POST", body: form.toString() });
    return jsonResponse({ ok: true, url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: msg }, { status: msg.startsWith("Stripe:") ? 502 : 500 });
  }
});
