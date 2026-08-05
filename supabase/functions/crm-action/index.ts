// crm-action — lets internal agents read and write the in-house CRM
// (crm_objects / crm_properties / crm_records). Same dual-auth + shared-write
// shape as connector-action/composio-action: the agent's `crm` tool calls
// this directly for reads and (on autopilot) writes, and the approval
// executor replays gated writes through the exact same endpoint.
//
// Body: { workspace_id, project_id, action, params? }
//   action ∈ list_objects | search_records | get_record | get_related
//          | create_record | update_record | delete_record
//          | link_records | unlink_records
// Auth: service role (agent worker) OR a workspace member session.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = createServiceClient();
    const body = await req.json();
    const { workspace_id, project_id, action, params } = body as {
      workspace_id?: string; project_id?: string; action?: string;
      params?: Record<string, unknown>;
    };
    if (!workspace_id || !project_id || !action) {
      return jsonResponse({ error: "workspace_id, project_id, action required" }, { status: 400 });
    }
    const p = (params && typeof params === "object") ? params : {};

    // Auth: service role (agent worker) or a workspace member.
    const authHeader = req.headers.get("Authorization") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const isService = !!serviceKey && authHeader === `Bearer ${serviceKey}`;
    let userId: string | null = null;
    if (!isService) {
      if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
      const userClient = createUserClient(authHeader);
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      userId = userData.user.id;
      const { data: m } = await admin
        .from("workspace_members").select("role")
        .eq("workspace_id", workspace_id).eq("user_id", userId).maybeSingle();
      if (!m || !["owner", "admin", "member"].includes(m.role)) {
        return jsonResponse({ error: "Not authorized" }, { status: 403 });
      }
    }

    // Resolve an object slug → its row (scoped to this project).
    async function objectBySlug(slug: string) {
      const { data } = await admin
        .from("crm_objects")
        .select("id, slug, label, title_property")
        .eq("project_id", project_id).eq("slug", slug)
        .maybeSingle();
      return data as { id: string; slug: string; label: string; title_property: string | null } | null;
    }

    // Resolve a relation property on a record's own object, by property key.
    // Returns the property row (with the object it points to) or null.
    async function relationPropForRecord(recordId: string, propKey: string) {
      const { data: rec } = await admin
        .from("crm_records").select("id, object_id")
        .eq("project_id", project_id).eq("id", recordId).maybeSingle();
      if (!rec) return { error: "Record not found" as const };
      const { data: prop } = await admin
        .from("crm_properties")
        .select("id, key, type, relation_object_id")
        .eq("project_id", project_id).eq("object_id", (rec as any).object_id).eq("key", propKey)
        .maybeSingle();
      if (!prop) return { error: `No property "${propKey}" on this record's object` as const };
      if ((prop as any).type !== "relation") return { error: `Property "${propKey}" is not a relation` as const };
      return { prop: prop as { id: string; key: string; relation_object_id: string | null } };
    }

    switch (action) {
      // ── Reads ──────────────────────────────────────────────────────────
      case "list_objects": {
        const { data: objects } = await admin
          .from("crm_objects")
          .select("id, slug, label, label_plural, title_property")
          .eq("project_id", project_id).order("position");
        const { data: props } = await admin
          .from("crm_properties")
          .select("object_id, key, label, type, required, relation_object_id")
          .eq("project_id", project_id).order("position");
        // Map object_id → slug so relation properties can name their target
        // object by slug (what link_records/get_related expect).
        const slugByObjectId = new Map<string, string>((objects ?? []).map((o) => [(o as any).id, (o as any).slug]));
        const propsByObject = new Map<string, unknown[]>();
        for (const pr of props ?? []) {
          const arr = propsByObject.get((pr as { object_id: string }).object_id) ?? [];
          arr.push({
            key: (pr as any).key, label: (pr as any).label, type: (pr as any).type, required: (pr as any).required,
            // For relation properties, tell the agent which object this links to.
            ...((pr as any).type === "relation"
              ? { relation_to: slugByObjectId.get((pr as any).relation_object_id) ?? null }
              : {}),
          });
          propsByObject.set((pr as { object_id: string }).object_id, arr);
        }
        return jsonResponse({
          ok: true,
          objects: (objects ?? []).map((o) => ({
            slug: (o as any).slug,
            label: (o as any).label,
            label_plural: (o as any).label_plural,
            title_property: (o as any).title_property ?? "name",
            properties: propsByObject.get((o as any).id) ?? [],
          })),
        });
      }

      case "search_records": {
        const obj = await objectBySlug(str(p.object));
        if (!obj) return jsonResponse({ error: `Unknown CRM object "${str(p.object)}"` }, { status: 400 });
        const limit = Math.min(Math.max(Number(p.limit) || 25, 1), 100);
        const { data: records } = await admin
          .from("crm_records")
          .select("id, data, created_at, updated_at")
          .eq("project_id", project_id).eq("object_id", obj.id)
          .order("updated_at", { ascending: false })
          .limit(500);
        const q = str(p.query).trim().toLowerCase();
        const rows = (records ?? []) as Array<{ id: string; data: Record<string, unknown>; created_at: string; updated_at: string }>;
        const filtered = (q
          ? rows.filter((r) => JSON.stringify(r.data ?? {}).toLowerCase().includes(q))
          : rows).slice(0, limit);
        const titleKey = obj.title_property ?? "name";
        return jsonResponse({
          ok: true,
          object: obj.slug,
          count: filtered.length,
          records: filtered.map((r) => ({ id: r.id, title: str(r.data?.[titleKey]), data: r.data ?? {} })),
        });
      }

      case "get_record": {
        const { data: rec } = await admin
          .from("crm_records")
          .select("id, object_id, data, created_at, updated_at")
          .eq("project_id", project_id).eq("id", str(p.record_id))
          .maybeSingle();
        if (!rec) return jsonResponse({ error: "Record not found" }, { status: 404 });
        return jsonResponse({ ok: true, record: rec });
      }

      // ── Writes ─────────────────────────────────────────────────────────
      case "create_record": {
        const obj = await objectBySlug(str(p.object));
        if (!obj) return jsonResponse({ error: `Unknown CRM object "${str(p.object)}"` }, { status: 400 });
        const fields = (p.fields && typeof p.fields === "object") ? p.fields as Record<string, unknown> : {};
        const { data: rec, error } = await admin
          .from("crm_records")
          .insert({ workspace_id, project_id, object_id: obj.id, data: fields, created_by: userId })
          .select("id, data").single();
        if (error) return jsonResponse({ error: error.message }, { status: 400 });
        admin.from("activity_logs").insert({
          workspace_id, project_id, actor_user_id: userId,
          event_type: `crm.create.${obj.slug}`, title: `Agent created a ${obj.label}`, payload: { object: obj.slug, record_id: (rec as any).id },
        }).then(() => {});
        return jsonResponse({ ok: true, record: rec });
      }

      case "update_record": {
        const fields = (p.fields && typeof p.fields === "object") ? p.fields as Record<string, unknown> : {};
        const { data: existing } = await admin
          .from("crm_records").select("id, data, object_id")
          .eq("project_id", project_id).eq("id", str(p.record_id)).maybeSingle();
        if (!existing) return jsonResponse({ error: "Record not found" }, { status: 404 });
        const merged = { ...((existing as any).data ?? {}), ...fields };
        const { data: rec, error } = await admin
          .from("crm_records")
          .update({ data: merged, updated_at: new Date().toISOString() })
          .eq("id", str(p.record_id)).select("id, data").single();
        if (error) return jsonResponse({ error: error.message }, { status: 400 });
        admin.from("activity_logs").insert({
          workspace_id, project_id, actor_user_id: userId,
          event_type: "crm.update", title: "Agent updated a CRM record", payload: { record_id: str(p.record_id) },
        }).then(() => {});
        return jsonResponse({ ok: true, record: rec });
      }

      case "delete_record": {
        const { error } = await admin
          .from("crm_records").delete()
          .eq("project_id", project_id).eq("id", str(p.record_id));
        if (error) return jsonResponse({ error: error.message }, { status: 400 });
        admin.from("activity_logs").insert({
          workspace_id, project_id, actor_user_id: userId,
          event_type: "crm.delete", title: "Agent deleted a CRM record", payload: { record_id: str(p.record_id) },
        }).then(() => {});
        return jsonResponse({ ok: true, deleted: str(p.record_id) });
      }

      // ── Relations ────────────────────────────────────────────────────────
      case "get_related": {
        // All records linked to record_id (optionally via one relation property).
        const recordId = str(p.record_id);
        if (!recordId) return jsonResponse({ error: "record_id required" }, { status: 400 });
        let q = admin.from("crm_record_links")
          .select("id, property_id, from_record_id, to_record_id")
          .eq("project_id", project_id)
          .or(`from_record_id.eq.${recordId},to_record_id.eq.${recordId}`);
        if (p.property) {
          const r = await relationPropForRecord(recordId, str(p.property));
          if ("error" in r) return jsonResponse({ error: r.error }, { status: 400 });
          q = q.eq("property_id", r.prop.id);
        }
        const { data: links } = await q.limit(200);
        const otherIds = [...new Set(((links ?? []) as any[]).map((l) =>
          l.from_record_id === recordId ? l.to_record_id : l.from_record_id))];
        if (otherIds.length === 0) return jsonResponse({ ok: true, count: 0, records: [] });
        const { data: recs } = await admin
          .from("crm_records").select("id, object_id, data")
          .eq("project_id", project_id).in("id", otherIds);
        // Title each related record with its own object's title property.
        const objIds = [...new Set(((recs ?? []) as any[]).map((r) => r.object_id))];
        const { data: objs } = await admin
          .from("crm_objects").select("id, slug, title_property").in("id", objIds);
        const objById = new Map(((objs ?? []) as any[]).map((o) => [o.id, o]));
        return jsonResponse({
          ok: true,
          count: (recs ?? []).length,
          records: ((recs ?? []) as any[]).map((r) => {
            const o = objById.get(r.object_id);
            return { id: r.id, object: o?.slug ?? null, title: str(r.data?.[o?.title_property ?? "name"]), data: r.data ?? {} };
          }),
        });
      }

      case "link_records": {
        const from = str(p.from_record_id), to = str(p.to_record_id), prop = str(p.property);
        if (!from || !to || !prop) {
          return jsonResponse({ error: "from_record_id, to_record_id and property required" }, { status: 400 });
        }
        const r = await relationPropForRecord(from, prop);
        if ("error" in r) return jsonResponse({ error: r.error }, { status: 400 });
        // Idempotent: the (property, from, to) triple is unique, so a repeat is a no-op.
        const { error } = await admin.from("crm_record_links").upsert({
          workspace_id, project_id, property_id: r.prop.id, from_record_id: from, to_record_id: to,
        }, { onConflict: "property_id,from_record_id,to_record_id" });
        if (error) return jsonResponse({ error: error.message }, { status: 400 });
        admin.from("activity_logs").insert({
          workspace_id, project_id, actor_user_id: userId,
          event_type: "crm.link", title: "Agent linked two CRM records", payload: { from, to, property: prop },
        }).then(() => {});
        return jsonResponse({ ok: true, linked: { from, to, property: prop } });
      }

      case "unlink_records": {
        const from = str(p.from_record_id), to = str(p.to_record_id), prop = str(p.property);
        if (!from || !to || !prop) {
          return jsonResponse({ error: "from_record_id, to_record_id and property required" }, { status: 400 });
        }
        const r = await relationPropForRecord(from, prop);
        if ("error" in r) return jsonResponse({ error: r.error }, { status: 400 });
        const { error } = await admin.from("crm_record_links").delete()
          .eq("project_id", project_id).eq("property_id", r.prop.id)
          .eq("from_record_id", from).eq("to_record_id", to);
        if (error) return jsonResponse({ error: error.message }, { status: 400 });
        return jsonResponse({ ok: true, unlinked: { from, to, property: prop } });
      }

      default:
        return jsonResponse({ error: `Unknown action "${action}"` }, { status: 400 });
    }
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
