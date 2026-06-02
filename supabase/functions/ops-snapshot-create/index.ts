// ops-snapshot-create — save an immutable snapshot of an infra project's
// current state. The snapshot captures the umbrella row, all its layers, all
// generated files, and the latest topology per bundle. Use to checkpoint
// before risky regenerations or to "save without deploying".
//
// Body: { infra_id, label?, message? }
// Returns: { ok, snapshot_id, version }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const { infra_id, label, message } = await req.json();
    if (!infra_id) return jsonResponse({ ok: false, message: "infra_id required" }, { status: 400 });

    const userClient = createUserClient(req);
    const { data: userInfo, error: authErr } = await userClient.auth.getUser();
    if (authErr || !userInfo?.user) {
      return jsonResponse({ ok: false, message: "Unauthenticated" }, { status: 401 });
    }
    const userId = userInfo.user.id;

    const admin = createServiceClient();

    // 1. Umbrella row.
    const { data: infra, error: infraErr } = await admin
      .from("ops_infra_projects")
      .select("*")
      .eq("id", infra_id)
      .maybeSingle();
    if (infraErr || !infra) return jsonResponse({ ok: false, message: "Infra not found" }, { status: 404 });

    // 2. Layers.
    const { data: layers } = await admin
      .from("ops_infra_layers")
      .select("*")
      .eq("infra_project_id", infra_id)
      .order("position");

    // 3. Files for each layer's bundle.
    const bundleIds = (layers ?? []).map((l) => l.bundle_id).filter(Boolean);
    const { data: files } = bundleIds.length > 0
      ? await admin
          .from("ops_generated_files")
          .select("bundle_id, file_path, file_type, content, status")
          .in("bundle_id", bundleIds)
      : { data: [] };

    // 4. Latest topology per bundle.
    const { data: topologies } = bundleIds.length > 0
      ? await admin
          .from("ops_topologies")
          .select("bundle_id, summary, topology, created_at")
          .in("bundle_id", bundleIds)
          .order("created_at", { ascending: false })
      : { data: [] };

    // De-dup topologies: keep the latest per bundle.
    const topoByBundle = new Map<string, any>();
    for (const t of (topologies ?? []) as any[]) {
      if (!topoByBundle.has(t.bundle_id)) topoByBundle.set(t.bundle_id, t);
    }

    // 5. Group files by bundle.
    const filesByBundle = new Map<string, any[]>();
    for (const f of (files ?? []) as any[]) {
      const arr = filesByBundle.get(f.bundle_id) ?? [];
      arr.push({
        file_path: f.file_path,
        file_type: f.file_type,
        content: f.content,
        status: f.status,
      });
      filesByBundle.set(f.bundle_id, arr);
    }

    const payload = {
      infra: {
        name: infra.name,
        brief: infra.brief,
        plan: infra.plan,
        plan_status: infra.plan_status,
        metadata: infra.metadata,
      },
      layers: (layers ?? []).map((l) => ({
        layer_key: l.layer_key,
        label: l.label,
        tool: l.tool,
        purpose: l.purpose,
        position: l.position,
        status: l.status,
        bundle_id: l.bundle_id,
      })),
      bundles: bundleIds.map((bid) => ({
        bundle_id: bid,
        files: filesByBundle.get(bid) ?? [],
      })),
      topologies: bundleIds
        .filter((bid) => topoByBundle.has(bid))
        .map((bid) => {
          const t = topoByBundle.get(bid);
          return { bundle_id: bid, summary: t.summary, topology: t.topology };
        }),
    };

    // 6. Allocate version + insert.
    const { data: nextVer } = await admin.rpc("next_ops_snapshot_version", { p_infra_id: infra_id });
    const version = Number(nextVer ?? 1);
    const finalLabel = label?.trim() || `Snapshot v${version}`;

    const { data: snap, error: snapErr } = await admin
      .from("ops_infra_snapshots")
      .insert({
        workspace_id: infra.workspace_id,
        project_id: infra.project_id,
        infra_project_id: infra_id,
        label: finalLabel,
        version,
        message: message ?? null,
        payload,
        created_by: userId,
      })
      .select("id, version")
      .single();
    if (snapErr) throw snapErr;

    return jsonResponse({ ok: true, snapshot_id: snap.id, version: snap.version });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});
