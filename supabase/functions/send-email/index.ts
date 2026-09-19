// send-email — sends a transactional email via Resend using the workspace's connector.
// Body: { workspace_id, project_id, to, subject, html?, text?, from? }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";
import { isServiceCaller } from "../_shared/authz.ts";

const DEFAULT_SENDER = "Anduran <noreply@founderos.app>";

/** Adresse contenue dans un « Nom <adresse> » ou une adresse nue. */
function emailOf(sender: string): string | null {
  const m = sender.match(/<([^>]+)>\s*$/);
  const addr = (m ? m[1] : sender).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) ? addr : null;
}

/**
 * FOS-22 — `from` arrivait du corps de la requête et partait tel quel chez
 * Resend. Un admin pouvait donc écrire depuis n'importe quelle adresse des
 * domaines vérifiés du client (facturation@, direction@, rh@…), ce qui rend
 * l'hameçonnage interne trivial et ne laisse aucune trace côté destinataire.
 *
 * L'expéditeur demandé n'est retenu que s'il figure dans les expéditeurs
 * déclarés du connecteur (`metadata.allowed_senders`). Sinon on retombe sur
 * l'adresse de la plateforme : refuser l'envoi punirait l'appelant légitime
 * d'un workspace qui n'a simplement rien déclaré.
 */
function resolveSender(
  requested: unknown,
  metadata: Record<string, unknown> | null | undefined,
): string {
  if (typeof requested !== "string" || !requested.trim()) return DEFAULT_SENDER;

  const wanted = emailOf(requested);
  if (!wanted) return DEFAULT_SENDER;

  const declared = Array.isArray(metadata?.allowed_senders)
    ? (metadata!.allowed_senders as unknown[])
    : [];
  const allowed = declared
    .filter((s): s is string => typeof s === "string")
    .map((s) => emailOf(s))
    .filter((s): s is string => !!s);

  return allowed.includes(wanted) ? requested : DEFAULT_SENDER;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });

    const { workspace_id, project_id, to, subject, html, text, from } = await req.json();
    if (!workspace_id || !project_id || !to || !subject || (!html && !text)) {
      return jsonResponse({ error: "workspace_id, project_id, to, subject, html|text required" }, { status: 400 });
    }

    const admin = createServiceClient();

    // Allow the agent worker (service role) or a workspace owner/admin.
    //
    // `actorUserId` reste null sur le chemin machine-à-machine. La
    // journalisation, plus bas, lisait `userData.user.id` — une variable qui
    // n'existe pas dans cette branche : tout appel en clé service role levait
    // une ReferenceError APRÈS l'envoi (FOS-22). Le message partait, la trace
    // d'audit ne s'écrivait pas, et l'appelant recevait une 500.
    let actorUserId: string | null = null;
    if (!isServiceCaller(req)) {
      const userClient = createUserClient(authHeader);
      const { data: userData } = await userClient.auth.getUser();
      if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      actorUserId = userData.user.id;
      const { data: m } = await admin
        .from("workspace_members").select("role")
        .eq("workspace_id", workspace_id).eq("user_id", userData.user.id).maybeSingle();
      if (!m || !["owner", "admin"].includes(m.role)) {
        return jsonResponse({ error: "Not authorized" }, { status: 403 });
      }
    }

    const { connector, payload } = await getConnectorCredential(workspace_id, project_id, "resend");
    const apiKey = payload.api_key;
    if (!apiKey) return jsonResponse({ error: "Resend api_key missing" }, { status: 400 });

    const sender = resolveSender(from, connector.metadata);

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: sender,
        to: Array.isArray(to) ? to : [to],
        subject,
        html: html ?? undefined,
        text: text ?? undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return jsonResponse({ error: "Resend rejected", detail: data }, { status: 502 });

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: actorUserId,
      event_type: "email.sent",
      title: `Email sent to ${Array.isArray(to) ? to.join(", ") : to}`,
      // L'expéditeur retenu est journalisé : si un envoi surprend, on doit
      // pouvoir dire sous quelle adresse il est parti.
      payload: { subject, provider: "resend", from: sender },
    });

    return jsonResponse({ ok: true, resend: data });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
