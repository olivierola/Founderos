// billing-stripe.ts — accès au compte Stripe d'Anduran (pas celui d'un
// workspace : ça, c'est `_shared/stripe.ts`, qui sert l'analytique revenus des
// clients) et application d'un achat.
//
// POURQUOI CE FICHIER EXISTE
// Deux chemins mènent au même achat : le retour navigateur (`create-checkout`
// action `confirm`) et le webhook signé (`stripe-webhook`). Ils courent en
// parallèle — le client revient sur la page pendant que Stripe frappe le
// webhook. Si la logique d'application vit à deux endroits, elle diverge, et le
// jour où elle diverge un client est crédité deux fois ou pas du tout.
// Une seule implémentation, un seul verrou.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export const STRIPE_API = "https://api.stripe.com/v1";

/**
 * Clé secrète du compte Stripe d'Anduran.
 *
 * Deux noms acceptés, dans cet ordre. `FOUNDEROS_STRIPE_SECRET_KEY` est
 * préféré parce qu'il est sans ambiguïté : `propagate-credential` pousse des
 * secrets applicatifs de CLIENTS sous des noms génériques dont
 * `STRIPE_SECRET_KEY`. Si un jour l'un d'eux atterrit dans nos propres secrets
 * Edge, le nom préfixé reste celui qui encaisse pour nous.
 */
export function platformStripeKey(): string {
  const key = Deno.env.get("FOUNDEROS_STRIPE_SECRET_KEY") ?? Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) {
    throw new Error(
      "Clé Stripe absente des secrets Edge : posez FOUNDEROS_STRIPE_SECRET_KEY (ou STRIPE_SECRET_KEY).",
    );
  }
  return key;
}

/** Appel REST Stripe avec la clé plateforme. `form` est encodé x-www-form-urlencoded. */
export async function stripeApi<T = Record<string, unknown>>(
  path: string,
  init: { method?: string; form?: URLSearchParams | string; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${platformStripeKey()}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;

  const res = await fetch(`${STRIPE_API}/${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.form ? String(init.form) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stripe: ${(data as { error?: { message?: string } })?.error?.message ?? res.status}`);
  }
  return data as T;
}

export interface StripeCheckoutSession {
  id: string;
  status?: string;
  payment_status?: string;
  mode?: string;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  client_reference_id?: string | null;
  amount_total?: number | null;
  metadata?: Record<string, string> | null;
}

/** Stripe renvoie tantôt un identifiant, tantôt l'objet développé (`expand`). */
export function stripeId(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (v && typeof v === "object" && typeof (v as { id?: string }).id === "string") {
    return (v as { id: string }).id;
  }
  return null;
}

export interface ApplyResult {
  ok: boolean;
  applied?: "plan" | "topup";
  already_applied?: boolean;
  workspace_id?: string;
  result?: unknown;
  error?: string;
}

/**
 * Applique une session de checkout payée : changement d'offre ou recharge.
 *
 * Idempotent par insertion préalable dans `billing_checkout_sessions` (clé
 * primaire = identifiant de session). Le premier appelant — retour navigateur ou
 * webhook — pose le verrou et applique ; l'autre repart avec `already_applied`.
 * Le verrou est posé AVANT l'effet de bord, pas après : l'inverse laisse une
 * fenêtre où les deux chemins créditent le même pack.
 */
