// repo-scan — scan a GitHub repository's code via the GitHub API (no clone).
// Reuses the project's stored GitHub PAT (connect-github), lists the repo tree,
// fetches key manifests and produces a scan_result: languages, dependencies,
// services, env vars and basic security findings. Self-contained (replaces the
// old start-repo-scan → process-repo-scan chain).
// Body: { workspace_id, project_id, github_repo: { full_name, name?, private?, default_branch?, external_id? } }
import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { getDefaultBranch, getBranchSha, listRepoTree, fetchFileContent } from "../_shared/github.ts";
import { resolveGithubToken } from "../_shared/github-token.ts";

const EXT_LANG: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript",
  py: "Python", go: "Go", rs: "Rust", java: "Java", rb: "Ruby", php: "PHP", cs: "C#",
  cpp: "C++", cc: "C++", c: "C", h: "C", swift: "Swift", kt: "Kotlin", scala: "Scala",
  vue: "Vue", svelte: "Svelte", sql: "SQL", sh: "Shell", bash: "Shell",
  css: "CSS", scss: "CSS", less: "CSS", html: "HTML", md: "Markdown", yml: "YAML", yaml: "YAML",
};

function detectLanguages(paths: string[]) {
  const counts: Record<string, number> = {};
  for (const p of paths) {
    const ext = p.split(".").pop()?.toLowerCase() ?? "";
    const lang = EXT_LANG[ext];
    if (lang) counts[lang] = (counts[lang] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, files]) => ({ name, files }));
}

function parseDeps(files: Record<string, string | null>) {
  const deps: { name: string; version: string; manager: string }[] = [];
  const pkg = files["package.json"];
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const [n, v] of Object.entries({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) })) deps.push({ name: n, version: String(v), manager: "npm" });
    } catch { /* ignore */ }
  }
  const req = files["requirements.txt"];
  if (req) for (const raw of req.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const m = line.match(/^([A-Za-z0-9_.\-]+)\s*([=<>~!].*)?$/);
    if (m) deps.push({ name: m[1], version: (m[2] ?? "").trim(), manager: "pip" });
  }
  const gomod = files["go.mod"];
  if (gomod) for (const raw of gomod.split("\n")) {
    const m = raw.trim().match(/^([\w.\-/]+)\s+v([\w.\-]+)/);
    if (m && !raw.includes("module ") && !raw.includes("go 1.")) deps.push({ name: m[1], version: `v${m[2]}`, manager: "go" });
  }
  const composer = files["composer.json"];
  if (composer) {
    try {
      const j = JSON.parse(composer) as { require?: Record<string, string> };
      for (const [n, v] of Object.entries(j.require ?? {})) deps.push({ name: n, version: String(v), manager: "composer" });
    } catch { /* ignore */ }
  }
  return deps;
}

function parseEnvVars(content: string | null) {
  if (!content) return [] as { name: string }[];
  return content.split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => ({ name: l.split("=")[0].trim() }));
}

function parseServices(compose: string | null, dockerfile: string | null) {
  const services: { name: string; image?: string }[] = [];
  if (compose) {
    const lines = compose.split("\n");
    let inServices = false;
    for (const line of lines) {
      if (/^services:\s*$/.test(line)) { inServices = true; continue; }
      if (inServices) {
        if (/^\S/.test(line)) { inServices = false; continue; }
        const m = line.match(/^\s{2,4}([A-Za-z0-9_.\-]+):\s*$/);
        if (m) services.push({ name: m[1] });
      }
    }
  }
  if (dockerfile) {
    const m = dockerfile.match(/^\s*FROM\s+(\S+)/im);
    if (m) services.push({ name: "container", image: m[1] });
  }
  return services;
}

/* ── App-structure extraction (the onboarding "carte") ──────────────────────
   Heuristically maps the frontend: page files → routes → clickable elements.
   This raw map is what enrich-app-structure later turns into a semantic one. */
