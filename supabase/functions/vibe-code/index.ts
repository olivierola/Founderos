// vibe-code — an agent that codes on a connected GitHub repo. It reads files,
// proposes complete new file contents for a task, and (on approval) opens a PR.
// Uses the project's stored PAT + the shared tool-calling loop.
// Actions:
//   "run":   { workspace_id, project_id, repository_id, prompt, branch? }
//            → { message, base_branch, changes: [{path,content}], reads, tool_calls }
//   "apply": { workspace_id, project_id, repository_id, base_branch, title, body, changes }
//            → { pull_request: { html_url, number }, branch }
import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { decryptSecret } from "../_shared/crypto.ts";
import {
  getDefaultBranch, getBranchSha, listRepoTree, fetchFileContent, applyChanges,
  commitFiles, listCheckRuns, listCheckAnnotations, getCombinedStatus,
  createBranch, createPullRequest, getRepoInfo, getAuthenticatedLogin, forkRepo, waitForRepoBranch,
  getPullRequest, mergePullRequest,
} from "../_shared/github.ts";
import { runToolRounds, type ToolDef } from "../_shared/ai.ts";
import { classifyTier, modelForTier } from "../_shared/model-router.ts";
import { mcpCallTool } from "../_shared/mcp-client.ts";
import { ensureAccessToken } from "../_shared/mcp-oauth.ts";

type Admin = ReturnType<typeof createServiceClient>;
interface VibeMcpServer { id: string; name: string; url: string; headers: Record<string, string>; tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] }

// MCP servers attached to this project's coding agent (Personnaliser → MCP).
// Their cached tools are exposed to the run loop as `mcp__<server>__<tool>`.
async function loadVibeMcpServers(admin: Admin, projectId: string): Promise<VibeMcpServer[]> {
  const { data } = await admin
    .from("vibe_mcp_servers")
    .select("server:mcp_servers(id, name, url, headers, enabled, cached_tools, auth_mode, oauth)")
    .eq("project_id", projectId);
  const rows = ((data ?? []) as Record<string, unknown>[])
    .map((r) => r.server as Record<string, unknown> | null)
    .filter((s): s is Record<string, unknown> => !!s && !!s.enabled);
  const out: VibeMcpServer[] = [];
  for (const s of rows) {
    let headers: Record<string, string> = s.headers && typeof s.headers === "object" ? { ...(s.headers as Record<string, string>) } : {};
    if (s.auth_mode === "oauth") {
      const token = await ensureAccessToken(admin, { id: String(s.id), oauth: (s.oauth as Record<string, unknown>) || {} });
      if (token) headers = { ...headers, Authorization: `Bearer ${token}` };
    }
    out.push({
      id: String(s.id), name: String(s.name), url: String(s.url), headers,
      tools: Array.isArray(s.cached_tools) ? (s.cached_tools as VibeMcpServer["tools"]) : [],
    });
  }
  return out;
}

const mcpSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "srv";

/** Build ToolDefs for every attached MCP tool + a resolver to route calls. */
function buildMcpTools(servers: VibeMcpServer[]): { defs: ToolDef[]; resolve: (name: string) => { server: VibeMcpServer; tool: string } | null } {
  const map = new Map<string, { server: VibeMcpServer; tool: string }>();
  const defs: ToolDef[] = [];
  for (const s of servers) {
    for (const t of s.tools) {
      const fn = `mcp__${mcpSlug(s.name)}__${mcpSlug(t.name)}`;
      if (map.has(fn)) continue;
      map.set(fn, { server: s, tool: t.name });
      defs.push({
        type: "function",
        function: {
          name: fn,
          description: `[${s.name}] ${t.description ?? t.name}`,
          parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        },
      });
    }
  }
  return { defs, resolve: (n) => map.get(n) ?? null };
}

