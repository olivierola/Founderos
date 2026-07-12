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
} from "../_shared/github.ts";
import { runToolRounds, type ToolDef } from "../_shared/ai.ts";

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
];

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const { data: userData, error: userErr } = await createUserClient(authHeader).auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const { workspace_id, project_id, repository_id, action } = body as {
      workspace_id?: string; project_id?: string; repository_id?: string;
      action?: "run" | "apply" | "pr_status" | "fix_pr";
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

    // ── APPLY: open a PR with the approved changes ─────────────────────────────
    if (action === "apply") {
      const { base_branch, title, body: prBody, changes, message_id } = body as {
        base_branch?: string; title?: string; body?: string; changes?: { path: string; content: string }[]; message_id?: string;
      };
      if (!changes?.length) return jsonResponse({ error: "Aucun changement à appliquer" }, { status: 400 });
      let result;
      try {
        result = await applyChanges(token, fullName, {
          changes, commitMessage: title || "Vibe Code: changes", mode: "pull_request",
          baseBranch: base_branch || (repo.default_branch as string) || undefined,
          prTitle: title || "Vibe Code changes",
          prBody: (prBody || "Changements proposés par l'agent Vibe Code.") + "\n\n— FounderOS · Vibe Code",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The PAT can read but not write → make the fix obvious.
        if (/\b403\b|Resource not accessible/i.test(msg)) {
          return jsonResponse({
            error: "Le token GitHub n'a pas les droits d'écriture sur ce dépôt. Reconnectez un token avec les permissions « Contents: Read and write » + « Pull requests: Read and write » (token fine-grained) ou le scope « repo » (token classique), via le module Dépôts → Reconnecter.",
            detail: msg,
          }, { status: 403 });
        }
        if (/No commits between/i.test(msg)) {
          return jsonResponse({ error: "Aucune différence à proposer : les modifications de l'agent sont identiques au code existant.", detail: msg }, { status: 409 });
        }
        throw e;
      }
      // Persist the PR (with its head branch) onto the assistant message so the
      // CI panel + fix loop survive a page reload. Non-fatal: never fail the PR.
      if (message_id && result.pull_request) {
        try {
          const { data: row } = await admin.from("vibe_messages").select("meta").eq("id", message_id).maybeSingle();
          const meta = ((row as { meta?: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>;
          await admin.from("vibe_messages").update({
            meta: { ...meta, pr: { html_url: result.pull_request.html_url, number: result.pull_request.number, branch: result.branch } },
          }).eq("id", message_id);
        } catch (_) { /* persistence is best-effort */ }
      }
      return jsonResponse(result);
    }

    // ── PR_STATUS: read the CI state of a PR head so the UI can show errors ─────
    if (action === "pr_status") {
      const { branch, head_sha } = body as { branch?: string; head_sha?: string };
      const ref = head_sha || (branch ? await getBranchSha(token, fullName, branch) : null);
      if (!ref) return jsonResponse({ error: "branch or head_sha required" }, { status: 400 });
      const ci = await collectCi(token, fullName, ref);
      return jsonResponse({ ...ci, head_sha: ref });
    }

    // ── RUN / FIX_PR: async agent. The read/LLM/write loop is long, so we return fast and
    // do the work in the BACKGROUND, persisting the result to vibe_messages (the
    // frontend polls that row). This avoids the gateway 504 on slow tasks.
    const isFix = action === "fix_pr";
    const { branch: reqBranch, session_id } = body as { branch?: string; session_id?: string };
    const prNumber = (body as { pr_number?: number }).pr_number;
    let { prompt } = body as { prompt?: string };

    // FIX_PR: seed the task from the PR's live CI failures; the fix is committed
    // to the PR branch (updates the same PR) instead of being staged.
    if (isFix) {
      if (!reqBranch) return jsonResponse({ error: "branch (PR head) requis" }, { status: 400 });
      const headSha0 = await getBranchSha(token, fullName, reqBranch);
      const ci = await collectCi(token, fullName, headSha0);
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
      const { data: s } = await admin.from("vibe_sessions").insert({
        workspace_id, project_id, repository_id, branch: reqBranch ?? null, title: prompt.slice(0, 60), created_by: userId,
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
      const branch = reqBranch || (repo.default_branch as string) || await getDefaultBranch(token, fullName);
      const sha = await getBranchSha(token, fullName, branch);
      const allPaths = await listRepoTree(token, fullName, sha);
      const treeForPrompt = allPaths.slice(0, 1200).join("\n");

      const changes: Record<string, string> = {};
      const reads: string[] = [];
      const steps: { t: string; label: string }[] = [];
      // Persisting a step on each tool call is what powers the LIVE view — the
      // frontend polls the message row and renders steps as they land.
      const pushStep = async (t: string, label: string) => {
        steps.push({ t, label });
        if (assistantId) await admin.from("vibe_messages").update({ meta: { status: "running", steps } }).eq("id", assistantId);
      };
      const executor = async (name: string, args: Record<string, unknown>): Promise<string> => {
        if (name === "read_file") {
          const p = String(args.path ?? "").replace(/^\.?\//, "");
          if (!p) return "ERROR: path requis";
          await pushStep("read", p);
          const content = await fetchFileContent(token, fullName, branch, p);
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
        return `ERROR: outil inconnu ${name}`;
      };
      const memBlock = (globalMem.length || sessionMem.length)
        ? ["MÉMOIRE (respecte ces éléments) :", ...globalMem.map((m) => `- [global] ${m}`), ...sessionMem.map((m) => `- [session] ${m}`), ""].join("\n")
        : "";
      const system = [
        `Tu es un ingénieur logiciel senior. Tu travailles sur le dépôt GitHub "${fullName}" (branche "${branch}").`,
        memBlock,
        "Arborescence des fichiers (extrait) :", treeForPrompt, "",
        "RÈGLES :",
        "- Lis les fichiers pertinents avec read_file AVANT de les modifier.",
        "- Écris chaque fichier modifié/créé avec write_file en fournissant TOUJOURS le contenu COMPLET (jamais un diff).",
        "- Utilise remember(content, scope) pour retenir une préférence/décision durable (scope 'global') ou propre à cette session ('session').",
        "- Changements minimaux, corrects, ciblés. Respecte le style existant.",
        "- Quand tu as terminé, réponds par un résumé court (markdown) de ce que tu as changé.",
      ].filter(Boolean).join("\n");
      const r = await runToolRounds({
        provider: "deepseek",
        messages: [{ role: "system", content: system }, ...priorTurns, { role: "user", content: `Tâche : ${prompt}` }],
        tools: TOOLS, executor, temperature: 0.2, maxTokens: 3500, maxRounds: 12,
      });
      const changesArr = Object.entries(changes).map(([path, content]) => ({ path, content }));
      // FIX_PR: push the fix straight to the PR branch so the same PR re-runs CI.
      let committed: { commit_sha: string; pr_number?: number } | null = null;
      if (isFix && changesArr.length > 0) {
        const headSha = await getBranchSha(token, fullName, branch);
        const commitSha = await commitFiles(token, fullName, branch, headSha, changesArr, `fix: erreurs CI${prNumber ? ` (PR #${prNumber})` : ""}`);
        committed = { commit_sha: commitSha, pr_number: prNumber };
      }
      return {
        message: r.content || "Terminé.", base_branch: branch,
        changes: changesArr,
        reads, steps, tool_calls: r.toolCalls, finished: r.finished,
        committed,
      };
    };

    const persistDone = async (result: Awaited<ReturnType<typeof work>>) => {
      if (assistantId) await admin.from("vibe_messages").update({ content: result.message, meta: { status: "done", result, steps: result.steps } }).eq("id", assistantId);
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
