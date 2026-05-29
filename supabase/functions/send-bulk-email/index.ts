// send-bulk-email — personalized bulk email via Resend.
// Body: {
//   workspace_id, project_id,
//   subject, html,                         // may contain {{variables}}
//   from?,
//   audience?: { segment?, plan?, status?, min_mrr_cents? },  // server-side targeting
//   emails?: string[],                     // explicit / pasted recipients
//   test_to?: string                       // if set, send only to this address (preview)
// }
// Variables resolved per recipient: {{first_name}}, {{name}}, {{email}}, {{plan}},
// {{status}}, {{amount}}, {{currency}}, {{product}}, {{company}}.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";

interface Recipient {
  email: string;
  vars: Record<string, string>;
}

function fmtMoney(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: (currency || "EUR").toUpperCase() }).format(
    (cents ?? 0) / 100,
  );
}

function render(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? "");
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

    const body = await req.json();
    const { workspace_id, project_id, subject, html, from, audience, emails, test_to } = body;
    if (!workspace_id || !project_id || !subject || !html) {
      return jsonResponse({ error: "workspace_id, project_id, subject, html required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: m } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!m || !["owner", "admin"].includes(m.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    const { payload } = await getConnectorCredential(workspace_id, project_id, "resend").catch(() => ({ payload: {} as Record<string, string> }));
    const apiKey = payload.api_key;
    if (!apiKey) return jsonResponse({ error: "Resend not connected. Add it in the Catalog." }, { status: 400 });

    const { data: project } = await admin.from("projects").select("name").eq("id", project_id).maybeSingle();
    const company = project?.name ?? "our product";

    // --- Build the recipient list with per-recipient variables ---
    const recipients = new Map<string, Recipient>();

    // 1. Segment / filter from synced customers + subscriptions.
    if (audience && (audience.segment || audience.plan || audience.status || audience.min_mrr_cents)) {
      const { data: customers } = await admin
        .from("customers")
        .select("external_id, email, name, created_at_provider")
        .eq("project_id", project_id)
        .limit(5000);
      const { data: subs } = await admin
        .from("subscriptions")
        .select("customer_external_id, status, plan_name, amount_cents, currency")
        .eq("project_id", project_id);
      const subByCust = new Map<string, any>();
      (subs ?? []).forEach((s: any) => {
        const ex = subByCust.get(s.customer_external_id);
        if (!ex || (s.status === "active" && ex.status !== "active")) subByCust.set(s.customer_external_id, s);
      });

      const thirtyAgo = Date.now() - 30 * 86400_000;
      for (const c of customers ?? []) {
        if (!c.email) continue;
        const sub = subByCust.get(c.external_id);
        const status = sub?.status ?? "none";
        const paying = ["active", "trialing", "past_due"].includes(status);

        // Segment filter
        const seg = audience.segment;
        if (seg === "paying" && !paying) continue;
        if (seg === "trial" && status !== "trialing") continue;
        if (seg === "churned" && status !== "canceled") continue;
        if (seg === "new_30d" && !(c.created_at_provider && new Date(c.created_at_provider).getTime() >= thirtyAgo)) continue;
        // "all" or undefined → keep
        // Plan / status / mrr filters
        if (audience.plan && (sub?.plan_name ?? "") !== audience.plan) continue;
        if (audience.status && status !== audience.status) continue;
        if (audience.min_mrr_cents && (sub?.amount_cents ?? 0) < Number(audience.min_mrr_cents)) continue;

        const first = (c.name ?? c.email).split(/[\s@]/)[0];
        recipients.set(c.email.toLowerCase(), {
          email: c.email,
          vars: {
            first_name: first,
            name: c.name ?? first,
            email: c.email,
            plan: sub?.plan_name ?? "",
            status,
            amount: sub ? fmtMoney(sub.amount_cents, sub.currency) : "",
            currency: (sub?.currency ?? "eur").toUpperCase(),
            product: company,
            company,
          },
        });
      }
    }

    // 2. Explicit / pasted emails (no rich vars beyond email/company).
    for (const raw of Array.isArray(emails) ? emails : []) {
      const e = String(raw).trim().toLowerCase();
      if (!e || !e.includes("@")) continue;
      if (!recipients.has(e)) {
        recipients.set(e, { email: e, vars: { first_name: e.split("@")[0], name: e.split("@")[0], email: e, plan: "", status: "", amount: "", currency: "", product: company, company } });
      }
    }

    // Test mode: send a single email to test_to using the first recipient's vars (or defaults).
    let list = [...recipients.values()];
    if (test_to) {
      const sample = list[0]?.vars ?? { first_name: "there", name: "there", email: test_to, plan: "Pro", status: "active", amount: "€29.00", currency: "EUR", product: company, company };
      list = [{ email: test_to, vars: { ...sample, email: test_to } }];
    }

    if (list.length === 0) {
      return jsonResponse({ error: "No recipients matched. Adjust your audience or paste emails." }, { status: 400 });
    }
    // Safety cap to avoid runaway sends.
    if (list.length > 500) list = list.slice(0, 500);

    const fromAddr = from || "FounderOS <noreply@founderos.app>";
    let sent = 0;
    const failures: string[] = [];
    // Send sequentially in small batches to respect rate limits.
    for (const r of list) {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: fromAddr,
            to: [r.email],
            subject: render(subject, r.vars),
            html: render(html, r.vars),
          }),
        });
        if (res.ok) sent++;
        else failures.push(`${r.email}: ${(await res.text()).slice(0, 100)}`);
      } catch (e) {
        failures.push(`${r.email}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (!test_to) {
      await admin.from("activity_logs").insert({
        workspace_id,
        project_id,
        actor_user_id: userData.user.id,
        event_type: "email.bulk_sent",
        title: `Bulk email "${subject}" sent to ${sent} recipient(s)`,
        payload: { sent, failed: failures.length, audience: audience ?? null },
      });
    }

    return jsonResponse({ ok: true, sent, failed: failures.length, failures: failures.slice(0, 10), test: !!test_to });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
