// execute-admin-action — runs a sensitive action and records it in admin_actions.
// Body: { workspace_id, project_id, action_type, payload, confirm? }
//
// Supported action_type:
//   - stripe.refund_charge   { charge_id, amount_cents? }
//   - stripe.refund_invoice  { invoice_id }
//   - stripe.cancel_subscription { subscription_id }
//   - stripe.create_coupon   { percent_off?, amount_off?, currency?, duration?, id? }
//   - user.reset_password    { email }
//   - user.ban               { user_id }     (Supabase Auth admin)
//   - user.unban             { user_id }
//
// High-risk actions REQUIRE the request body to include `confirm: true`
// (typically set after the user passed a double-confirmation modal on the UI).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";
import {
  refundCharge,
  refundInvoice,
  cancelSubscription,
  createCoupon,
  pauseSubscription,
  resumeSubscription,
  applyCouponToSubscription,
  addCustomerBalance,
  payInvoice,
  extendTrial,
} from "../_shared/stripe.ts";

interface ActionMeta {
  risk: "low" | "medium" | "high" | "critical";
  requires_confirm: boolean;
  target_type: string;
}

const REGISTRY: Record<string, ActionMeta> = {
  "stripe.refund_charge": { risk: "high", requires_confirm: true, target_type: "stripe_charge" },
  "stripe.refund_invoice": { risk: "high", requires_confirm: true, target_type: "stripe_invoice" },
  "stripe.cancel_subscription": { risk: "high", requires_confirm: true, target_type: "stripe_subscription" },
  "stripe.pause_subscription": { risk: "medium", requires_confirm: false, target_type: "stripe_subscription" },
  "stripe.resume_subscription": { risk: "medium", requires_confirm: false, target_type: "stripe_subscription" },
  "stripe.apply_coupon": { risk: "medium", requires_confirm: false, target_type: "stripe_subscription" },
  "stripe.create_coupon": { risk: "medium", requires_confirm: false, target_type: "stripe_coupon" },
  "stripe.add_credit": { risk: "high", requires_confirm: true, target_type: "stripe_customer" },
  "stripe.retry_payment": { risk: "medium", requires_confirm: false, target_type: "stripe_invoice" },
  "stripe.extend_trial": { risk: "medium", requires_confirm: false, target_type: "stripe_subscription" },
  // Lemon Squeezy
  "lemonsqueezy.cancel_subscription": { risk: "high", requires_confirm: true, target_type: "ls_subscription" },
  "lemonsqueezy.refund_order": { risk: "high", requires_confirm: true, target_type: "ls_order" },
  // Paddle
  "paddle.cancel_subscription": { risk: "high", requires_confirm: true, target_type: "paddle_subscription" },
  // Users
  "user.reset_password": { risk: "medium", requires_confirm: false, target_type: "auth_user" },
  "user.ban": { risk: "critical", requires_confirm: true, target_type: "auth_user" },
  "user.unban": { risk: "high", requires_confirm: true, target_type: "auth_user" },
  "user.delete": { risk: "critical", requires_confirm: true, target_type: "auth_user" },
  // Lifecycle / data
  "user.export_data": { risk: "low", requires_confirm: false, target_type: "auth_user" },
  "feature.grant": { risk: "low", requires_confirm: false, target_type: "feature_flag" },
  "feature.revoke": { risk: "low", requires_confirm: false, target_type: "feature_flag" },
  // Ops / maintenance
  "ops.resync_billing": { risk: "low", requires_confirm: false, target_type: "project" },
  "ops.recalc_metrics": { risk: "low", requires_confirm: false, target_type: "project" },
  "ops.create_alert": { risk: "low", requires_confirm: false, target_type: "alert" },
  "ops.create_announcement": { risk: "medium", requires_confirm: false, target_type: "announcement" },
  // Communication
  "comms.notify": { risk: "low", requires_confirm: false, target_type: "messaging" },
  "comms.sms": { risk: "medium", requires_confirm: false, target_type: "phone" },
};

