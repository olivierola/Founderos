// generate-saas-analytics-snapshot — aggregate today's SaaS KPIs into
// saas_analytics_snapshots so the Actions → SaaS Analytics page can render
// fast without doing heavy joins client-side.
//
// Body: { workspace_id, project_id }
// Auth: workspace owner/admin.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

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

    const body = await req.json().catch(() => ({}));
    const { workspace_id, project_id } = body as { workspace_id?: string; project_id?: string };
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id, project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return jsonResponse({ error: "Not authorized for this workspace" }, { status: 403 });
    }

    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const d7Ago = new Date(now.getTime() - 7 * 86400000).toISOString();
    const d30Ago = new Date(now.getTime() - 30 * 86400000).toISOString();

    /* ---------- Revenue (active subscriptions) ---------- */
    const { data: subs } = await admin
      .from("subscriptions")
      .select("status, amount_cents, billing_interval, started_at, canceled_at")
      .eq("project_id", project_id);

    let mrr = 0;
    let payingUsers = 0;
    let netNewMrr = 0;
    let churnUsers30 = 0;
    (subs ?? []).forEach((s: any) => {
      if (s.status === "active" || s.status === "trialing") {
        const monthly = s.billing_interval === "year" ? Math.round((s.amount_cents ?? 0) / 12) : (s.amount_cents ?? 0);
        mrr += monthly;
        payingUsers += 1;
        if (s.started_at && s.started_at >= d30Ago) netNewMrr += monthly;
      }
      if (s.canceled_at && s.canceled_at >= d30Ago) churnUsers30 += 1;
    });

    /* ---------- Previous snapshot for growth comparison ---------- */
    const { data: previous } = await admin
      .from("saas_analytics_snapshots")
      .select("mrr_cents, snapshot_date")
      .eq("project_id", project_id)
      .lt("snapshot_date", today)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const previousMrr = previous?.mrr_cents ?? 0;
    const mrrGrowthPct =
      previousMrr > 0 ? ((mrr - previousMrr) / previousMrr) * 100 : mrr > 0 ? 100 : 0;

    /* ---------- Users / signups ---------- */
    const { count: totalUsers } = await admin
      .from("saas_users")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project_id);

    const { count: newSignups7d } = await admin
      .from("saas_users")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project_id)
      .gte("created_at", d7Ago);

    const { count: activeUsers30d } = await admin
      .from("saas_users")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project_id)
      .gte("last_seen_at", d30Ago);

    const churnRate30 =
      payingUsers + churnUsers30 > 0 ? churnUsers30 / (payingUsers + churnUsers30) : 0;

    const activationRate =
      (totalUsers ?? 0) > 0 ? Math.min(1, (activeUsers30d ?? 0) / (totalUsers ?? 1)) : 0;

    /* ---------- Operational counters ---------- */
    const { count: openAlerts } = await admin
      .from("alerts")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project_id)
      .eq("status", "open");

    const { count: openIncidents } = await admin
      .from("incidents")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project_id)
      .in("status", ["open", "investigating", "identified"]);

    const { count: failedPayments7d } = await admin
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project_id)
      .eq("status", "uncollectible")
      .gte("created_at", d7Ago);

    const { count: pendingApprovals } = await admin
      .from("admin_actions")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project_id)
      .eq("status", "pending");

    /* ---------- Top features (best-effort, optional) ---------- */
    let topFeatures: Array<{ feature: string; usage_count: number }> = [];
    const { data: events } = await admin
      .from("activity_logs")
      .select("event_type")
      .eq("project_id", project_id)
      .gte("created_at", d30Ago)
      .limit(2000);
    if (events) {
      const counts = new Map<string, number>();
      events.forEach((e: { event_type: string | null }) => {
        if (!e.event_type) return;
        counts.set(e.event_type, (counts.get(e.event_type) ?? 0) + 1);
      });
      topFeatures = Array.from(counts.entries())
        .map(([feature, usage_count]) => ({ feature, usage_count }))
        .sort((a, b) => b.usage_count - a.usage_count)
        .slice(0, 5);
    }

    /* ---------- Upsert snapshot ---------- */
    const row = {
      workspace_id,
      project_id,
      snapshot_date: today,
      mrr_cents: mrr,
      arr_cents: mrr * 12,
      mrr_growth_pct: mrrGrowthPct,
      net_new_mrr_cents: netNewMrr,
      total_users: totalUsers ?? 0,
      active_users_30d: activeUsers30d ?? 0,
      new_signups_7d: newSignups7d ?? 0,
      churn_rate_30d: churnRate30,
      churn_users_30d: churnUsers30,
      paying_users: payingUsers,
      activation_rate: activationRate,
      top_features: topFeatures,
      open_alerts: openAlerts ?? 0,
      open_incidents: openIncidents ?? 0,
      failed_payments_7d: failedPayments7d ?? 0,
      pending_approvals: pendingApprovals ?? 0,
    };

    const { data: saved, error: saveErr } = await admin
      .from("saas_analytics_snapshots")
      .upsert(row, { onConflict: "project_id,snapshot_date" })
      .select()
      .single();
    if (saveErr) {
      return jsonResponse({ error: "Could not save snapshot", detail: saveErr.message }, { status: 500 });
    }

    return jsonResponse({ snapshot: saved });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
