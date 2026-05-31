// role-upsert — create or update a custom role with its permissions.
// Body: { workspace_id, role_id?, slug, name, description?, color?, permissions: string[] }
// Requires `settings.roles.manage` on at least one project of the workspace.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(auth);
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const body = await req.json();
    const { workspace_id, role_id, slug, name, description, color, permissions } = body as {
      workspace_id?: string;
      role_id?: string;
      slug?: string;
      name?: string;
      description?: string;
      color?: string;
      permissions?: string[];
    };
    if (!workspace_id || !slug || !name || !Array.isArray(permissions)) {
      return jsonResponse(
        { error: "workspace_id, slug, name, permissions[] required" },
        { status: 400 },
      );
    }

    const admin = createServiceClient();

    // Workspace membership check (any active project member with roles.manage).
    const { data: anyProject } = await admin
      .from("projects")
      .select("id")
      .eq("workspace_id", workspace_id)
      .limit(1)
      .maybeSingle();
    if (!anyProject) return jsonResponse({ error: "Workspace has no projects" }, { status: 400 });
    const { data: ok } = await admin.rpc("has_permission", {
      p_user: u.user.id,
      p_project: anyProject.id,
      p_perm: "settings.roles.manage",
    });
    if (!ok) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    // Reject any attempt to touch a system role.
    if (role_id) {
      const { data: existing } = await admin
        .from("roles")
        .select("is_system, workspace_id")
        .eq("id", role_id)
        .maybeSingle();
      if (!existing) return jsonResponse({ error: "Role not found" }, { status: 404 });
      if (existing.is_system) {
        return jsonResponse({ error: "Cannot edit a built-in role" }, { status: 403 });
      }
      if (existing.workspace_id !== workspace_id) {
        return jsonResponse({ error: "Role belongs to a different workspace" }, { status: 403 });
      }
    }

    // Filter permissions against the catalogue to avoid garbage entries.
    const { data: validPerms } = await admin.from("permissions").select("key");
    const validSet = new Set((validPerms ?? []).map((p) => p.key));
    const cleanedPerms = permissions.filter((p) => validSet.has(p));

    // Upsert the role row.
    const safeSlug = slug.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
    const { data: saved, error } = await admin
      .from("roles")
      .upsert(
        {
          id: role_id ?? undefined,
          workspace_id,
          slug: safeSlug,
          name,
          description: description ?? null,
          color: color ?? null,
          is_system: false,
        },
        { onConflict: role_id ? "id" : "workspace_id,slug" },
      )
      .select("id")
      .single();
    if (error || !saved) {
      return jsonResponse({ error: "Could not save role", detail: error?.message }, { status: 500 });
    }

    // Replace permissions atomically (delete + insert).
    await admin.from("role_permissions").delete().eq("role_id", saved.id);
    if (cleanedPerms.length > 0) {
      await admin
        .from("role_permissions")
        .insert(cleanedPerms.map((permission_key) => ({ role_id: saved.id, permission_key })));
    }

    return jsonResponse({ ok: true, role_id: saved.id });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
