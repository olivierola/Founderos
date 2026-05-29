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
