// repo-browse — on-demand read access to a connected GitHub repo, using the
// project's stored PAT (connect-github). Two actions:
//   • "load": returns the branch list + the full file tree for a ref.
//   • "file": returns a single file's decoded content.
// Powers the repo detail page's interactive explorer + code viewer.
// Body: { workspace_id, project_id, repository_id, action, ref?, path? }
import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { decryptSecret } from "../_shared/crypto.ts";
import { getDefaultBranch, getBranchSha, listRepoTree, fetchFileContent } from "../_shared/github.ts";

async function ghApi<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "founderos" },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

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
    const { workspace_id, project_id, repository_id, action, ref, path } = body as {
      workspace_id?: string; project_id?: string; repository_id?: string;
      action?: "load" | "file" | "stats" | "info" | "pulls" | "fork" | "deployments"; ref?: string; path?: string;
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

    if (action === "file") {
      if (!path) return jsonResponse({ error: "path required" }, { status: 400 });
      const branch = ref || (repo.default_branch as string) || await getDefaultBranch(token, fullName);
      const content = await fetchFileContent(token, fullName, branch, path);
      return jsonResponse({ path, content });
    }

    if (action === "stats") {
      const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "founderos" };
      const meta = await ghApi<Record<string, unknown>>(token, `/repos/${fullName}`);

      // Weekly commit activity (52 weeks × 7 days) — GitHub returns 202 while it
      // computes the stats the first time, so retry briefly.
      let weeks: { week: number; days: number[] }[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`https://api.github.com/repos/${fullName}/stats/commit_activity`, { headers });
        if (res.status === 202) { await new Promise((r) => setTimeout(r, 1300)); continue; }
        if (res.ok) {
          const arr = (await res.json()) as { week: number; days: number[] }[];
          weeks = (arr ?? []).map((w) => ({ week: w.week, days: w.days }));
        }
        break;
      }
      const total = weeks.reduce((s, w) => s + (w.days ?? []).reduce((a, b) => a + b, 0), 0);

      // Recent event breakdown (pushes, PRs, issues, stars, forks…) — last ~90d.
      const events = await ghApi<{ type: string }[]>(token, `/repos/${fullName}/events?per_page=100`).catch(() => []);
      const activity: Record<string, number> = {};
      for (const e of events) {
        const t = String(e.type ?? "").replace(/Event$/, "").toLowerCase();
        if (t) activity[t] = (activity[t] ?? 0) + 1;
      }

      const m = meta as Record<string, number | string | { spdx_id?: string } | null>;
      return jsonResponse({
        meta: {
          stars: m.stargazers_count ?? 0, forks: m.forks_count ?? 0, open_issues: m.open_issues_count ?? 0,
          watchers: m.subscribers_count ?? 0, size_kb: m.size ?? 0, language: m.language ?? null,
          created_at: m.created_at ?? null, updated_at: m.updated_at ?? null, pushed_at: m.pushed_at ?? null,
          license: (m.license as { spdx_id?: string } | null)?.spdx_id ?? null,
        },
        heatmap: { weeks, total },
        activity,
      });
    }

    if (action === "info") {
      const m = await ghApi<Record<string, unknown>>(token, `/repos/${fullName}`);
      return jsonResponse({
        homepage: m.homepage ?? null, html_url: m.html_url ?? null, description: m.description ?? null,
        default_branch: m.default_branch ?? null, is_fork: m.fork ?? false,
        parent: (m.parent as { full_name?: string } | undefined)?.full_name ?? null,
      });
    }

    if (action === "pulls") {
      const prs = await ghApi<Record<string, unknown>[]>(token, `/repos/${fullName}/pulls?state=all&per_page=30&sort=updated&direction=desc`).catch(() => []);
      return jsonResponse({
        pulls: prs.map((p) => ({
          number: p.number, title: p.title, state: p.state, draft: p.draft ?? false,
          html_url: p.html_url, user: (p.user as { login?: string } | undefined)?.login ?? null,
          created_at: p.created_at, updated_at: p.updated_at,
          head: (p.head as { ref?: string } | undefined)?.ref ?? null,
          base: (p.base as { ref?: string } | undefined)?.ref ?? null,
          merged_at: p.merged_at ?? null,
        })),
      });
    }

    if (action === "deployments") {
      // Vercel/Netlify (and other CI) create GitHub deployments; the latest
      // status of each carries the live preview URL (environment_url/target_url).
      const deps = await ghApi<Record<string, unknown>[]>(token, `/repos/${fullName}/deployments?per_page=15`).catch(() => []);
      const out = await Promise.all(deps.map(async (d) => {
        const statuses = await ghApi<Record<string, unknown>[]>(token, `/repos/${fullName}/deployments/${d.id}/statuses?per_page=1`).catch(() => []);
        const s = statuses[0] as { state?: string; environment_url?: string; target_url?: string } | undefined;
        return {
          id: d.id, environment: d.environment ?? null, ref: d.ref ?? null,
          sha: String(d.sha ?? "").slice(0, 7), created_at: d.created_at ?? null,
          description: d.description ?? null,
          state: s?.state ?? "pending", url: s?.environment_url || s?.target_url || null,
        };
      }));
      return jsonResponse({ deployments: out });
    }

    if (action === "fork") {
      const res = await fetch(`https://api.github.com/repos/${fullName}/forks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "founderos", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return jsonResponse({ error: (j as { message?: string }).message ?? `GitHub ${res.status}` }, { status: res.status === 403 ? 403 : 500 });
      return jsonResponse({ full_name: (j as { full_name?: string }).full_name ?? null, html_url: (j as { html_url?: string }).html_url ?? null });
    }

    // action === "load"
    const defaultBranch = (repo.default_branch as string) || await getDefaultBranch(token, fullName);
    const branch = ref || defaultBranch;
    const branches = await ghApi<{ name: string }[]>(token, `/repos/${fullName}/branches?per_page=100`).catch(() => []);
    const sha = await getBranchSha(token, fullName, branch);
    const paths = await listRepoTree(token, fullName, sha);
    return jsonResponse({
      full_name: fullName, ref: branch, default_branch: defaultBranch,
      branches: branches.map((b) => b.name), paths,
    });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Erreur serveur" }, { status: 500 });
  }
});
