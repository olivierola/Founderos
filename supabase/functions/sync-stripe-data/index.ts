// sync-stripe-data
// Pulls customers, subscriptions, invoices and charges from Stripe and stores them.
// Body: { workspace_id, project_id }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";
import {
  listCustomers,
  listSubscriptions,
  listInvoices,
  listCharges,
} from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });

    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = userData.user.id;

    const { workspace_id, project_id } = await req.json();
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id and project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    let payload: Record<string, string>;
    try {
      ({ payload } = await getConnectorCredential(workspace_id, project_id, "stripe"));
    } catch (e) {
      return jsonResponse(
        {
          error: "Stripe not connected for this project",
          detail: e instanceof Error ? e.message : String(e),
        },
        { status: 400 },
      );
    }
    const token = payload.secret_key;
    if (!token) {
      return jsonResponse(
        { error: "Stripe secret_key missing", detail: "Reconnect Stripe in Integrations → Catalog with a secret key." },
        { status: 400 },
      );
    }

    // Pull each resource independently — a restricted key missing a scope on one
    // resource shouldn't abort the whole sync. Collect warnings instead.
    const warnings: string[] = [];
    const safe = async <T>(label: string, fn: () => Promise<T[]>): Promise<T[]> => {
      try {
        return await fn();
      } catch (e) {
        warnings.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    };
    const [customers, subscriptions, invoices, charges] = await Promise.all([
      safe("customers", () => listCustomers(token)),
      safe("subscriptions", () => listSubscriptions(token)),
      safe("invoices", () => listInvoices(token)),
      safe("charges", () => listCharges(token)),
    ]);

    // If everything failed, the key is almost certainly invalid — surface clearly.
    if (customers.length === 0 && subscriptions.length === 0 && invoices.length === 0 && charges.length === 0 && warnings.length > 0) {
      return jsonResponse(
        {
          error: "Stripe sync failed — check your key permissions",
          detail: warnings.join(" | "),
        },
        { status: 400 },
      );
    }

    // Safe unix-seconds -> ISO (Stripe sometimes omits period fields on incomplete subs)
    const tsToIso = (s: number | null | undefined): string | null =>
      typeof s === "number" && s > 0 ? new Date(s * 1000).toISOString() : null;

    // Upsert customers
    if (customers.length > 0) {
      const rows = customers.map((c) => ({
        workspace_id,
        project_id,
        provider: "stripe",
        external_id: c.id,
        email: c.email,
        name: c.name,
        created_at_provider: tsToIso(c.created),
        metadata: c.metadata ?? {},
      }));
      const { error } = await admin.from("customers").upsert(rows, { onConflict: "project_id,provider,external_id" });
      if (error) warnings.push(`customers insert: ${error.message}`);
    }

    // Upsert subscriptions
    if (subscriptions.length > 0) {
      const rows = subscriptions.map((s) => {
        const item = s.items.data[0];
        const price = item?.price;
        const unit = price?.unit_amount ?? 0;
        const qty = item?.quantity ?? 1;
        return {
          workspace_id,
          project_id,
          provider: "stripe",
          external_id: s.id,
          customer_external_id: s.customer,
          status: s.status,
          plan_name: price?.nickname ?? price?.product ?? null,
          amount_cents: unit * qty,
          currency: (price?.currency ?? "eur").toLowerCase(),
          interval: price?.recurring?.interval ?? null,
          current_period_start: tsToIso(s.current_period_start),
          current_period_end: tsToIso(s.current_period_end),
          canceled_at: tsToIso(s.canceled_at),
          started_at: tsToIso(s.start_date),
          metadata: {},
        };
      });
      const { error } = await admin.from("subscriptions").upsert(rows, { onConflict: "project_id,provider,external_id" });
      if (error) warnings.push(`subscriptions insert: ${error.message}`);
    }

    // Upsert invoices
    if (invoices.length > 0) {
      const rows = invoices.map((i) => ({
        workspace_id,
        project_id,
        provider: "stripe",
        external_id: i.id,
        customer_external_id: i.customer,
        status: i.status,
        amount_paid_cents: i.amount_paid,
        amount_due_cents: i.amount_due,
        currency: i.currency.toLowerCase(),
        paid_at: tsToIso(i.status_transitions?.paid_at),
        metadata: {},
      }));
      const { error } = await admin.from("invoices").upsert(rows, { onConflict: "project_id,provider,external_id" });
      if (error) warnings.push(`invoices insert: ${error.message}`);
    }

    // Revenue records: prefer paid INVOICES (covers subscription payments), and
    // fall back to succeeded charges that are not tied to an invoice (one-off payments).
    const revenueRows: Array<Record<string, unknown>> = [];

    for (const inv of invoices) {
      if (inv.status === "paid" && inv.amount_paid > 0) {
        revenueRows.push({
          workspace_id,
          project_id,
          provider: "stripe",
          external_id: `inv_${inv.id}`,
          amount_cents: inv.amount_paid,
          currency: inv.currency.toLowerCase(),
          type: "invoice",
          customer_external_id: inv.customer,
          occurred_at: inv.status_transitions?.paid_at
            ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
            : new Date(inv.created * 1000).toISOString(),
          metadata: {},
        });
      }
    }

    for (const c of charges) {
      if (c.status !== "succeeded") continue;
      // Skip charges already represented by an invoice to avoid double counting.
      if ((c as { invoice?: string | null }).invoice) continue;
      const net = c.amount - c.amount_refunded;
      if (net <= 0) continue;
      revenueRows.push({
        workspace_id,
        project_id,
        provider: "stripe",
        external_id: `ch_${c.id}`,
        amount_cents: net,
        currency: c.currency.toLowerCase(),
        type: c.refunded ? "refund" : "charge",
        customer_external_id: c.customer,
        occurred_at: new Date(c.created * 1000).toISOString(),
        metadata: {},
      });
    }

    if (revenueRows.length > 0) {
      const { error: revErr } = await admin
        .from("revenue_records")
        .upsert(revenueRows, { onConflict: "project_id,provider,external_id", ignoreDuplicates: true });
      if (revErr) warnings.push(`revenue_records: ${revErr.message}`);
    }

    await admin
      .from("connectors")
      .update({ metadata: { ...{}, last_synced_at: new Date().toISOString() } })
      .eq("workspace_id", workspace_id)
      .eq("project_id", project_id)
      .eq("provider", "stripe");

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: userId,
      event_type: "stripe.synced",
      title: "Stripe data synchronized",
      payload: {
        customers: customers.length,
        subscriptions: subscriptions.length,
        invoices: invoices.length,
        charges: charges.length,
      },
    });

    // Kick metrics calculation
    const projectUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    fetch(`${projectUrl}/functions/v1/calculate-metrics`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id, project_id }),
    }).catch(() => {});

    return jsonResponse({
      ok: true,
      counts: {
        customers: customers.length,
        subscriptions: subscriptions.length,
        invoices: invoices.length,
        charges: charges.length,
      },
      warnings,
    });
  } catch (err) {
    return jsonResponse(
      { error: "sync-stripe-data failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