const PAGE_DIR_RE = /\/(pages|app|routes|views|screens)\//i;
function looksLikePage(path: string): boolean {
  const lower = path.toLowerCase();
  if (!/\.(tsx|jsx|vue|svelte)$/.test(lower)) return false;
  if (/\.(test|spec|stories|d)\./.test(lower)) return false;
  if (/\/(components?|ui|lib|utils|hooks|assets|styles)\//.test(lower)) return false;
  const base = lower.split("/").pop()!;
  if (PAGE_DIR_RE.test(lower)) return true;
  if (/(page|route|view|screen)\.(tsx|jsx|vue|svelte)$/.test(base)) return true;
  if (/[a-z0-9]+page\.(tsx|jsx)$/.test(base)) return true; // FooPage.tsx
  return false;
}
function routeFromPath(path: string): string {
  let r = path.replace(/^.*?(pages|app|routes|views|screens)\//i, "");
  r = r.replace(/\.(tsx|jsx|vue|svelte)$/i, "");
  r = r.replace(/\/?(index|page|\+page)$/i, "");
  r = r.replace(/\[\.{3}([^\]]+)\]/g, "*").replace(/\[([^\]]+)\]/g, ":$1"); // [id]→:id, [...x]→*
  r = "/" + r.replace(/^\/+/, "");
  return r === "/" ? "/" : r.replace(/\/$/, "");
}
function nameFromPath(path: string): string {
  let base = path.split("/").pop()!.replace(/\.(tsx|jsx|vue|svelte)$/i, "");
  if (/^(index|page|\+page)$/i.test(base)) base = path.split("/").slice(-2, -1)[0] ?? base;
  return base.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function extractElements(src: string): { type: string; label: string; action?: string }[] {
  const clean = (s: string) => s.replace(/\{[^}]*\}/g, "").replace(/\s+/g, " ").trim();
  const els: { type: string; label: string; action?: string }[] = [];
  for (const m of src.matchAll(/<(?:button|Button)[^>]*>([^<{][^<]{0,40})<\/(?:button|Button)>/g)) {
    const label = clean(m[1]); if (label) els.push({ type: "button", label });
  }
  for (const m of src.matchAll(/<(?:Link|a|NavLink)[^>]*(?:to|href)=["'{`]?([^"'}\s>`]+)/g)) {
    els.push({ type: "link", label: m[1], action: m[1] });
  }
  for (const m of src.matchAll(/<input[^>]*placeholder=["']([^"']{1,40})/gi)) {
    els.push({ type: "input", label: clean(m[1]) });
  }
  for (const m of src.matchAll(/<h[1-3][^>]*>([^<{][^<]{0,50})<\/h[1-3]>/g)) {
    const label = clean(m[1]); if (label) els.push({ type: "heading", label });
  }
  // Dedupe by type+label, cap per page.
  const seen = new Set<string>();
  return els.filter((e) => { const k = e.type + "|" + e.label; if (seen.has(k) || !e.label) return false; seen.add(k); return true; }).slice(0, 12);
}
async function buildAppStructure(
  token: string, fullName: string, sha: string, tree: string[],
): Promise<{ pages: unknown[]; routes: string[]; element_count: number }> {
  const pagePaths = tree.filter(looksLikePage).slice(0, 30);
  const pages: { name: string; path: string; route: string; elements: { type: string; label: string; action?: string }[] }[] = [];
  let elementCount = 0;
  await Promise.all(pagePaths.map(async (p) => {
    const src = (await fetchFileContent(token, fullName, sha, p)) ?? "";
    const elements = extractElements(src);
    elementCount += elements.length;
    pages.push({ name: nameFromPath(p), path: p, route: routeFromPath(p), elements });
  }));
  pages.sort((a, b) => a.route.localeCompare(b.route));
  const routes = [...new Set(pages.map((pg) => pg.route))];
  return { pages, routes, element_count: elementCount };
}

const SECRET_RES: { re: RegExp; title: string; severity: string }[] = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, title: "Clé privée committée dans le dépôt", severity: "critical" },
  { re: /AKIA[0-9A-Z]{16}/, title: "Clé d'accès AWS potentielle en dur", severity: "high" },
  { re: /gh[posr]_[A-Za-z0-9]{36,}/, title: "Token GitHub potentiel en dur", severity: "high" },
  { re: /(?:secret|token|password|passwd|api[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i, title: "Secret potentiel codé en dur", severity: "medium" },
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
    const { workspace_id, project_id, github_repo } = body as {
      workspace_id?: string; project_id?: string;
      github_repo?: { full_name: string; name?: string; private?: boolean; default_branch?: string; external_id?: number | string };
    };
    if (!workspace_id || !project_id || !github_repo?.full_name) {
      return jsonResponse({ error: "workspace_id, project_id, github_repo.full_name required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin.from("workspace_members").select("role").eq("workspace_id", workspace_id).eq("user_id", userId).maybeSingle();
    if (!membership) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    // A GitHub connection must exist (legacy PAT or Composio), but REGISTERING
    // the repo doesn't need a token — the caller (the Composio repo picker)
    // already provides the metadata. Only the content SCAN needs a raw token,
    // and Composio masks it, so we resolve best-effort and degrade gracefully:
    // register the repo now (so the Vibe Coder can use it), scan only if we got
    // a usable raw token.
    const { data: connector } = await admin.from("connectors").select("id").eq("project_id", project_id).eq("provider", "github").maybeSingle();
    if (!connector) return jsonResponse({ error: "GitHub non connecté" }, { status: 400 });
    const resolved = await resolveGithubToken(admin, workspace_id, project_id);
    const token = resolved?.token ?? null;

    const fullName = github_repo.full_name;

    // Upsert the repository row (no token required).
    let repositoryId: string;
    const { data: existing } = await admin.from("repositories").select("id").eq("project_id", project_id).eq("full_name", fullName).maybeSingle();
    if (existing) {
      repositoryId = existing.id;
    } else {
      const { data: inserted, error: insErr } = await admin.from("repositories").insert({
        workspace_id, project_id, provider: "github", external_id: github_repo.external_id ? String(github_repo.external_id) : null,
        name: github_repo.name ?? fullName.split("/").pop(), full_name: fullName,
        default_branch: github_repo.default_branch ?? null, private: github_repo.private ?? true,
      }).select("id").single();
      if (insErr) return jsonResponse({ error: insErr.message }, { status: 500 });
      repositoryId = inserted.id;
    }

    // No usable raw token (e.g. GitHub connected only through Composio, which
    // masks the OAuth token) → the repo is registered and usable, but we can't
    // read its contents to index it. Return success without scanning.
    if (!token) {
      return jsonResponse({ ok: true, repository_id: repositoryId, scanned: false, reason: "no_raw_token" });
    }

    // Create a running scan_job.
    const { data: job } = await admin.from("scan_jobs").insert({
      workspace_id, project_id, repository_id: repositoryId, status: "running", started_at: new Date().toISOString(),
    }).select("id").single();
    const jobId = job!.id;

    try {
      const branch = github_repo.default_branch || await getDefaultBranch(token, fullName);
      const sha = await getBranchSha(token, fullName, branch);
      const tree = await listRepoTree(token, fullName, sha);

      // Fetch the interesting files that actually exist (by basename, first match).
      const WANT = ["package.json", "requirements.txt", "go.mod", "composer.json", "gemfile", "pom.xml",
        ".env.example", ".env.sample", "docker-compose.yml", "docker-compose.yaml", "dockerfile"];
      const byBase: Record<string, string> = {};
      for (const p of tree) {
        const base = p.split("/").pop()!.toLowerCase();
        if (WANT.includes(base) && !byBase[base]) byBase[base] = p;
      }
      const files: Record<string, string | null> = {};
      await Promise.all(Object.entries(byBase).map(async ([base, path]) => {
        files[base] = await fetchFileContent(token, fullName, sha, path);
      }));
      // Normalise keys the parsers expect.
      files["package.json"] ??= files["package.json"] ?? null;

      const languages = detectLanguages(tree);
      // Build the app map (pages/routes/elements) for the onboarding "carte".
      let appStructure: { pages: unknown[]; routes: string[]; element_count: number } = { pages: [], routes: [], element_count: 0 };
      try { appStructure = await buildAppStructure(token, fullName, sha, tree); } catch { /* non-fatal */ }
      const dependencies = parseDeps({
        "package.json": files["package.json"] ?? null,
        "requirements.txt": files["requirements.txt"] ?? null,
        "go.mod": files["go.mod"] ?? null,
        "composer.json": files["composer.json"] ?? null,
      });
      const envVars = parseEnvVars(files[".env.example"] ?? files[".env.sample"] ?? null);
      const services = parseServices(
        files["docker-compose.yml"] ?? files["docker-compose.yaml"] ?? null,
        files["dockerfile"] ?? null,
      );

      // Security findings.
      const findings: { severity: string; title: string; file?: string; detail?: string }[] = [];
      // Committed .env (not an example/template).
      for (const p of tree) {
        const base = p.split("/").pop()!.toLowerCase();
        if (/^\.env(\.[a-z]+)?$/.test(base) && !/(example|sample|template|dist)/.test(base)) {
          findings.push({ severity: "high", title: "Fichier .env committé (secrets potentiels)", file: p });
        }
      }
      // Secret patterns in the fetched files.
      for (const [base, content] of Object.entries(files)) {
        if (!content) continue;
        for (const s of SECRET_RES) if (s.re.test(content)) findings.push({ severity: s.severity, title: s.title, file: byBase[base] ?? base });
      }

      const bySeverity = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc; }, {} as Record<string, number>);
      const summary = {
        files: tree.length, branch, pages: appStructure.pages.length,
        languages: languages.slice(0, 6),
        dependencies: dependencies.length,
        services: services.length,
        env_vars: envVars.length,
        findings: findings.length,
        by_severity: bySeverity,
      };

      await admin.from("scan_results").insert({
        scan_job_id: jobId, workspace_id, project_id, repository_id: repositoryId,
        summary, dependencies, env_vars: envVars, services,
        architecture: { languages }, security_findings: findings, ai_analysis: {},
        app_structure: appStructure,
      });
      await admin.from("scan_jobs").update({ status: "succeeded", finished_at: new Date().toISOString(), progress: summary }).eq("id", jobId);
      await admin.from("repositories").update({ last_scanned_at: new Date().toISOString() }).eq("id", repositoryId);

      return jsonResponse({ scan_job_id: jobId, repository_id: repositoryId, summary });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin.from("scan_jobs").update({ status: "failed", finished_at: new Date().toISOString(), error_message: msg.slice(0, 500) }).eq("id", jobId);
      return jsonResponse({ error: msg, scan_job_id: jobId }, { status: 500 });
    }
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Erreur serveur" }, { status: 500 });
  }
});
