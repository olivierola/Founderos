// enrich-app-structure — uses an LLM to turn the raw scan_results.app_structure
// (pages, routes, elements) into a semantic map the RAG agent can use to drive
// dynamic onboarding.
//
// Body: { workspace_id, project_id, scan_result_id?  }
//   If scan_result_id is omitted, we pick the latest scan for the project.
//
// Output is persisted at scan_results.app_structure.enriched and shaped as:
//   {
//     pages: [
//       {
//         name, route, description, intents: ["create project", "invite team"],
//         primary_actions: [{ label, selector_hint, target_route, intent }],
//         related_routes: ["/projects/:id", "/settings"],
//       }
//     ],
//     navigation: { entry_routes: [...], common_journeys: [...] },
//     summary,
//   }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi } from "../_shared/ai.ts";

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
    const { workspace_id, project_id, scan_result_id } = body as {
      workspace_id?: string;
      project_id?: string;
      scan_result_id?: string;
    };
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id, project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", u.user.id)
      .maybeSingle();
    if (!membership || !["owner", "admin", "member"].includes(membership.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    let scan: { id: string; app_structure: Record<string, unknown> | null };
    if (scan_result_id) {
      const { data } = await admin
        .from("scan_results")
        .select("id, app_structure")
        .eq("id", scan_result_id)
        .maybeSingle();
      if (!data) return jsonResponse({ error: "scan not found" }, { status: 404 });
      scan = data;
    } else {
      const { data } = await admin
        .from("scan_results")
        .select("id, app_structure")
        .eq("project_id", project_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!data) return jsonResponse({ error: "no scan available" }, { status: 404 });
      scan = data;
    }

    const raw = scan.app_structure ?? {};
    const pages = (raw as { pages?: unknown[] }).pages ?? [];
    const routes = (raw as { routes?: string[] }).routes ?? [];
    if (pages.length === 0) {
      return jsonResponse({ error: "app_structure has no pages — run a code scan first" }, { status: 400 });
    }

    const prompt = `You are analysing the UI structure of a SaaS application to power an
in-product onboarding agent. From the page list below, produce a semantic map
the agent can use to guide end users.

Output ONLY valid minified JSON (no prose, no markdown fences) with this shape:
{
  "pages": [
    {
      "name": string,                           // human-friendly page name
      "route": string,                          // best guess for the URL route
      "description": string,                    // 1-2 sentences explaining the page purpose
      "intents": string[],                       // user intents satisfied here ("invite a teammate")
      "primary_actions": [
        {
          "label": string,                       // exactly as it appears in the UI when possible
          "selector_hint": string,               // a CSS-like hint to find the element (id, class, text)
          "target_route": string | null,         // route after clicking, if known
          "intent": string                       // what completing this action means for the user
        }
      ],
      "related_routes": string[]                 // routes commonly reached from here
    }
  ],
  "navigation": {
    "entry_routes": string[],                    // pages users typically land on first
    "common_journeys": [
      { "name": string, "route_sequence": string[], "description": string }
    ]
  },
  "summary": string                              // 2 sentence overview of the app
}

Strip duplicates. Use at most 15 pages and 6 actions per page. Be concise.

Raw scan data:
${JSON.stringify({ pages, routes }).slice(0, 12000)}`;

    const ai = await callAi({
      task: "json_extraction",
      systemPrompt: "You are a precise UX analyst. Reply only with valid JSON.",
      userPrompt: prompt,
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 3000,
    });

    let enriched: Record<string, unknown>;
    try {
      enriched = JSON.parse(ai.content);
    } catch {
      return jsonResponse({ error: "LLM returned invalid JSON", detail: ai.content.slice(0, 400) }, { status: 502 });
    }

    const nextStructure = { ...(raw as Record<string, unknown>), enriched, enriched_at: new Date().toISOString() };
    const { error } = await admin
      .from("scan_results")
      .update({ app_structure: nextStructure })
      .eq("id", scan.id);
    if (error) return jsonResponse({ error: "could not persist", detail: error.message }, { status: 500 });

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: u.user.id,
      event_type: "scan.app_structure_enriched",
      title: "App structure enriched for onboarding",
      payload: { scan_result_id: scan.id, pages_in: pages.length },
    });

    return jsonResponse({ ok: true, scan_result_id: scan.id, enriched });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
