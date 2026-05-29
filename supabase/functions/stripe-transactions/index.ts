// stripe-transactions — live Stripe balance transactions (money flow).
// Body: { workspace_id, project_id, limit? }
// Returns: { rows: [{ id, amount_cents, fee_cents, net_cents, currency, type,
//   category, description, status, created, available_on }], balance_cents }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";
import { listBalanceTransactions } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, project_id, limit } = await req.json();
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id and project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: m } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!m) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    let payload: Record<string, string>;
    try {
      ({ payload } = await getConnectorCredential(workspace_id, project_id, "stripe"));
    } catch {
      return jsonResponse({ error: "Stripe not connected for this project" }, { status: 400 });
    }
    const token = payload.secret_key;
    if (!token) return jsonResponse({ error: "Stripe secret_key missing" }, { status: 400 });

    const txns = await listBalanceTransactions(token, Math.min(Number(limit ?? 200), 1000));

    const rows = txns.map((t) => ({
      id: t.id,
      amount_cents: t.amount,
      fee_cents: t.fee,
      net_cents: t.net,
      currency: (t.currency ?? "eur").toUpperCase(),
      type: t.type,
      category: t.reporting_category ?? t.type,
      description: t.description ?? "",
      status: t.status,
      created: new Date(t.created * 1000).toISOString(),
      available_on: new Date(t.available_on * 1000).toISOString(),
    }));

    // Net balance across the returned window (sum of net amounts).
    const balanceCents = rows.reduce((s, r) => s + (r.net_cents ?? 0), 0);

    return jsonResponse({ rows, balance_cents: balanceCents });
  } catch (err) {
    return jsonResponse(
      { error: "stripe-transactions failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
