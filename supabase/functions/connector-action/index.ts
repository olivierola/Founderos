// connector-action — execute a safe, read-mostly action against a connected
// third-party tool (CRM / HR) on behalf of an agent. The credential is
// decrypted server-side and the official provider API is called; secrets never
// leave this function.
//
// Body: { workspace_id, project_id, provider, action, params? }
// Auth: user session (owner/admin/member) OR service role (agent worker).
//
// Outils internes (connecteurs personnalisés, migration 0267) — même fonction,
// un champ `mode` (le plafond de 100 fonctions est atteint) :
//
//   custom.call               service role : un collaborateur appelle une opération
//   custom.test               owner/admin  : tester la connexion ou une opération
//   custom.save_credential    owner/admin  : enregistrer / faire tourner un secret
//   custom.update_credential  owner/admin  : libellé, collaborateurs autorisés, expiration, révocation
//   custom.delete_credential  owner/admin
//   custom.oauth_start        owner/admin  : SSO utilisateur, renvoie l'URL d'autorisation
//   custom.oauth_callback     la personne qui a lancé l'autorisation
//   custom.discover_oidc      owner/admin  : lire /.well-known/openid-configuration
//   relay.create / relay.rotate / relay.revoke   owner/admin (le jeton n'est montré qu'une fois)
//   relay.claim / relay.complete                 le relais, en-tête X-Relay-Token
//
// verify_jwt est désactivé pour cette fonction (le relais n'a qu'un jeton de
// relais) : chaque branche authentifie elle-même son appelant.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";
import { actionsFor, findAction } from "../_shared/connector-actions.ts";
import { timingSafeEqual } from "../_shared/authz.ts";
import {
  authenticateRelay, discoverOidc, executeCall, loadConnector, newRelayToken, oauthCallback, oauthStart,
  relayClaim, relayComplete, saveCredential,
} from "../_shared/custom-connectors.ts";

type Admin = ReturnType<typeof createServiceClient>;

async function sessionUser(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const { data, error } = await createUserClient(authHeader).auth.getUser();
  return error || !data.user ? null : data.user.id;
}

async function roleIn(admin: Admin, workspaceId: string, userId: string): Promise<string | null> {
  const { data } = await admin.from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  return (data as { role?: string } | null)?.role ?? null;
}

function isServiceCall(req: Request): boolean {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  return !!serviceKey && timingSafeEqual(authHeader, `Bearer ${serviceKey}`);
}