async function runAction(
  type: string,
  payload: Record<string, unknown>,
  workspaceId: string,
  projectId: string,
): Promise<{ result: unknown; target_id: string | null }> {
  if (type.startsWith("stripe.")) {
    const { payload: cred } = await getConnectorCredential(workspaceId, projectId, "stripe");
    const token = cred.secret_key;
    if (!token) throw new Error("Stripe secret_key missing");

    switch (type) {
      case "stripe.refund_charge": {
        const id = String(payload.charge_id);
        const amount = payload.amount_cents ? Number(payload.amount_cents) : undefined;
        const r = await refundCharge(token, id, amount);
        return { result: r, target_id: id };
      }
      case "stripe.refund_invoice": {
        const id = String(payload.invoice_id);
        const r = await refundInvoice(token, id);
        return { result: r, target_id: id };
      }
      case "stripe.cancel_subscription": {
        const id = String(payload.subscription_id);
        const r = await cancelSubscription(token, id);
        return { result: r, target_id: id };
      }
      case "stripe.pause_subscription": {
        const id = String(payload.subscription_id);
        const r = await pauseSubscription(token, id);
        return { result: r, target_id: id };
      }
      case "stripe.resume_subscription": {
        const id = String(payload.subscription_id);
        const r = await resumeSubscription(token, id);
        return { result: r, target_id: id };
      }
      case "stripe.apply_coupon": {
        const id = String(payload.subscription_id);
        const coupon = String(payload.coupon_id);
        const r = await applyCouponToSubscription(token, id, coupon);
        return { result: r, target_id: id };
      }
      case "stripe.add_credit": {
        const id = String(payload.customer_id);
        const amount = Number(payload.amount_cents);
        const r = await addCustomerBalance(token, id, amount);
        return { result: r, target_id: id };
      }
      case "stripe.retry_payment": {
        const id = String(payload.invoice_id);
        const r = await payInvoice(token, id);
        return { result: r, target_id: id };
      }
      case "stripe.extend_trial": {
        const id = String(payload.subscription_id);
        const days = Number(payload.days ?? 7);
        const trialEnd = Math.floor(Date.now() / 1000) + days * 86400;
        const r = await extendTrial(token, id, trialEnd);
        return { result: r, target_id: id };
      }
      case "stripe.create_coupon": {
        const r = await createCoupon(token, payload as never);
        return { result: r, target_id: r.id };
      }
    }
  }

  // --- Lemon Squeezy ---
  if (type.startsWith("lemonsqueezy.")) {
    const { payload: cred } = await getConnectorCredential(workspaceId, projectId, "lemonsqueezy");
    const key = cred.api_key;
    if (!key) throw new Error("Lemon Squeezy api_key missing");
    const headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/vnd.api+json",
      Accept: "application/vnd.api+json",
    };
    if (type === "lemonsqueezy.cancel_subscription") {
      const id = String(payload.subscription_id);
      const res = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${id}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error(`Lemon Squeezy cancel failed: ${(await res.text()).slice(0, 200)}`);
      return { result: { canceled: true }, target_id: id };
    }
    if (type === "lemonsqueezy.refund_order") {
      const id = String(payload.order_id);
      const res = await fetch(`https://api.lemonsqueezy.com/v1/orders/${id}/refund`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`Lemon Squeezy refund failed: ${(await res.text()).slice(0, 200)}`);
      return { result: { refunded: true }, target_id: id };
    }
  }

  // --- Paddle ---
  if (type.startsWith("paddle.")) {
    const { payload: cred } = await getConnectorCredential(workspaceId, projectId, "paddle");
    const key = cred.api_key;
    if (!key) throw new Error("Paddle api_key missing");
    if (type === "paddle.cancel_subscription") {
      const id = String(payload.subscription_id);
      const res = await fetch(`https://api.paddle.com/subscriptions/${id}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ effective_from: "next_billing_period" }),
      });
      if (!res.ok) throw new Error(`Paddle cancel failed: ${(await res.text()).slice(0, 200)}`);
      return { result: { canceled: true }, target_id: id };
    }
  }

  if (type === "user.reset_password") {
    const admin = createServiceClient();
    const email = String(payload.email);
    const { error } = await admin.auth.resetPasswordForEmail(email);
    if (error) throw new Error(error.message);
    return { result: { sent: true }, target_id: email };
  }

  if (type === "user.ban" || type === "user.unban") {
    const admin = createServiceClient();
    const userId = String(payload.user_id);
    const bannedUntil = type === "user.ban" ? "876000h" : "none";
    const { error } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: bannedUntil,
    } as unknown as Record<string, string>);
    if (error) throw new Error(error.message);
    return { result: { banned: type === "user.ban" }, target_id: userId };
  }

  if (type === "user.delete") {
    const admin = createServiceClient();
    const userId = String(payload.user_id);
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
    return { result: { deleted: true }, target_id: userId };
  }

  // --- Lifecycle / data ---
  if (type === "user.export_data") {
    const admin = createServiceClient();
    const email = String(payload.email);
    const [cust, evts] = await Promise.all([
      admin.from("customers").select("*").eq("project_id", projectId).eq("email", email).maybeSingle(),
      admin.from("product_events").select("event_name, occurred_at").eq("project_id", projectId).eq("user_email", email).limit(500),
    ]);
    const subs = cust.data
      ? await admin.from("subscriptions").select("*").eq("project_id", projectId).eq("customer_external_id", cust.data.external_id)
      : { data: [] };
    return { result: { customer: cust.data, subscriptions: subs.data, events: evts.data }, target_id: email };
  }

  if (type === "feature.grant" || type === "feature.revoke") {
    const admin = createServiceClient();
    const flagKey = String(payload.flag_key);
    const targetEmail = payload.target_email ? String(payload.target_email) : null;
    const { error } = await admin.from("feature_flags").upsert(
      { workspace_id: workspaceId, project_id: projectId, flag_key: flagKey, target_email: targetEmail, enabled: type === "feature.grant" },
      { onConflict: "project_id,flag_key,target_email" },
    );
    if (error) throw new Error(error.message);
    return { result: { flag_key: flagKey, enabled: type === "feature.grant" }, target_id: targetEmail ?? flagKey };
  }

  // --- Ops / maintenance (re-dispatch to existing edges via service key) ---
  if (type === "ops.resync_billing" || type === "ops.recalc_metrics") {
    const projectUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const fn = type === "ops.resync_billing" ? "sync-stripe-data" : "calculate-metrics";
    const res = await fetch(`${projectUrl}/functions/v1/${fn}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", apikey: serviceKey },
      body: JSON.stringify({ workspace_id: workspaceId, project_id: projectId }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out?.error ?? `${fn} failed`);
    return { result: out, target_id: projectId };
  }

  if (type === "ops.create_alert") {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from("alerts")
      .insert({
        workspace_id: workspaceId,
        project_id: projectId,
        type: "manual",
        severity: String(payload.severity ?? "warning"),
        title: String(payload.title ?? "Manual alert"),
        message: String(payload.message ?? ""),
        metadata: { source: "admin_action" },
      })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { result: { alert_id: data?.id }, target_id: data?.id ?? null };
  }

  if (type === "ops.create_announcement") {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from("announcements")
      .insert({
        workspace_id: workspaceId,
        project_id: projectId,
        title: String(payload.title ?? "Announcement"),
        body: String(payload.body ?? ""),
        level: String(payload.level ?? "info"),
      })
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { result: { announcement_id: data?.id }, target_id: data?.id ?? null };
  }

  // --- Communication ---
  if (type === "comms.notify") {
    const projectUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const res = await fetch(`${projectUrl}/functions/v1/send-notification`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", apikey: serviceKey },
      body: JSON.stringify({
        workspace_id: workspaceId,
        project_id: projectId,
        message: String(payload.message ?? ""),
        provider: payload.provider ? String(payload.provider) : undefined,
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out?.detail ?? out?.error ?? "Notification failed");
    return { result: out, target_id: out?.provider ?? null };
  }

  if (type === "comms.sms") {
    const { payload: cred } = await getConnectorCredential(workspaceId, projectId, "twilio");
    const sid = cred.account_sid;
    const token = cred.api_key;
    const fromNumber = cred.from_number;
    if (!sid || !token) throw new Error("Twilio account_sid + auth token required");
    const to = String(payload.to);
    const fromN = String(payload.from ?? fromNumber ?? "");
    if (!fromN) throw new Error("A Twilio 'from' number is required");
    const form = new URLSearchParams({ To: to, From: fromN, Body: String(payload.message ?? "") });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out?.message ?? `Twilio HTTP ${res.status}`);
    return { result: { sid: out?.sid }, target_id: to };
  }

  throw new Error(`Unknown action_type ${type}`);
}

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

    const body = await req.json();
    const { workspace_id, project_id, action_type, payload, confirm, request_approval } = body as {
      workspace_id?: string;
      project_id?: string;
      action_type?: string;
      payload?: Record<string, unknown>;
      confirm?: boolean;
      request_approval?: boolean;
    };

    if (!workspace_id || !project_id || !action_type) {
      return jsonResponse({ error: "workspace_id, project_id, action_type required" }, { status: 400 });
    }

    const meta = REGISTRY[action_type];
    if (!meta) return jsonResponse({ error: `Unknown action_type ${action_type}` }, { status: 400 });

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

    // Insert a pending row first so it is always traceable
    const { data: actionRow } = await admin
      .from("admin_actions")
      .insert({
        workspace_id,
        project_id,
        actor_user_id: userId,
        action_type,
        target_type: meta.target_type,
        payload: payload ?? {},
        status: "pending",
        risk_level: meta.risk,
        requires_approval: meta.requires_confirm,
      })
      .select()
      .single();

    // Approval workflow: leave the action pending for an approver to execute later.
    if (request_approval) {
      await admin
        .from("admin_actions")
        .update({ status: "pending", requires_approval: true })
        .eq("id", actionRow!.id);
      return jsonResponse({ ok: true, action_id: actionRow!.id, status: "pending" });
    }

    if (meta.requires_confirm && !confirm) {
      await admin
        .from("admin_actions")
        .update({ status: "rejected", error_message: "Missing confirm: true" })
        .eq("id", actionRow!.id);
      return jsonResponse(
        { error: "This action requires confirm: true in the body", risk: meta.risk },
        { status: 400 },
      );
    }

    await admin.from("admin_actions").update({ status: "executing" }).eq("id", actionRow!.id);

    try {
      const { result, target_id } = await runAction(action_type, payload ?? {}, workspace_id, project_id);
      await admin
        .from("admin_actions")
        .update({
          status: "succeeded",
          executed_at: new Date().toISOString(),
          target_id,
          payload: { ...(payload ?? {}), result },
        })
        .eq("id", actionRow!.id);

      await admin.from("activity_logs").insert({
        workspace_id,
        project_id,
        actor_user_id: userId,
        event_type: `admin_action.${action_type}`,
        title: `Admin action: ${action_type}`,
        payload: { target_id, payload },
      });

      return jsonResponse({ ok: true, action_id: actionRow!.id, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await admin
        .from("admin_actions")
        .update({
          status: "failed",
          executed_at: new Date().toISOString(),
          error_message: msg,
        })
        .eq("id", actionRow!.id);
      return jsonResponse({ error: "Action failed", detail: msg, action_id: actionRow!.id }, { status: 500 });
    }
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
