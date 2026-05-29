// record-cost — insert a manual cost entry.
// Body: { workspace_id, project_id, provider, category, amount_cents, currency?,
//         period_start?, period_end?, note? }

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

    const body = await req.json();
    const required = ["workspace_id", "project_id", "provider", "amount_cents"];
    for (const k of required) {
      if (body[k] === undefined || body[k] === null) {
        return jsonResponse({ error: `${k} required` }, { status: 400 });
      }
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", body.workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    const { data: row, error } = await admin
      .from("cost_records")
      .insert({
        workspace_id: body.workspace_id,
        project_id: body.project_id,
        provider: body.provider,
        category: body.category ?? "infra",
        amount_cents: Math.round(Number(body.amount_cents)),
        currency: (body.currency ?? "eur").toLowerCase(),
        period_start: body.period_start ?? null,
        period_end: body.period_end ?? null,
        source: "manual",
        recurrence: body.recurrence === "recurring" ? "recurring" : "one_off",
        recurrence_interval:
          body.recurrence === "recurring"
            ? body.recurrence_interval === "year"
              ? "year"
              : "month"
            : null,
        note: body.note ?? null,
        created_by: userId,
      })
      .select()
      .single();
    if (error) return jsonResponse({ error: "Could not insert cost", detail: error.message }, { status: 500 });

    await admin.from("activity_logs").insert({
      workspace_id: body.workspace_id,
      project_id: body.project_id,
      actor_user_id: userId,
      event_type: "cost.recorded",
      title: `Cost recorded: ${body.provider} ${(row!.amount_cents / 100).toFixed(2)} ${row!.currency.toUpperCase()}`,
      payload: { provider: body.provider, amount_cents: row!.amount_cents, category: row!.category },
    });

    return jsonResponse({ ok: true, cost_record: row });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