async function handleCustom(req: Request, admin: Admin, mode: string, body: Record<string, unknown>): Promise<Response> {
  // ── Le relais ─────────────────────────────────────────────────────────────
  if (mode === "relay.claim" || mode === "relay.complete") {
    const relay = await authenticateRelay(admin, req.headers.get("x-relay-token"));
    if (!relay) return jsonResponse({ error: "Jeton de relais inconnu ou révoqué" }, { status: 401 });
    if (mode === "relay.complete") {
      const ok = await relayComplete(admin, relay, body);
      return jsonResponse({ ok });
    }
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
    const job = await relayClaim(admin, relay, {
      version: typeof body.version === "string" ? body.version : undefined,
      hostname: typeof body.hostname === "string" ? body.hostname : undefined,
      allowed_hosts: Array.isArray(body.allowed_hosts) ? body.allowed_hosts.map(String) : [],
      allowed_binaries: Array.isArray(body.allowed_binaries) ? body.allowed_binaries.map(String) : [],
      ip,
    }, Number(body.wait_ms ?? 20_000));
    return jsonResponse({ ok: true, job });
  }

  // ── L'appel d'un collaborateur (runtime, service role) ───────────────────
  if (mode === "custom.call") {
    if (!isServiceCall(req)) return jsonResponse({ error: "Réservé au runtime" }, { status: 403 });
    const out = await executeCall(admin, {
      connectorId: String(body.connector_id ?? ""),
      operation: String(body.operation ?? ""),
      params: (body.params && typeof body.params === "object") ? body.params as Record<string, unknown> : {},
      raw: (body.raw && typeof body.raw === "object") ? body.raw as Record<string, never> : undefined,
      credentialId: typeof body.credential_id === "string" ? body.credential_id : null,
      allowedOperations: Array.isArray(body.allowed_operations) ? body.allowed_operations.map(String) : null,
      source: body.source === "approval" ? "approval" : "collaborator",
      agentId: typeof body.agent_id === "string" ? body.agent_id : null,
      runId: typeof body.run_id === "string" ? body.run_id : null,
      conversationId: typeof body.conversation_id === "string" ? body.conversation_id : null,
      actorUserId: typeof body.actor_user_id === "string" ? body.actor_user_id : null,
      approvalId: typeof body.approval_id === "string" ? body.approval_id : null,
    });
    return jsonResponse(out, { status: out.ok ? 200 : out.decision === "blocked" ? 403 : 502 });
  }

  // ── Tout le reste : une personne, owner ou admin ─────────────────────────
  const userId = await sessionUser(req);
  if (!userId) return jsonResponse({ error: "Session invalide" }, { status: 401 });

  if (mode === "custom.oauth_callback") {
    try {
      const out = await oauthCallback(admin, { code: String(body.code ?? ""), state: String(body.state ?? ""), userId });
      return jsonResponse({ ok: true, ...out });
    } catch (e) {
      return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Le workspace se déduit de l'objet visé, jamais du corps de la requête.
  let workspaceId = "";
  let projectId = "";
  if (mode.startsWith("relay.")) {
    if (mode === "relay.create") {
      workspaceId = String(body.workspace_id ?? "");
      projectId = String(body.project_id ?? "");
    } else {
      const { data } = await admin.from("connector_relays").select("workspace_id, project_id").eq("id", String(body.relay_id ?? "")).maybeSingle();
      workspaceId = (data as { workspace_id?: string } | null)?.workspace_id ?? "";
      projectId = (data as { project_id?: string } | null)?.project_id ?? "";
    }
  } else {
    let connectorId = String(body.connector_id ?? "");
    if (!connectorId && body.credential_id) {
      const { data } = await admin.from("custom_connector_credentials").select("connector_id").eq("id", String(body.credential_id)).maybeSingle();
      connectorId = (data as { connector_id?: string } | null)?.connector_id ?? "";
    }
    const c = connectorId ? await loadConnector(admin, connectorId) : null;
    if (!c) return jsonResponse({ error: "Connecteur introuvable" }, { status: 404 });
    workspaceId = c.workspace_id;
    projectId = c.project_id;
  }
  if (!workspaceId) return jsonResponse({ error: "Espace introuvable" }, { status: 404 });
  const role = await roleIn(admin, workspaceId, userId);
  if (!role || !["owner", "admin"].includes(role)) {
    return jsonResponse({ error: "Réservé aux owners et admins de l'espace" }, { status: 403 });
  }

  const log = (event: string, title: string, payload: Record<string, unknown>) =>
    admin.from("activity_logs").insert({
      workspace_id: workspaceId, project_id: projectId || null, actor_user_id: userId,
      event_type: event, title, payload,
    }).then(() => {}, () => {});

  try {
    switch (mode) {
      case "custom.test": {
        const c = (await loadConnector(admin, String(body.connector_id)))!;
        const ops = Array.isArray(c.operations) ? c.operations as Array<{ name?: string; risk?: string }> : [];
        const policy = (c.policy ?? {}) as { test_operation?: string };
        const opName = String(body.operation ?? "") || policy.test_operation
          || ops.find((o) => o.risk === "read")?.name || "";
        if (!opName) return jsonResponse({ ok: false, text: "Aucune opération de lecture à tester : déclarez-en une." });
        const out = await executeCall(admin, {
          connectorId: c.id, operation: opName,
          params: (body.params && typeof body.params === "object") ? body.params as Record<string, unknown> : {},
          raw: (body.raw && typeof body.raw === "object") ? body.raw as Record<string, never> : undefined,
          credentialId: typeof body.credential_id === "string" ? body.credential_id : null,
          source: "test", actorUserId: userId, confirm: body.confirm === true,
        });
        // Seul un test de la connexion (pas d'une opération choisie) fait foi.
        if (!body.operation) {
          await admin.from("custom_connectors").update({
            last_test_at: new Date().toISOString(), last_test_ok: out.ok, last_test_detail: out.text.slice(0, 500),
          }).eq("id", c.id);
        }
        return jsonResponse({ ...out, operation: opName });
      }
      case "custom.save_credential": {
        const { id } = await saveCredential(admin, {
          connectorId: String(body.connector_id),
          credentialId: typeof body.credential_id === "string" ? body.credential_id : null,
          label: typeof body.label === "string" ? body.label : undefined,
          location: body.location === "relay" ? "relay" : "cloud",
          secrets: (body.secrets && typeof body.secrets === "object") ? body.secrets as Record<string, string> : {},
          relayRefs: (body.relay_refs && typeof body.relay_refs === "object") ? body.relay_refs as Record<string, string> : {},
          identity: typeof body.identity === "string" ? body.identity : undefined,
          expiresAt: typeof body.expires_at === "string" ? body.expires_at : body.expires_at === null ? null : undefined,
          allowedAgentIds: Array.isArray(body.allowed_agent_ids) ? body.allowed_agent_ids.map(String) : undefined,
          userId,
        });
        await log("custom_connector.credential_saved", "Identifiant d'outil interne enregistré",
          { connector_id: body.connector_id, credential_id: id, rotated: !!body.credential_id });
        return jsonResponse({ ok: true, id });
      }
      case "custom.update_credential": {
        const patch: Record<string, unknown> = {};
        if (typeof body.label === "string") patch.label = body.label.slice(0, 80);
        if (Array.isArray(body.allowed_agent_ids)) patch.allowed_agent_ids = body.allowed_agent_ids.map(String);
        if (body.expires_at === null || typeof body.expires_at === "string") patch.expires_at = body.expires_at || null;
        if (typeof body.identity === "string") patch.identity = body.identity || null;
        if (body.status === "revoked") {
          Object.assign(patch, { status: "revoked", encrypted_payload: null, iv: null, token_enc: null, token_iv: null, token_expires_at: null });
        }
        const { error } = await admin.from("custom_connector_credentials").update(patch).eq("id", String(body.credential_id));
        if (error) throw new Error(error.message);
        await log("custom_connector.credential_updated", "Identifiant d'outil interne modifié", { credential_id: body.credential_id, fields: Object.keys(patch) });
        return jsonResponse({ ok: true });
      }
      case "custom.delete_credential": {
        const { error } = await admin.from("custom_connector_credentials").delete().eq("id", String(body.credential_id));
        if (error) throw new Error(error.message);
        await log("custom_connector.credential_deleted", "Identifiant d'outil interne supprimé", { credential_id: body.credential_id });
        return jsonResponse({ ok: true });
      }
      case "custom.oauth_start": {
        const redirect = String(body.redirect_uri ?? "");
        if (!/^https?:\/\//i.test(redirect)) throw new Error("redirect_uri invalide");
        const out = await oauthStart(admin, {
          connectorId: String(body.connector_id), label: String(body.label ?? "SSO"), redirectUri: redirect,
          clientSecret: typeof body.client_secret === "string" ? body.client_secret : undefined, userId,
        });
        return jsonResponse({ ok: true, ...out });
      }
      case "custom.discover_oidc": {
        const out = await discoverOidc(admin, String(body.connector_id), String(body.issuer ?? ""));
        return jsonResponse({ ok: true, ...out });
      }
      case "relay.create": {
        const name = String(body.name ?? "").trim().slice(0, 80);
        if (!name || !projectId) throw new Error("Nom et projet requis.");
        const t = await newRelayToken();
        const { data, error } = await admin.from("connector_relays").insert({
          workspace_id: workspaceId, project_id: projectId, name, token_hash: t.hash, token_hint: t.hint, created_by: userId,
        }).select("id").single();
        if (error || !data) throw new Error(error?.message ?? "Création impossible");
        await log("connector_relay.created", `Relais « ${name} » créé`, { relay_id: data.id });
        return jsonResponse({ ok: true, id: data.id, token: t.token });
      }
      case "relay.rotate": {
        const t = await newRelayToken();
        const { error } = await admin.from("connector_relays")
          .update({ token_hash: t.hash, token_hint: t.hint, status: "active", revoked_at: null }).eq("id", String(body.relay_id));
        if (error) throw new Error(error.message);
        await log("connector_relay.rotated", "Jeton de relais renouvelé", { relay_id: body.relay_id });
        return jsonResponse({ ok: true, token: t.token });
      }
      case "relay.revoke": {
        const { error } = await admin.from("connector_relays")
          .update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("id", String(body.relay_id));
        if (error) throw new Error(error.message);
        await admin.from("connector_relay_jobs").update({ status: "expired" })
          .eq("relay_id", String(body.relay_id)).in("status", ["queued", "claimed"]);
        await log("connector_relay.revoked", "Relais révoqué", { relay_id: body.relay_id });
        return jsonResponse({ ok: true });
      }
      default:
        return jsonResponse({ error: `Mode inconnu : ${mode}` }, { status: 400 });
    }
  } catch (e) {
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = createServiceClient();
    const body = await req.json();
    const mode = typeof body?.mode === "string" ? body.mode : "";
    if (mode) return await handleCustom(req, admin, mode, body);

    const { workspace_id, project_id, provider, action } = body as {
      workspace_id?: string; project_id?: string; provider?: string; action?: string;
    };
    if (!workspace_id || !project_id || !provider) {
      return jsonResponse({ error: "workspace_id, project_id, provider required" }, { status: 400 });
    }

    // Auth: service role (agent worker) or a workspace member.
    const authHeader = req.headers.get("Authorization") ?? "";
    const isService = isServiceCall(req);
    if (!isService) {
      if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
      const userClient = createUserClient(authHeader);
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      const { data: m } = await admin
        .from("workspace_members").select("role")
        .eq("workspace_id", workspace_id).eq("user_id", userData.user.id).maybeSingle();
      if (!m || !["owner", "admin", "member"].includes(m.role)) {
        return jsonResponse({ error: "Not authorized" }, { status: 403 });
      }
    }

    // Discovery: no action → list available actions for this provider.
    const available = actionsFor(provider);
    if (available.length === 0) {
      return jsonResponse({ error: `No actions available for provider "${provider}"` }, { status: 400 });
    }
    if (!action) {
      // `write` fait partie de la découverte : un écran qui propose ces actions
      // doit pouvoir signaler celles qui envoient ou créent quelque chose —
      // sinon « poster dans Slack » se choisit aussi légèrement que « lister
      // les deals », et la différence n'apparaît qu'à l'exécution.
      return jsonResponse({
        provider,
        actions: available.map((a) => ({
          name: a.name, description: a.description, params: a.params ?? {}, write: a.write === true,
        })),
      });
    }

    const def = findAction(provider, action);
    if (!def) {
      return jsonResponse({ error: `Unknown action "${action}" for ${provider}`, available: available.map((a) => a.name) }, { status: 400 });
    }

    // Decrypt the credential and run the action.
    let cred: Record<string, string>;
    try {
      ({ payload: cred } = await getConnectorCredential(workspace_id, project_id, provider));
    } catch {
      return jsonResponse({ error: `${provider} is not connected for this project` }, { status: 400 });
    }

    let result: unknown;
    try {
      result = await def.run(cred, (body.params && typeof body.params === "object") ? body.params : {});
    } catch (e) {
      return jsonResponse({ error: `Action failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
    }

    // Audit + cap the payload so a huge response doesn't blow the context window.
    admin.from("activity_logs").insert({
      workspace_id, project_id,
      event_type: `connector_action.${provider}.${action}`,
      title: `Agent ran ${provider}.${action}`,
      payload: { provider, action },
    }).then(() => {});

    const json = JSON.stringify(result ?? null);
    const capped = json.length > 14000
      ? { note: "Result truncated (too large)", preview: json.slice(0, 14000) }
      : result;
    return jsonResponse({ ok: true, provider, action, result: capped });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
