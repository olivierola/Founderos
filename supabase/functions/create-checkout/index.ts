// create-checkout — creates a Stripe Checkout Session for FounderOS subscription upgrade.
// Uses the FOUNDEROS_STRIPE_SECRET_KEY (FounderOS's own Stripe account), not the workspace's.
// Body: { workspace_id, plan }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

const PRICE_BY_PLAN: Record<string, string | undefined> = {
  starter: Deno.env.get("FOUNDEROS_PRICE_STARTER"),
  pro: Deno.env.get("FOUNDEROS_PRICE_PRO"),
  team: Deno.env.get("FOUNDEROS_PRICE_TEAM"),
};

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, plan } = await req.json();
    if (!workspace_id || !plan) return jsonResponse({ error: "workspace_id, plan required" }, { status: 400 });

    const priceId = PRICE_BY_PLAN[plan];
    const stripeKey = Deno.env.get("FOUNDEROS_STRIPE_SECRET_KEY");
    if (!priceId || !stripeKey) {
      return jsonResponse(
        {
          error: "Billing not yet wired",
          detail: "FounderOS Stripe price IDs / secret key not configured in Edge secrets.",
        },
        { status: 503 },
      );
    }

    const admin = createServiceClient();
    const { data: m } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!m || m.role !== "owner") return jsonResponse({ error: "Only the owner can upgrade" }, { status: 403 });

    const form = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: `${Deno.env.get("APP_URL") ?? "http://localhost:5173"}/billing-success`,
      cancel_url: `${Deno.env.get("APP_URL") ?? "http://localhost:5173"}/app`,
      customer_email: userData.user.email ?? "",
      "metadata[workspace_id]": workspace_id,
      "metadata[plan]": plan,
    });

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data = await res.json();
    if (!res.ok) return jsonResponse({ error: "Stripe rejected", detail: data }, { status: 502 });
    return jsonResponse({ ok: true, url: data.url });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
