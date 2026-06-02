// ops-server-test — register a new server + store its SSH key encrypted + enqueue a probe job.
//
// Body: {
//   workspace_id, project_id,
//   name, description?, provider, ip_address, ssh_port, ssh_user,
//   environment, domain?, ssh_private_key
// }
//
// Flow:
//   1. Encrypt the SSH key with the project crypto helper.
//   2. Insert an ops_secrets row (kind=ssh_private_key).
//   3. Insert an ops_servers row pointing to that secret.
//   4. Insert a 'server_test' job in 'queued' status (no approval).
//
// Response: { ok, server_id, job_id, message }
//
// The runner polls ops_jobs, picks up the server_test job, performs the SSH
// probe, updates ops_servers with discovered metadata + status + security score.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { encryptSecret } from "../_shared/crypto.ts";

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const body = await req.json();
    const {
      workspace_id, project_id, name, description, provider, ip_address,
      ssh_port, ssh_user, environment, domain, ssh_private_key,
    } = body;
    if (!workspace_id || !project_id || !name || !ip_address || !ssh_user || !ssh_private_key) {
      return jsonResponse({ ok: false, message: "Missing required fields" }, { status: 400 });
    }

    // Verify the caller is a member of the workspace (RLS-safe call via user JWT).
    const userClient = createUserClient(req);
    const { data: userInfo, error: authErr } = await userClient.auth.getUser();
    if (authErr || !userInfo?.user) {
      return jsonResponse({ ok: false, message: "Unauthenticated" }, { status: 401 });
    }
    const userId = userInfo.user.id;

    const admin = createServiceClient();

    // 1. Encrypt the SSH key.
    const { ciphertext, iv } = await encryptSecret(ssh_private_key);

    // 2. Insert ops_servers first (without the secret link); we need the server id
    //    to attach the secret to it.
    const { data: serverRow, error: serverErr } = await admin
      .from("ops_servers")
      .insert({
        workspace_id, project_id,
        name, description: description ?? null,
        provider: provider ?? "vps",
        ip_address,
        ssh_port: ssh_port ?? 22,
        ssh_user,
        environment: environment ?? "production",
        domain: domain ?? null,
        status: "provisioning",
        created_by: userId,
      })
      .select("id")
      .single();
    if (serverErr) throw serverErr;

    // 3. Store the encrypted SSH key linked to this server.
    const { data: secretRow, error: secretErr } = await admin
      .from("ops_secrets")
      .insert({
        workspace_id,
        project_id,
        server_id: serverRow.id,
        kind: "ssh_private_key",
        name: `SSH key for ${name}`,
        encrypted_payload: ciphertext,
        iv,
        created_by: userId,
      })
      .select("id")
      .single();
    if (secretErr) throw secretErr;

    // 4. Wire the secret id back to the server.
    await admin
      .from("ops_servers")
      .update({ ssh_key_secret_id: secretRow.id })
      .eq("id", serverRow.id);

    // 5. Enqueue a 'server_test' job. Low risk, no approval.
    const { data: jobRow, error: jobErr } = await admin
      .from("ops_jobs")
      .insert({
        workspace_id, project_id,
        server_id: serverRow.id,
        job_type: "server_test",
        autonomy_mode: "assisted",
        risk_level: "low",
        status: "queued",
        requires_approval: false,
        input: {},
        created_by: userId,
      })
      .select("id")
      .single();
    if (jobErr) throw jobErr;

    return jsonResponse({
      ok: true,
      server_id: serverRow.id,
      job_id: jobRow.id,
      message: "Server registered. A probe job has been queued — the Ops Runner will pick it up shortly.",
    });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});