export async function applyCheckoutSession(
  admin: SupabaseClient,
  session: StripeCheckoutSession,
  /** Si fourni, la session doit concerner ce workspace (contrôle d'accès du
   *  chemin navigateur : l'appelant est authentifié, la session ne l'est pas). */
  expectedWorkspaceId?: string,
): Promise<ApplyResult> {
  const meta = session.metadata ?? {};
  const workspaceId = meta.workspace_id || session.client_reference_id || null;
  if (!workspaceId) return { ok: false, error: "Session sans workspace (métadonnées absentes)" };
  if (expectedWorkspaceId && workspaceId !== expectedWorkspaceId) {
    return { ok: false, error: "Cette session ne concerne pas cet espace de travail" };
  }

  const paid = session.payment_status === "paid"
    || session.payment_status === "no_payment_required"
    || session.status === "complete";
  if (!paid) return { ok: false, error: "Session non payée", workspace_id: workspaceId };

  const { error: lockErr } = await admin.from("billing_checkout_sessions").insert({
    session_id: session.id,
    workspace_id: workspaceId,
    kind: meta.plan ? "plan" : "pack",
    reference: meta.plan ?? meta.pack ?? "",
  });
  if (lockErr) {
    // 23505 = déjà appliqué par l'autre chemin. Toute autre erreur est réelle.
    if (lockErr.code === "23505") {
      return { ok: true, already_applied: true, workspace_id: workspaceId };
    }
    return { ok: false, error: lockErr.message, workspace_id: workspaceId };
  }

  if (meta.plan) {
    const { data, error } = await admin.rpc("billing_apply_plan", {
      p_workspace: workspaceId,
      p_plan: meta.plan,
      p_stripe_customer: stripeId(session.customer),
      p_stripe_subscription: stripeId(session.subscription),
      p_seats: null,
    });
    if (error) {
      // Le verrou a été posé mais l'application a échoué : le retirer, sinon un
      // rejeu du webhook conclurait « déjà appliqué » sur un achat jamais honoré.
      await admin.from("billing_checkout_sessions").delete().eq("session_id", session.id);
      return { ok: false, error: error.message, workspace_id: workspaceId };
    }
    return { ok: true, applied: "plan", workspace_id: workspaceId, result: data };
  }

  if (meta.pack) {
    const { data: packRow } = await admin
      .from("credit_packs").select("credits").eq("code", meta.pack).maybeSingle();
    if (!packRow) {
      await admin.from("billing_checkout_sessions").delete().eq("session_id", session.id);
      return { ok: false, error: `Pack inconnu: ${meta.pack}`, workspace_id: workspaceId };
    }
    const { data, error } = await admin.rpc("billing_apply_topup", {
      p_workspace: workspaceId,
      p_credits: packRow.credits,
      p_reference: session.id,
    });
    if (error) {
      await admin.from("billing_checkout_sessions").delete().eq("session_id", session.id);
      return { ok: false, error: error.message, workspace_id: workspaceId };
    }
    return { ok: true, applied: "topup", workspace_id: workspaceId, result: data };
  }

  await admin.from("billing_checkout_sessions").delete().eq("session_id", session.id);
  return { ok: false, error: "Session sans offre ni pack", workspace_id: workspaceId };
}

/**
 * Vérifie la signature d'un webhook Stripe (`Stripe-Signature`).
 *
 * Format : `t=<horodatage>,v1=<hmac hex>[,v1=<autre>]`. Le message signé est
 * `${t}.${corps brut}` — d'où l'obligation de travailler sur le texte reçu et
 * jamais sur un JSON re-sérialisé : `JSON.parse` puis `JSON.stringify` change un
 * espace et la signature ne colle plus.
 *
 * Plusieurs `v1` coexistent pendant une rotation de secret : il suffit qu'un
 * seul corresponde.
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds = 300,
): Promise<{ ok: boolean; reason?: string }> {
  if (!signatureHeader) return { ok: false, reason: "signature absente" };
  if (!secret) return { ok: false, reason: "secret de webhook non configuré" };

  const parts = signatureHeader.split(",").map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!timestamp || signatures.length === 0) return { ok: false, reason: "signature malformée" };

  // Fenêtre temporelle : sans elle, une requête signée capturée reste rejouable
  // indéfiniment.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) {
    return { ok: false, reason: "horodatage hors fenêtre" };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const match = signatures.some((sig) => timingSafeEqual(sig, expected));
  return match ? { ok: true } : { ok: false, reason: "signature invalide" };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
