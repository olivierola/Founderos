// armada-generate-tests — scan a connected GitHub repo and generate a full E2E
// test suite (multiple multi-scenario test cases) for the app.
//
// Body: { workspace_id, project_id, full_name, app_url, branch? }
//   full_name : "owner/repo" (must be a connected GitHub repo)
//   app_url   : the deployed app the tests will run against
//
// Returns: { suite_id, cases: number }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getConnectorCredential } from "../_shared/credentials.ts";
import { listRepoTree, fetchFileContent, getDefaultBranch } from "../_shared/github.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";

// Files most useful to infer testable flows: routing, pages, forms, auth.
function rankFiles(paths: string[]): string[] {
  const score = (p: string): number => {
    const l = p.toLowerCase();
    if (/node_modules|dist|build|\.test\.|\.spec\.|\.d\.ts$|\.lock$|\.map$/.test(l)) return -1;
    let s = 0;
    if (/(^|\/)(app|pages|routes|router)(\/|\.)/.test(l)) s += 5;
    if (/route|router|navigation|sitemap/.test(l)) s += 4;
    if (/(sign|login|auth|register|signup|checkout|onboard|settings|account|billing)/.test(l)) s += 4;
    if (/form|input|field|schema|zod|yup/.test(l)) s += 3;
    if (/page\.(t|j)sx?$|layout\.(t|j)sx?$|\+page\.svelte$/.test(l)) s += 3;
    if (/\.(tsx|jsx|vue|svelte|astro)$/.test(l)) s += 2;
    if (/readme|openapi|swagger/.test(l)) s += 2;
    if (l.split("/").length <= 3) s += 1; // shallow = likely important
    return s;
  };
  return paths
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p);
}

const SYSTEM = `You are a senior QA engineer. From a web app's source files you design a COMPLETE end-to-end test suite that an autonomous browser agent will run against the deployed app.

Output STRICT JSON only:
{
  "suite_name": "short suite name",
  "summary": "what the suite covers, 1-2 sentences",
  "cases": [
    {
      "name": "Test case name (a user journey, e.g. 'Sign up & onboarding')",
      "instructions": "Detailed natural-language steps. You MAY include SEVERAL scenarios in one case, numbered, that the agent runs in sequence (e.g. 1) sign up with a new email 2) verify the dashboard 3) log out). Be specific about pages, fields, buttons and what to verify.",
      "expected_outcome": "clear, observable success criteria",
      "fixtures": { "email": "test+e2e@example.com", "password": "Test1234!" }
    }
  ]
}

Guidelines:
- Cover the real user journeys you can infer: auth (signup/login/logout), core feature flows, forms & validation, navigation, settings/billing if present.
- Prefer 4-8 high-value cases. Each case can bundle multiple related scenarios.
- Use realistic placeholder fixtures; never invent real secrets.
- Ground everything in the actual routes/pages/forms you see — don't test things that don't exist.`;

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
    const { workspace_id, project_id, full_name, app_url } = body as {
      workspace_id?: string; project_id?: string; full_name?: string; app_url?: string;
    };
    if (!workspace_id || !project_id || !full_name || !app_url) {
      return jsonResponse({ error: "workspace_id, project_id, full_name, app_url required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members").select("role")
      .eq("workspace_id", workspace_id).eq("user_id", userId).maybeSingle();
    if (!membership || !["owner", "admin", "member"].includes(membership.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    // GitHub token from the connected connector.
    let token: string;
    try {
      const { payload } = await getConnectorCredential(workspace_id, project_id, "github");
      token = payload.token ?? payload.secret_key ?? payload.pat ?? "";
    } catch {
      return jsonResponse({ error: "GitHub is not connected for this project" }, { status: 400 });
    }
    if (!token) return jsonResponse({ error: "GitHub token missing" }, { status: 400 });

    const branch = body.branch || (await getDefaultBranch(token, full_name).catch(() => "main"));

    // Scan the tree, rank the useful files, read a budgeted set.
    let tree: string[];
    try {
      tree = await listRepoTree(token, full_name, branch);
    } catch (e) {
      return jsonResponse({ error: `Could not read repo tree: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
    }
    const ranked = rankFiles(tree).slice(0, 24);
    const files: Array<{ path: string; content: string }> = [];
    let budget = 60_000; // chars of source fed to the model
    for (const path of ranked) {
      if (budget <= 0) break;
      const content = await fetchFileContent(token, full_name, branch, path).catch(() => null);
      if (!content) continue;
      const slice = content.slice(0, 6000);
      files.push({ path, content: slice });
      budget -= slice.length;
    }
    if (files.length === 0) {
      return jsonResponse({ error: "No readable source files found to analyse" }, { status: 400 });
    }

    const userPrompt = `App URL (tests run here): ${app_url}
Repository: ${full_name} @ ${branch}

Source files (path then content, truncated):
${files.map((f) => `\n=== ${f.path} ===\n${f.content}`).join("\n").slice(0, 90_000)}

Design the E2E test suite as strict JSON.`;

    let res;
    try {
      res = await callAi({ task: "code_analysis", systemPrompt: SYSTEM, userPrompt, jsonMode: true, maxTokens: 3500, provider: "deepseek", model: "deepseek-v4-pro" });
    } catch (_e) {
      res = await callAi({ task: "code_analysis", systemPrompt: SYSTEM, userPrompt, jsonMode: true, maxTokens: 3500 });
    }
    logLlmUsage({ workspace_id, project_id, provider: res.provider, model: res.model, task: "code_analysis", feature: "armada_generate", usage: res.usage });

    const parsed = safeParseJson<{
      suite_name?: string; summary?: string;
      cases?: Array<{ name: string; instructions: string; expected_outcome?: string; fixtures?: Record<string, unknown> }>;
    }>(res.content);
    const cases = Array.isArray(parsed?.cases) ? parsed!.cases!.filter((c) => c?.name && c?.instructions) : [];
    if (cases.length === 0) {
      return jsonResponse({ error: "The agent could not derive any tests from this repo" }, { status: 422 });
    }

    // Create the suite + cases.
    const { data: suite, error: suiteErr } = await admin
      .from("test_suites")
      .insert({
        workspace_id, project_id, created_by: userId,
        name: parsed?.suite_name || `${full_name.split("/").pop()} — E2E suite`,
        description: parsed?.summary || `Auto-generated from ${full_name}`,
        app_url,
        config: { generated_from: full_name, branch },
      })
      .select("id").single();
    if (suiteErr || !suite) return jsonResponse({ error: suiteErr?.message ?? "Could not create suite" }, { status: 500 });

    const rows = cases.slice(0, 12).map((c) => ({
      workspace_id, project_id, suite_id: suite.id, created_by: userId,
      name: String(c.name).slice(0, 160),
      instructions: String(c.instructions),
      expected_outcome: c.expected_outcome ? String(c.expected_outcome) : null,
      fixtures: c.fixtures && typeof c.fixtures === "object" ? c.fixtures : {},
    }));
    const { error: caseErr } = await admin.from("test_cases").insert(rows);
    if (caseErr) return jsonResponse({ error: caseErr.message, suite_id: suite.id }, { status: 500 });

    return jsonResponse({ ok: true, suite_id: suite.id, cases: rows.length });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
