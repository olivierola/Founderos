// ops-snapshot-restore — rewrite an infra project's current state to match
// a previously-saved snapshot. Existing layers / bundles / files / topologies
// for this infra are deleted, then re-inserted from the snapshot payload.
//
// Body: { snapshot_id }
// Returns: { ok, infra_id, layers_restored }
//
// Notes:
//   - This is a destructive operation in the sense that any work-in-progress
//     since the snapshot is wiped. We auto-create a "pre-restore" snapshot of
//     the current state so the user can undo the restore.
//   - The infra_project row itself is updated (not deleted), so URLs / FKs
//     in other tables stay valid.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

interface Payload {
  infra: { name: string; brief?: string | null; plan: any; plan_status: string; metadata?: any };
  layers: Array<{ layer_key: string; label: string; tool: string; purpose?: string | null; position: number; status: string; bundle_id?: string | null }>;
  bundles: Array<{ bundle_id: string; files: Array<{ file_path: string; file_type: string; content: string; status: string }> }>;
  topologies: Array<{ bundle_id: string; summary?: string | null; topology: any }>;
}

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    const { snapshot_id } = await req.json();
    if (!snapshot_id) return jsonResponse({ ok: false, message: "snapshot_id required" }, { status: 400 });

    const userClient = createUserClient(req);
    const { data: userInfo, error: authErr } = await userClient.auth.getUser();
    if (authErr || !userInfo?.user) {
      return jsonResponse({ ok: false, message: "Unauthenticated" }, { status: 401 });
    }
    const userId = userInfo.user.id;

    const admin = createServiceClient();

    const { data: snap } = await admin
      .from("ops_infra_snapshots")
      .select("*")
      .eq("id", snapshot_id)
      .maybeSingle();
    if (!snap) return jsonResponse({ ok: false, message: "Snapshot not found" }, { status: 404 });

    const payload = snap.payload as Payload;
    const infraId = snap.infra_project_id as string;
    const workspaceId = snap.workspace_id as string;
    const projectId = snap.project_id as string;

    // 1. Auto-checkpoint the current state before destroying it.
    const { data: prevSnapVer } = await admin.rpc("next_ops_snapshot_version", { p_infra_id: infraId });
    // Build a quick payload of the current state (we reuse the snapshot-create
    // logic inline to avoid a recursive edge call).
    const { data: curInfra } = await admin.from("ops_infra_projects").select("*").eq("id", infraId).maybeSingle();
    const { data: curLayers } = await admin.from("ops_infra_layers").select("*").eq("infra_project_id", infraId);
    const curBundleIds = (curLayers ?? []).map((l: any) => l.bundle_id).filter(Boolean);
    const { data: curFiles } = curBundleIds.length > 0
      ? await admin.from("ops_generated_files").select("bundle_id, file_path, file_type, content, status").in("bundle_id", curBundleIds)
      : { data: [] };
    const { data: curTopos } = curBundleIds.length > 0
      ? await admin.from("ops_topologies").select("bundle_id, summary, topology, created_at").in("bundle_id", curBundleIds).order("created_at", { ascending: false })
      : { data: [] };
    const curFilesByBundle = new Map<string, any[]>();
    for (const f of (curFiles ?? []) as any[]) {
      const arr = curFilesByBundle.get(f.bundle_id) ?? [];
      arr.push({ file_path: f.file_path, file_type: f.file_type, content: f.content, status: f.status });
      curFilesByBundle.set(f.bundle_id, arr);
    }
    const curTopoByBundle = new Map<string, any>();
    for (const t of (curTopos ?? []) as any[]) {
      if (!curTopoByBundle.has(t.bundle_id)) curTopoByBundle.set(t.bundle_id, t);
    }
    await admin.from("ops_infra_snapshots").insert({
      workspace_id: workspaceId,
      project_id: projectId,
      infra_project_id: infraId,
      label: `Auto pre-restore (before v${snap.version})`,
      version: Number(prevSnapVer ?? 1),
      message: `Auto-saved before restoring snapshot ${snap.version}`,
      payload: {
        infra: curInfra ? {
          name: curInfra.name, brief: curInfra.brief, plan: curInfra.plan,
          plan_status: curInfra.plan_status, metadata: curInfra.metadata,
        } : null,
        layers: (curLayers ?? []).map((l: any) => ({
          layer_key: l.layer_key, label: l.label, tool: l.tool, purpose: l.purpose,
          position: l.position, status: l.status, bundle_id: l.bundle_id,
        })),
        bundles: curBundleIds.map((bid: string) => ({
          bundle_id: bid, files: curFilesByBundle.get(bid) ?? [],
        })),
        topologies: curBundleIds
          .filter((bid: string) => curTopoByBundle.has(bid))
          .map((bid: string) => {
            const t = curTopoByBundle.get(bid);
            return { bundle_id: bid, summary: t.summary, topology: t.topology };
          }),
      },
      created_by: userId,
    });

    // 2. Wipe current children of the infra. The CASCADE on
    //    ops_infra_layers.infra_project_id takes care of layers, then we
    //    explicitly delete the bundles/files/topologies that were linked.
    await admin.from("ops_generated_files").delete().in("bundle_id", curBundleIds.length > 0 ? curBundleIds : ["00000000-0000-0000-0000-000000000000"]);
    await admin.from("ops_topologies").delete().in("bundle_id", curBundleIds.length > 0 ? curBundleIds : ["00000000-0000-0000-0000-000000000000"]);
    await admin.from("ops_infra_layers").delete().eq("infra_project_id", infraId);

    // 3. Restore the umbrella row.
    await admin.from("ops_infra_projects").update({
      name: payload.infra?.name ?? curInfra?.name,
      brief: payload.infra?.brief ?? null,
      plan: payload.infra?.plan ?? {},
      plan_status: payload.infra?.plan_status ?? "generated",
      metadata: payload.infra?.metadata ?? {},
      updated_at: new Date().toISOString(),
    }).eq("id", infraId);

    // 4. Restore bundles (one row per file).
    const fileRows = (payload.bundles ?? []).flatMap((b) =>
      b.files.map((f) => ({
        workspace_id: workspaceId,
        project_id: projectId,
        bundle_id: b.bundle_id,
        bundle_label: null,
        file_path: f.file_path,
        file_type: f.file_type,
        content: f.content,
        status: f.status ?? "draft",
      })),
    );
    if (fileRows.length > 0) {
      await admin.from("ops_generated_files").insert(fileRows);
    }

    // 5. Restore topologies.
    const topoRows = (payload.topologies ?? []).map((t) => ({
      workspace_id: workspaceId,
      project_id: projectId,
      bundle_id: t.bundle_id,
      summary: t.summary ?? null,
      topology: t.topology,
      source: "ai" as const,
    }));
    if (topoRows.length > 0) {
      await admin.from("ops_topologies").insert(topoRows);
    }

    // 6. Restore layers — re-create them with their saved bundle_id.
    const layerRows = (payload.layers ?? []).map((l) => ({
      infra_project_id: infraId,
      workspace_id: workspaceId,
      project_id: projectId,
      layer_key: l.layer_key,
      label: l.label,
      tool: l.tool,
      purpose: l.purpose ?? null,
      bundle_id: l.bundle_id ?? null,
      status: l.status,
      position: l.position,
    }));
    if (layerRows.length > 0) {
      await admin.from("ops_infra_layers").insert(layerRows);
    }

    return jsonResponse({ ok: true, infra_id: infraId, layers_restored: layerRows.length });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e?.message ?? "Internal error" }, { status: 500 });
  }
});