// Aggregate a PR head's CI into a state + human-readable failures the agent can fix.
interface CiFailure { check: string; path?: string; line?: number; level?: string; message: string }
async function collectCi(token: string, fullName: string, ref: string): Promise<{
  state: "pending" | "success" | "failure" | "none";
  checks: { name: string; status: string; conclusion: string | null; url: string | null }[];
  failures: CiFailure[];
}> {
  const runs = await listCheckRuns(token, fullName, ref);
  const combined = await getCombinedStatus(token, fullName, ref);
  const FAIL = new Set(["failure", "timed_out", "cancelled", "action_required"]);
  const failing = runs.filter((r) => r.status === "completed" && FAIL.has(r.conclusion ?? ""));
  const failedStatuses = (combined.statuses ?? []).filter((s) => s.state === "failure" || s.state === "error");
  const anyPending = runs.some((r) => r.status !== "completed") || combined.state === "pending";

  const failures: CiFailure[] = [];
  for (const f of failing) {
    const anns = await listCheckAnnotations(token, fullName, f.id);
    if (anns.length) {
      for (const a of anns.slice(0, 20)) failures.push({ check: f.name, path: a.path, line: a.start_line, level: a.annotation_level, message: a.message });
    } else {
      failures.push({ check: f.name, message: f.output?.summary || f.output?.title || "échec (voir les logs GitHub)" });
    }
  }
  for (const s of failedStatuses) failures.push({ check: s.context, message: s.description || "échec" });

  let state: "pending" | "success" | "failure" | "none";
  if (failing.length || failedStatuses.length) state = "failure";
  else if (anyPending) state = "pending";
  else if (runs.length || (combined.statuses ?? []).length) state = "success";
  else state = "none";

  return {
    state,
    checks: runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url })),
    failures,
  };
}

function ciFailuresText(failures: CiFailure[]): string {
  return failures.slice(0, 40).map((f) => {
    const loc = f.path ? ` (${f.path}${f.line ? `:${f.line}` : ""})` : "";
    return `- [${f.check}]${loc} ${f.message}`.slice(0, 500);
  }).join("\n");
}

const TOOLS: ToolDef[] = [
  { type: "function", function: { name: "read_file", description: "Read a file's full content from the repository before editing it.", parameters: { type: "object", properties: { path: { type: "string", description: "Repo-relative path, e.g. src/App.tsx" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Stage the COMPLETE new content of a file to create or modify. Always provide the entire file, not a diff.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string", description: "The full new file content." } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "remember", description: "Save a durable fact, preference or decision so future turns respect it. scope 'global' = across all sessions of the project; 'session' = only this conversation.", parameters: { type: "object", properties: { content: { type: "string" }, scope: { type: "string", enum: ["global", "session"] } }, required: ["content"] } } },
  { type: "function", function: {
    name: "update_todos",
    description: "Maintain your live todo checklist — the user watches it. Send the COMPLETE list every time. Split a complex step into subtasks via parent_id (up to 3 levels); a parent is done only when ALL its subtasks are done. Exactly ONE leaf 'active' at a time; mark items 'done' only once verified (write staged, file read, check passed).",
    parameters: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: {
      id: { type: "string" }, title: { type: "string" },
      status: { type: "string", enum: ["pending", "active", "done", "blocked"] },
      parent_id: { type: "string", description: "Parent task id when this is a subtask." },
      note: { type: "string" },
    }, required: ["id", "title", "status"] } } }, required: ["todos"] },
  } },
  { type: "function", function: {
    name: "search_past_sessions",
    description: "Search what was ALREADY done on this project in previous Vibe Code sessions (past results and the files they changed) by keyword. Use it before redoing work that may already exist, or to stay consistent with past decisions.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Keywords (matched against past results and prompts)." } }, required: ["query"] },
  } },
];

