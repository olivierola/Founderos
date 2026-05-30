// propagate-credential — push an app-level secret (e.g. STRIPE_SECRET_KEY) to
// the customer's own backend(s): Supabase Secrets, Vercel env, Railway,
// Render, Cloudflare, AWS SSM, RunPod, Firebase.
//
// Body: {
//   workspace_id, project_id,
//   key,                          // e.g. "STRIPE_SECRET_KEY"
//
//   // Source of the value — exactly one of:
//   value?: string,               // plaintext provided by the client
//   source?: {                    // OR: reuse a credential already in the vault
//     provider: string,           // e.g. "stripe"
//     field: string,              // e.g. "secret_key" (key inside the encrypted payload)
//   },
//
//   targets: [
//     { provider: "supabase",   env_name?: "STRIPE_SECRET_KEY", metadata?: {...} },
//     { provider: "vercel",     env_name?: "STRIPE_SECRET_KEY", metadata: { vercel_project_id, targets: ["production","preview"] } },
//     ...
//   ],
//   store_locally?: boolean       // default true when value is provided
// }
//
// Response: { results: [{ provider, env_name, ok, error?, metadata? }] }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { encryptSecret } from "../_shared/crypto.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";
import { runPropagator, type PropagationTarget } from "../_shared/propagators.ts";

interface TargetSpec {
  provider: PropagationTarget;
  env_name?: string;
  metadata?: Record<string, unknown>;
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
    const {
      workspace_id,
      project_id,
      key,
      value,
      source,
      targets,
      store_locally,
    } = body as {
      workspace_id?: string;
      project_id?: string;
      key?: string;
      value?: string;
      source?: { provider: string; field: string };
      targets?: TargetSpec[];
      store_locally?: boolean;
    };

    if (!workspace_id || !project_id || !key || !Array.isArray(targets)) {
      return jsonResponse(
        { error: "workspace_id, project_id, key, targets[] required" },
        { status: 400 },
      );
    }
    if (!value && !source) {
      return jsonResponse(
        { error: "Either `value` or `source: { provider, field }` is required" },
        { status: 400 },
      );
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

    /* 1) Resolve the plaintext to push. Either:
          - the client supplied `value` directly (manual entry / rotation),
          - or `source: { provider, field }` points to an existing vault
            credential (e.g. Stripe.secret_key) — we decrypt server-side and
            never echo the plaintext back to the browser. */
    let plaintextValue: string | null = value ?? null;
    let resolvedFromVault = false;

    if (!plaintextValue && source) {
      try {
        const { payload } = await getConnectorCredential(workspace_id, project_id, source.provider);
        const fromVault = payload[source.field];
        if (!fromVault) {
          return jsonResponse(
            { error: `Field "${source.field}" not found in ${source.provider} credential` },
            { status: 400 },
          );
        }
        plaintextValue = fromVault;
        resolvedFromVault = true;
      } catch (e) {
        return jsonResponse(
          { error: `Could not read ${source.provider} from vault`, detail: e instanceof Error ? e.message : String(e) },
          { status: 400 },
        );
      }
    }

    if (!plaintextValue) {
      return jsonResponse({ error: "No value resolved" }, { status: 400 });
    }

    /* 2) Optionally persist a copy under a synthetic connector
          "app-secret:<KEY>". Default: only persist when the user typed the
          value (a vault-sourced credential already lives in its own connector,
          re-storing it would duplicate). */
    const shouldStore = store_locally ?? !resolvedFromVault;
    if (shouldStore) {
      const syntheticProvider = `app-secret:${key}`;
      const { data: connector } = await admin
        .from("connectors")
        .upsert(
          {
            workspace_id,
            project_id,
            provider: syntheticProvider,
            status: "connected",
            permissions: "managed",
            metadata: { kind: "app-secret", key, source: source ?? null },
          },
          { onConflict: "workspace_id,project_id,provider" },
        )
        .select()
        .single();

      if (connector) {
        const enc = JSON.stringify({ value: plaintextValue });
        const { ciphertext, iv } = await encryptSecret(enc);
        await admin.from("encrypted_credentials").delete().eq("connector_id", connector.id);
        await admin.from("encrypted_credentials").insert({
          workspace_id,
          connector_id: connector.id,
          encrypted_payload: ciphertext,
          iv,
          key_version: "v1",
        });
      }
    }

    /* 2) Push to each target, recording status in propagated_secrets. */
    const results: Array<{
      provider: string;
      env_name: string;
      ok: boolean;
      error?: string;
      metadata?: Record<string, unknown>;
    }> = [];

    for (const t of targets) {
      const envName = t.env_name?.trim() || key;
      const result = await runPropagator(t.provider, {
        workspaceId: workspace_id,
        projectId: project_id,
        key,
        value: plaintextValue,
        envName,
        metadata: t.metadata,
      });

      await admin.from("propagated_secrets").upsert(
        {
          workspace_id,
          project_id,
          key,
          target_provider: t.provider,
          env_name: envName,
          status: result.ok ? "synced" : "error",
          last_synced_at: result.ok ? new Date().toISOString() : null,
          last_error: result.ok ? null : (result.error ?? "Unknown error"),
          metadata: result.metadata ?? {},
          updated_at: new Date().toISOString(),
        },
        { onConflict: "project_id,key,target_provider,env_name" },
      );

      results.push({
        provider: t.provider,
        env_name: envName,
        ok: result.ok,
        error: result.error,
        metadata: result.metadata,
      });
    }

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: userId,
      event_type: "credential.propagated",
      title: `Propagated ${key} to ${results.length} backend(s)`,
      payload: {
        key,
        targets: results.map((r) => ({ provider: r.provider, ok: r.ok })),
      },
    });

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
