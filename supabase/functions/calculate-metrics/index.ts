// calculate-metrics
// Computes MRR, ARR, ARPU, churn, active subs, revenue total, and stores a daily snapshot.
// Body: { workspace_id, project_id }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

interface SubRow {
  external_id: string;
  customer_external_id: string | null;
  status: string;
  amount_cents: number;
  currency: string;
  interval: string | null;
  canceled_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
}

function toMonthlyCents(amount: number, interval: string | null): number {
  if (!interval) return amount;
  switch (interval) {
    case "day":
      return Math.round(amount * 30);
    case "week":
      return Math.round((amount * 52) / 12);
    case "month":
      return amount;
    case "year":
      return Math.round(amount / 12);
    default:
      return amount;
  }
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { workspace_id, project_id } = await req.json();
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id and project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();

    const { data: subs } = await admin
      .from("subscriptions")
      .select("external_id, customer_external_id, status, amount_cents, currency, interval, canceled_at, current_period_start, current_period_end")
      .eq("project_id", project_id);

    const activeSubs = ((subs ?? []) as SubRow[]).filter((s) =>
      ["active", "trialing", "past_due"].includes(s.status),
    );
    const mrrCents = activeSubs.reduce((sum, s) => sum + toMonthlyCents(s.amount_cents, s.interval), 0);
    const arrCents = mrrCents * 12;

    // ARPU on paying active subs
    const payingActive = activeSubs.filter((s) => s.status !== "trialing");
    const arpuCents = payingActive.length > 0 ? Math.round(mrrCents / payingActive.length) : 0;

    // Churned in last 30 days
    const thirtyAgo = new Date(Date.now() - 30 * 86400_000);
    const canceledLast30 = ((subs ?? []) as SubRow[]).filter(
      (s) => s.canceled_at && new Date(s.canceled_at) >= thirtyAgo,
    ).length;
    const denominator = (subs ?? []).length || 1;
    const churnRate = canceledLast30 / denominator;

    const sevenAgo = new Date(Date.now() - 7 * 86400_000);

    // Customers: total + new in last 30d (by provider creation date, fallback to row created_at)
    const { data: customers } = await admin
      .from("customers")
      .select("external_id, created_at_provider, created_at")
      .eq("project_id", project_id);
    const customersCount = (customers ?? []).length;
    const custDate = (c: { created_at_provider: string | null; created_at: string | null }) =>
      c.created_at_provider ?? c.created_at;
    const newCustomers30d = (customers ?? []).filter((c) => {
      const d = custDate(c);
      return d && new Date(d) >= thirtyAgo;
    }).length;

    // Churned customers (subs canceled in last 30d, unique customers)
    const churnedCustomers30d = new Set(
      ((subs ?? []) as SubRow[])
        .filter((s) => s.canceled_at && new Date(s.canceled_at) >= thirtyAgo)
        .map((s) => s.customer_external_id)
        .filter(Boolean),
    ).size;

    // Revenue total + windows + per-customer LTV
    const { data: revenue } = await admin
      .from("revenue_records")
      .select("amount_cents, currency, occurred_at, customer_external_id")
      .eq("project_id", project_id);

    const totalRevenueCents = (revenue ?? []).reduce((s, r) => s + (r.amount_cents ?? 0), 0);
    const last30Cents = (revenue ?? [])
      .filter((r) => r.occurred_at && new Date(r.occurred_at) >= thirtyAgo)
      .reduce((s, r) => s + (r.amount_cents ?? 0), 0);
    const last7Cents = (revenue ?? [])
      .filter((r) => r.occurred_at && new Date(r.occurred_at) >= sevenAgo)
      .reduce((s, r) => s + (r.amount_cents ?? 0), 0);

    // Average LTV = total revenue / paying customers (customers with any revenue)
    const payingCustomerIds = new Set(
      (revenue ?? []).map((r) => r.customer_external_id).filter(Boolean),
    );
    const ltvCents = payingCustomerIds.size > 0 ? Math.round(totalRevenueCents / payingCustomerIds.size) : 0;

    // Product-event derived: signups (event_name ~ signup) + active users (distinct emails) last 30d
    const { data: events } = await admin
      .from("product_events")
      .select("event_name, user_email, occurred_at")
      .eq("project_id", project_id)
      .gte("occurred_at", thirtyAgo.toISOString());
    const signups30d = (events ?? []).filter((e) =>
      /sign[_-]?up|register|account[_-]?created/i.test(e.event_name ?? ""),
    ).length;
    const activeUsers30d = new Set(
      (events ?? []).map((e) => e.user_email?.toLowerCase()).filter(Boolean),
    ).size;

    // Trial conversions (approx): active, non-canceled subs whose current period started in last 30d
    const trialConversions30d = ((subs ?? []) as SubRow[]).filter(
      (s) =>
        s.status === "active" &&
        s.canceled_at == null &&
        s.current_period_start != null &&
        new Date(s.current_period_start) >= thirtyAgo,
    ).length;

    // Failed payments = invoices.open or uncollectible
    const { count: failedCount } = await admin
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project_id)
      .in("status", ["uncollectible", "open"]);

    const currency = activeSubs[0]?.currency ?? "eur";

    const snapshot = {
      mrr_cents: mrrCents,
      arr_cents: arrCents,
      arpu_cents: arpuCents,
      currency,
      active_subscriptions: activeSubs.length,
      paying_subscriptions: payingActive.length,
      churn_rate_30d: churnRate,
      canceled_last_30d: canceledLast30,
      customers: customersCount ?? 0,
      new_customers_30d: newCustomers30d,
      churned_customers_30d: churnedCustomers30d,
      total_revenue_cents: totalRevenueCents,
      revenue_last_30d_cents: last30Cents,
      revenue_last_7d_cents: last7Cents,
      ltv_cents: ltvCents,
      signups_30d: signups30d,
      active_users_30d: activeUsers30d,
      trial_conversions_30d: trialConversions30d,
      failed_payments: failedCount ?? 0,
      computed_at: new Date().toISOString(),
    };

    const today = new Date().toISOString().slice(0, 10);
    await admin.from("metrics_snapshots").upsert(
      {
        workspace_id,
        project_id,
        snapshot_date: today,
        metrics: snapshot,
      },
      { onConflict: "project_id,snapshot_date" },
    );

    return jsonResponse({ ok: true, snapshot });
  } catch (err) {
    return jsonResponse(
      { error: "calculate-metrics failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