interface VibeTodo { id: string; title: string; status: string; parent_id?: string; note?: string }
function normalizeTodos(raw: unknown): VibeTodo[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const todos: VibeTodo[] = raw.slice(0, 40).map((t: Record<string, unknown>, i: number) => ({
    id: String(t?.id ?? "") || `step-${i + 1}`,
    title: String(t?.title ?? "").slice(0, 140) || `Step ${i + 1}`,
    status: ["pending", "active", "done", "blocked"].includes(String(t?.status)) ? String(t?.status) : "pending",
    ...(t?.parent_id ? { parent_id: String(t.parent_id) } : {}),
    ...(t?.note ? { note: String(t.note).slice(0, 300) } : {}),
  }));
  const ids = new Set(todos.map((t) => t.id));
  for (const t of todos) if (t.parent_id && (!ids.has(t.parent_id) || t.parent_id === t.id)) delete t.parent_id;
  return todos;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });

    const bodyRaw = await req.json().catch(() => ({}));
    // Internal caller: the Vibe Code studio agent runs inside internal-agent-run,
    // which invokes edge functions with the SERVICE ROLE key — that bearer has
    // no `sub`, so auth.getUser() would reject it. Such a call is trusted, but
    // it must still name the user it acts for (repo ownership, session
    // authorship) and it never bypasses the workspace membership check below.
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const isInternal = !!serviceKey && authHeader === `Bearer ${serviceKey}`;
    let userId: string;
    if (isInternal) {
      const actingUser = (bodyRaw as { acting_user_id?: string }).acting_user_id;
      if (!actingUser) return jsonResponse({ error: "acting_user_id required for internal calls" }, { status: 400 });
      userId = actingUser;
    } else {
      const { data: userData, error: userErr } = await createUserClient(authHeader).auth.getUser();
      if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      userId = userData.user.id;
    }

    const body = bodyRaw;
    const { workspace_id, project_id, repository_id, action } = body as {
      workspace_id?: string; project_id?: string; repository_id?: string;
      action?: "run" | "apply" | "pr_status" | "fix_pr" | "merge_pr";
    };
    if (!workspace_id || !project_id || !repository_id || !action) {
      return jsonResponse({ error: "workspace_id, project_id, repository_id, action required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin.from("workspace_members").select("role").eq("workspace_id", workspace_id).eq("user_id", userId).maybeSingle();
    if (!membership) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    const { data: repo } = await admin.from("repositories").select("full_name, default_branch").eq("id", repository_id).eq("project_id", project_id).maybeSingle();
    if (!repo?.full_name) return jsonResponse({ error: "Dépôt introuvable" }, { status: 404 });
    const fullName = repo.full_name as string;

    const { data: connector } = await admin.from("connectors").select("id").eq("project_id", project_id).eq("provider", "github").maybeSingle();
    if (!connector) return jsonResponse({ error: "GitHub non connecté" }, { status: 400 });
    const { data: cred } = await admin.from("encrypted_credentials").select("encrypted_payload, iv").eq("connector_id", connector.id).maybeSingle();
    if (!cred) return jsonResponse({ error: "Identifiant GitHub manquant" }, { status: 400 });
    const token = await decryptSecret(cred.encrypted_payload, cred.iv);

    // Per-project customization (extra instructions + default merge method).
    const { data: settingsRow } = await admin.from("vibe_settings")
      .select("instructions, merge_method").eq("project_id", project_id).maybeSingle();
    const customInstructions = ((settingsRow as { instructions?: string } | null)?.instructions ?? "").trim();
    const defaultMergeMethod = ((settingsRow as { merge_method?: string } | null)?.merge_method ?? "squash") as "merge" | "squash" | "rebase";

    // ── APPLY: open a PR with the approved changes ─────────────────────────────
    if (action === "apply") {
      const { base_branch, title, body: prBody, changes, message_id } = body as {
        base_branch?: string; title?: string; body?: string; changes?: { path: string; content: string }[]; message_id?: string;
      };
      if (!changes?.length) return jsonResponse({ error: "Aucun changement à appliquer" }, { status: 400 });
      const commitMsg = title || "Vibe Code: changes";
      const prTitle = title || "Vibe Code changes";
      const prBodyFull = (prBody || "Changements proposés par l'agent Vibe Code.") + "\n\n— Anduran · Vibe Code";
      let result: { mode: string; branch: string; head_repo: string; commit_sha: string; pull_request?: { html_url: string; number: number } };
      const login = await getAuthenticatedLogin(token).catch(() => null);
      const [ownerLogin, repoShort] = fullName.split("/");
      const ownedPersonally = !!login && login.toLowerCase() === ownerLogin.toLowerCase();
      const isWriteDenied = (m: string) => /\b40[34]\b|Resource not accessible|Not Found/i.test(m);

      // Fork flow: fork the repo under the token owner, commit there, PR upstream.
      const contributeViaFork = async (baseBranch: string) => {
        if (!login) throw new Error("Impossible de déterminer le compte GitHub du token.");
        const forkFullName = `${login}/${repoShort}`;
        let forkBaseSha: string;
        try {
          forkBaseSha = await getBranchSha(token, forkFullName, baseBranch);
        } catch {
          await forkRepo(token, fullName);
          forkBaseSha = await waitForRepoBranch(token, forkFullName, baseBranch, 15);
        }
        const head = `founderos/agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        await createBranch(token, forkFullName, head, forkBaseSha);
        const commitSha = await commitFiles(token, forkFullName, head, forkBaseSha, changes, commitMsg);
        const pr = await createPullRequest(token, fullName, `${login}:${head}`, baseBranch, prTitle, prBodyFull);
        return { mode: "pull_request_fork", branch: head, head_repo: forkFullName, commit_sha: commitSha, pull_request: pr };
      };

      try {
        const info = await getRepoInfo(token, fullName).catch(() => null);
        const baseBranch = base_branch || info?.default_branch || (repo.default_branch as string);
        // If we clearly can't push AND it isn't our own repo → fork straight away.
        if (login && !ownedPersonally && info?.permissions?.push === false) {
          result = await contributeViaFork(baseBranch);
        } else {
          // Try a direct branch+commit+PR; permissions.push can lie (it reflects the
          // repo ROLE, not the token's granted scopes), so we fall back on failure.
          try {
            const r = await applyChanges(token, fullName, { changes, commitMessage: commitMsg, mode: "pull_request", baseBranch, prTitle, prBody: prBodyFull });
            result = { ...r, head_repo: fullName };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (isWriteDenied(msg) && login && !ownedPersonally) {
              // Read/fork-only on someone else's (or an org) repo → contribute via a fork.
              result = await contributeViaFork(baseBranch);
            } else if (isWriteDenied(msg)) {
              // Our own repo but the token can't write → probe the repo to say why.
              const probe = await getRepoInfo(token, fullName).catch(() => null);
              const diag = probe
                ? `login=@${login} · repo=${probe.full_name} owner=${probe.owner?.login}(${probe.owner?.type}) private=${probe.private} archived=${probe.archived} fork=${probe.fork} push=${probe.permissions?.push} default=${probe.default_branch}`
                : `login=@${login} · repo introuvable avec ce token (peut-être renommé/supprimé, ou nom stocké incorrect: ${fullName})`;
              const isOrg = probe?.owner?.type === "Organization";
              const archived = probe?.archived;
              const errorMsg = archived
                ? "Ce dépôt est archivé (lecture seule sur GitHub) — impossible d'y créer une PR."
                : isOrg
                  ? "Le dépôt appartient à une organisation. Autorisez votre token classique pour cette organisation : page du token GitHub → bouton « Configure SSO » → Authorize."
                  : "Le token ne peut pas écrire sur ce dépôt alors qu'il a le scope « repo ». Vérifiez le nom du dépôt (ci-dessous) et qu'il vous appartient bien.";
              return jsonResponse({ error: errorMsg, detail: diag }, { status: 403 });
            } else if (/No commits between/i.test(msg)) {
              return jsonResponse({ error: "Aucune différence à proposer : les modifications de l'agent sont identiques au code existant.", detail: msg }, { status: 409 });
            } else throw e;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/No commits between/i.test(msg)) {
          return jsonResponse({ error: "Aucune différence à proposer : les modifications de l'agent sont identiques au code existant.", detail: msg }, { status: 409 });
        }
        return jsonResponse({ error: "Échec de la création de la PR. " + msg, detail: msg }, { status: 500 });
      }
      // Persist the PR (with its head branch) onto the assistant message so the
      // CI panel + fix loop survive a page reload. Non-fatal: never fail the PR.
      if (message_id && result.pull_request) {
        try {
          const { data: row } = await admin.from("vibe_messages").select("meta").eq("id", message_id).maybeSingle();
          const meta = ((row as { meta?: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>;
          await admin.from("vibe_messages").update({
            meta: { ...meta, pr: { html_url: result.pull_request.html_url, number: result.pull_request.number, branch: result.branch, head_repo: result.head_repo } },
          }).eq("id", message_id);
        } catch (_) { /* persistence is best-effort */ }
      }
      return jsonResponse(result);
    }

    // ── PR_STATUS: read the CI state of a PR head so the UI can show errors ─────
    if (action === "pr_status") {
      const { branch, head_sha, head_repo, pr_number } = body as { branch?: string; head_sha?: string; head_repo?: string; pr_number?: number };
      // The PR head branch lives on head_repo (the fork for fork-based PRs); the
      // PR object itself lives on the base repo (the connected repo).
      const repoForRef = head_repo || fullName;
      const ref = head_sha || (branch ? await getBranchSha(token, repoForRef, branch).catch(() => null) : null);
      const ci = ref ? await collectCi(token, repoForRef, ref) : { state: "none" as const, checks: [], failures: [] };
      const pr = pr_number ? await getPullRequest(token, fullName, pr_number).catch(() => null) : null;
      return jsonResponse({ ...ci, head_sha: ref, pr });
    }

    // ── MERGE_PR: merge the PR from the chat ───────────────────────────────────
    if (action === "merge_pr") {
      const { pr_number, method } = body as { pr_number?: number; method?: "merge" | "squash" | "rebase" };
      if (!pr_number) return jsonResponse({ error: "pr_number required" }, { status: 400 });
      try {
        const res = await mergePullRequest(token, fullName, pr_number, method || defaultMergeMethod);
        return jsonResponse({ ok: true, ...res });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/\b405\b|not mergeable|Method Not Allowed/i.test(msg)) {
          return jsonResponse({ error: "PR non fusionnable pour l'instant (conflits, CI en échec, ou revue requise).", detail: msg }, { status: 409 });
        }
        if (/\b403\b|\b404\b|not accessible/i.test(msg)) {
          return jsonResponse({ error: "Vous n'avez pas le droit de fusionner cette PR (dépôt upstream non possédé).", detail: msg }, { status: 403 });
        }
        return jsonResponse({ error: "Échec de la fusion. " + msg, detail: msg }, { status: 500 });
      }
    }

    // ── RUN / FIX_PR: async agent. The read/LLM/write loop is long, so we return fast and
    // do the work in the BACKGROUND, persisting the result to vibe_messages (the
    // frontend polls that row). This avoids the gateway 504 on slow tasks.
    const isFix = action === "fix_pr";
    const { branch: reqBranch, session_id } = body as { branch?: string; session_id?: string };
    const prNumber = (body as { pr_number?: number }).pr_number;
    const headRepo = (body as { head_repo?: string }).head_repo;
    let { prompt } = body as { prompt?: string };
    // For a fix, the PR head branch lives on the fork (head_repo) → read/commit there.
    const targetRepo = isFix && headRepo ? headRepo : fullName;

    // FIX_PR: seed the task from the PR's live CI failures; the fix is committed
    // to the PR branch (updates the same PR) instead of being staged.
    if (isFix) {
      if (!reqBranch) return jsonResponse({ error: "branch (PR head) requis" }, { status: 400 });
      const headSha0 = await getBranchSha(token, targetRepo, reqBranch);
      const ci = await collectCi(token, targetRepo, headSha0);
      if (ci.state !== "failure" || ci.failures.length === 0) {
        return jsonResponse({ error: "no_failures", state: ci.state }, { status: 400 });
      }
      prompt = `La CI de la PR #${prNumber ?? "?"} a échoué. Corrige les erreurs ci-dessous en modifiant les fichiers nécessaires du dépôt (branche « ${reqBranch} »).\n\nErreurs CI :\n${ciFailuresText(ci.failures)}`;
    }
    if (!prompt) return jsonResponse({ error: "prompt requis" }, { status: 400 });

    // ── Memory: global (project) + session facts, and prior session turns ──────
    const [gm, sm, prior] = await Promise.all([
      admin.from("vibe_memory").select("content").eq("project_id", project_id).is("session_id", null).order("created_at", { ascending: true }).limit(60),
      session_id ? admin.from("vibe_memory").select("content").eq("session_id", session_id).order("created_at", { ascending: true }).limit(60) : Promise.resolve({ data: [] as { content: string }[] }),
      session_id ? admin.from("vibe_messages").select("role, content, meta").eq("session_id", session_id).order("created_at", { ascending: true }).limit(40) : Promise.resolve({ data: [] as unknown[] }),
    ]);
    const globalMem = ((gm.data ?? []) as { content: string }[]).map((r) => r.content);
    const sessionMem = ((sm.data ?? []) as { content: string }[]).map((r) => r.content);
    const priorTurns = ((prior.data ?? []) as { role: string; content: string; meta: { result?: { message?: string } } }[])
      .map((r) => ({ role: (r.role === "user" ? "user" : "assistant") as "user" | "assistant", content: r.role === "assistant" ? (r.meta?.result?.message || r.content || "") : r.content }))
      .filter((m) => m.content.trim()).slice(-8);

    // Resolve/create the session SERVER-SIDE (service role → robust persistence,
    // no client RLS/timing issues) then persist the user turn + assistant slot.
    let sid: string | null = session_id ?? null;
    if (!sid) {
      // Sessions started inside a Vibe project inherit it (and thus its repo).
      const vibeProjectId = (body as { vibe_project_id?: string }).vibe_project_id ?? null;
      const { data: s } = await admin.from("vibe_sessions").insert({
        workspace_id, project_id, repository_id, branch: reqBranch ?? null, title: prompt.slice(0, 60),
        created_by: userId, vibe_project_id: vibeProjectId,
      }).select("id").single();
      sid = (s as { id: string } | null)?.id ?? null;
    }
    let assistantId: string | null = null;
    if (sid) {
      await admin.from("vibe_messages").insert({ session_id: sid, workspace_id, role: "user", content: prompt, meta: { repo: fullName, branch: reqBranch ?? null } });
      const { data: a } = await admin.from("vibe_messages").insert({ session_id: sid, workspace_id, role: "assistant", content: "", meta: { status: "running", steps: [] } }).select("id").single();
      assistantId = (a as { id: string } | null)?.id ?? null;
      await admin.from("vibe_sessions").update({ updated_at: new Date().toISOString() }).eq("id", sid);
    }

    const work = async () => {
      const branch = reqBranch || (repo.default_branch as string) || await getDefaultBranch(token, targetRepo);
      const sha = await getBranchSha(token, targetRepo, branch);
      const allPaths = await listRepoTree(token, targetRepo, sha);
      // Sent on EVERY round → cap it hard to control input cost. The agent lists
      // more precisely with read_file / MCP when it needs a specific path.
      const treeForPrompt = allPaths.slice(0, 500).join("\n")
        + (allPaths.length > 500 ? `\n… (+${allPaths.length - 500} fichiers — utilise read_file pour cibler)` : "");

      // MCP tools attached to this project's coding agent (Personnaliser → MCP).
      const mcpServers = await loadVibeMcpServers(admin, project_id);
      const { defs: mcpDefs, resolve: resolveMcp } = buildMcpTools(mcpServers);
      const mcpSessions: Record<string, { id?: string }> = {};

      const changes: Record<string, string> = {};
      const reads: string[] = [];
      const steps: { t: string; label: string }[] = [];
      let todos: VibeTodo[] = [];
      // Persisting a step on each tool call is what powers the LIVE view — the
      // frontend polls the message row and renders steps (and the todo
      // checklist) as they land.
      const syncMeta = async () => {
        if (assistantId) await admin.from("vibe_messages").update({ meta: { status: "running", steps, todos } }).eq("id", assistantId);
      };
      const pushStep = async (t: string, label: string) => {
        steps.push({ t, label });
        await syncMeta();
      };
      const executor = async (name: string, args: Record<string, unknown>): Promise<string> => {
        if (name === "read_file") {
          const p = String(args.path ?? "").replace(/^\.?\//, "");
          if (!p) return "ERROR: path requis";
          await pushStep("read", p);
          const content = await fetchFileContent(token, targetRepo, branch, p);
          if (content == null) return `ERROR: fichier introuvable: ${p}`;
          if (!reads.includes(p)) reads.push(p);
          return content.length > 16000 ? content.slice(0, 16000) + "\n… (tronqué)" : content;
        }
        if (name === "write_file") {
          const p = String(args.path ?? "").replace(/^\.?\//, "");
          const content = String(args.content ?? "");
          if (!p) return "ERROR: path requis";
          changes[p] = content;
          await pushStep("write", `${p} (${content.split("\n").length} l.)`);
          return `ok — ${p} mis en attente`;
        }
        if (name === "remember") {
          const c = String(args.content ?? "").trim();
          const scope = String(args.scope ?? "global") === "session" ? "session" : "global";
          if (c) {
            await admin.from("vibe_memory").insert({ workspace_id, project_id, session_id: scope === "session" ? sid : null, content: c });
            await pushStep("memory", `${scope === "session" ? "session" : "globale"} · ${c.slice(0, 80)}`);
          }
          return "ok — mémorisé";
        }
        if (name === "update_todos") {
          const next = normalizeTodos(args.todos);
          if (!next) return "ERROR: todos (non-empty array) is required.";
          todos = next;
          await syncMeta();
          const parentIds = new Set(todos.filter((t) => t.parent_id).map((t) => t.parent_id));
          const leaves = todos.filter((t) => !parentIds.has(t.id));
          const done = leaves.filter((t) => t.status === "done").length;
          const active = leaves.filter((t) => t.status === "active").length;
          return `Todos updated (${done}/${leaves.length} leaf steps done).${active > 1 ? " WARNING: keep exactly ONE leaf active." : ""}`;
        }
        if (name === "search_past_sessions") {
          const query = String(args.query ?? "").trim().slice(0, 120);
          if (!query) return "ERROR: query is required.";
          await pushStep("memory", `sessions passées · ${query}`);
          const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
          const { data: hits } = await admin
            .from("vibe_messages")
            .select("content, created_at, meta, session:vibe_sessions!inner(project_id, title)")
            .eq("session.project_id", project_id)
            .eq("role", "assistant")
            .ilike("content", like)
            .order("created_at", { ascending: false })
            .limit(5);
          const rows = (hits ?? []) as Array<{ content: string; created_at: string; meta?: { result?: { changes?: { path: string }[] } }; session?: { title?: string } }>;
          if (!rows.length) return `Aucune session passée ne mentionne "${query}" — ce travail n'a probablement pas encore été fait sur ce dépôt.`;
          return rows.map((h) => {
            const files = (h.meta?.result?.changes ?? []).map((c) => c.path).slice(0, 8).join(", ");
            return `[${String(h.created_at).slice(0, 10)} · ${h.session?.title ?? "session"}] ${h.content.replace(/\s+/g, " ").slice(0, 400)}${files ? `\n  fichiers modifiés: ${files}` : ""}`;
          }).join("\n\n").slice(0, 6000);
        }
        // Attached MCP tools → proxy the call to the remote server.
        const hit = resolveMcp(name);
        if (hit) {
          await pushStep("mcp", `${hit.server.name} · ${hit.tool}`);
          mcpSessions[hit.server.id] ??= {};
          try {
            return await mcpCallTool(hit.server.url, hit.server.headers, hit.tool, args, mcpSessions[hit.server.id]);
          } catch (e) {
            return `ERROR: MCP ${hit.server.name}/${hit.tool} — ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        return `ERROR: outil inconnu ${name}`;
      };
      const memBlock = (globalMem.length || sessionMem.length)
        ? ["MÉMOIRE (respecte ces éléments) :", ...globalMem.map((m) => `- [global] ${m}`), ...sessionMem.map((m) => `- [session] ${m}`), ""].join("\n")
        : "";
      // Travail récent sur ce projet (autres sessions) — pour construire dessus
      // au lieu de le refaire. Complété à la demande par search_past_sessions.
      let recentWorkBlock = "";
      try {
        const { data: recent } = await admin
          .from("vibe_messages")
          .select("content, created_at, session:vibe_sessions!inner(id, project_id, title)")
          .eq("session.project_id", project_id)
          .eq("role", "assistant")
          .neq("session.id", sid ?? "00000000-0000-0000-0000-000000000000")
          .neq("content", "")
          .order("created_at", { ascending: false })
          .limit(3);
        const rows = (recent ?? []) as Array<{ content: string; created_at: string; session?: { title?: string } }>;
        if (rows.length) {
          recentWorkBlock = ["TRAVAIL RÉCENT sur ce projet (autres sessions — construis dessus, ne refais pas) :",
            ...rows.map((r) => `- [${String(r.created_at).slice(0, 10)} · ${r.session?.title ?? "session"}] ${r.content.replace(/\s+/g, " ").slice(0, 220)}`),
            ""].join("\n");
        }
      } catch { /* best-effort */ }
      const system = [
        `Tu es un ingénieur logiciel senior. Tu travailles sur le dépôt GitHub "${targetRepo}" (branche "${branch}").`,
        customInstructions ? `INSTRUCTIONS DU PROJET (à respecter impérativement) :\n${customInstructions}\n` : "",
        memBlock,
        recentWorkBlock,
        "Arborescence des fichiers (extrait) :", treeForPrompt, "",
        "RÈGLES :",
        "- PLANIFIE D'ABORD : avant de toucher au code, pose ta checklist avec update_todos (étapes courtes et vérifiables), puis maintiens-la EN CONTINU — l'étape courante 'active' avant de commencer, 'done' (avec note) une fois vérifiée. Si une étape s'avère complexe, DÉCOUPE-LA en sous-tâches (parent_id) plutôt que de la traiter d'un bloc — le parent n'est done que quand toutes ses sous-tâches le sont. Une seule feuille active à la fois : la checklist doit toujours montrer ce qui est fait, en cours, et à venir.",
        "- RÉUTILISE LE PASSÉ : si la tâche peut recouper un travail antérieur (même écran, même feature, même bug), vérifie avec search_past_sessions avant de refaire — et reste cohérent avec les décisions passées.",
        "- Lis les fichiers pertinents avec read_file AVANT de les modifier.",
        "- Écris chaque fichier modifié/créé avec write_file en fournissant TOUJOURS le contenu COMPLET (jamais un diff).",
        "- Utilise remember(content, scope) pour retenir une préférence/décision durable (scope 'global') ou propre à cette session ('session').",
        "- Changements minimaux, corrects, ciblés. Respecte le style existant.",
        mcpDefs.length ? `- Outils externes (MCP) disponibles : ${mcpDefs.map((d) => d.function.name).join(", ")}. Utilise-les si la tâche l'exige.` : "",
        "- Quand tu as terminé, réponds par un résumé court (markdown) de ce que tu as changé. Si tu as remarqué en travaillant des améliorations valables HORS du périmètre demandé (bug, test manquant, dette, faille), termine par une courte section « Initiatives » (1-3 puces, sans les implémenter) — jamais de modifications hors périmètre de ta propre initiative.",
      ].filter(Boolean).join("\n");
      // Cost-tiered model: cheap for simple edits, the stronger reasoning model
      // only for heavy coding tasks (refactor, debug, migration, architecture).
      const codeModel = modelForTier(classifyTier(prompt, { mode: "chat" }));
      const r = await runToolRounds({
        provider: "deepseek", model: codeModel,
        messages: [{ role: "system", content: system }, ...priorTurns, { role: "user", content: `Tâche : ${prompt}` }],
        tools: [...TOOLS, ...mcpDefs], executor, temperature: 0.2, maxTokens: 3500, maxRounds: 12,
      });
      // Budget épuisé en plein travail → courte passe de finalisation pour que
      // le message final reflète l'état réel (fait / restant) au lieu de se
      // couper net (même filet que les missions des agents internes).
      let finalContent = r.content;
      if (!r.finished) {
        try {
          const fin = await runToolRounds({
            provider: "deepseek", model: codeModel,
            messages: [
              { role: "system", content: system }, ...priorTurns,
              { role: "user", content: `Tâche : ${prompt}` },
              { role: "user", content: "STOP — budget d'étapes atteint. N'explore plus rien : mets à jour ta checklist (update_todos) une dernière fois, puis réponds par un résumé court de ce qui est FAIT (fichiers modifiés) et de ce qui RESTE à faire pour finir." },
            ],
            tools: [...TOOLS, ...mcpDefs], executor, temperature: 0.2, maxTokens: 2000, maxRounds: 3,
          });
          finalContent = fin.content || finalContent;
        } catch { /* finalize with what we have */ }
      }
      const changesArr = Object.entries(changes).map(([path, content]) => ({ path, content }));
      // FIX_PR: push the fix straight to the PR branch so the same PR re-runs CI.
      let committed: { commit_sha: string; pr_number?: number } | null = null;
      if (isFix && changesArr.length > 0) {
        const headSha = await getBranchSha(token, targetRepo, branch);
        const commitSha = await commitFiles(token, targetRepo, branch, headSha, changesArr, `fix: erreurs CI${prNumber ? ` (PR #${prNumber})` : ""}`);
        committed = { commit_sha: commitSha, pr_number: prNumber };
      }
      return {
        message: finalContent || "Terminé.", base_branch: branch,
        changes: changesArr,
        reads, steps, todos, tool_calls: r.toolCalls, finished: r.finished,
        committed,
      };
    };

    const persistDone = async (result: Awaited<ReturnType<typeof work>>) => {
      if (assistantId) await admin.from("vibe_messages").update({ content: result.message, meta: { status: "done", result, steps: result.steps, todos: result.todos } }).eq("id", assistantId);
    };
    const persistFailed = async (msg: string) => {
      if (assistantId) await admin.from("vibe_messages").update({ content: "", meta: { status: "failed", error: msg } }).eq("id", assistantId);
    };

    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (assistantId && er?.waitUntil) {
      er.waitUntil((async () => {
        try { await persistDone(await work()); }
        catch (e) { await persistFailed(e instanceof Error ? e.message : String(e)); }
      })());
      return jsonResponse({ assistant_message_id: assistantId, session_id: sid, async: true });
    }
    // Fallback (no background support): run inline.
    try {
      const result = await work();
      await persistDone(result);
      return jsonResponse({ assistant_message_id: assistantId, session_id: sid, async: false, ...result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await persistFailed(msg);
      return jsonResponse({ error: msg }, { status: 500 });
    }
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Erreur serveur" }, { status: 500 });
  }
});
