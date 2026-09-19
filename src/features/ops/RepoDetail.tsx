import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "highlight.js/styles/github-dark.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GithubLogoIcon as Github,
  ArrowLeftIcon as ArrowLeft,
  FolderIcon as Folder,
  FileCodeIcon as FileCode,
  CaretRightIcon as ChevronRight,
  GitBranchIcon as GitBranch,
  CircleNotchIcon as Loader2,
  XIcon as X,
  ArrowSquareOutIcon as ExternalLink,
  ScanIcon as ScanLine,
  ShieldWarningIcon as ShieldAlert,
  CubeIcon as Boxes,
  BracketsCurlyIcon as Braces,
  CpuIcon as Cpu,
  HouseIcon as Home,
  CopyIcon as Copy,
  CheckIcon as Check,
  StarIcon as Star,
  GitForkIcon as GitFork,
  RadioButtonIcon as CircleDot,
  EyeIcon as Eye,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

interface Repo { id: string; full_name: string; default_branch: string | null; private: boolean; last_scanned_at: string | null }
interface LoadResult { full_name: string; ref: string; default_branch: string; branches: string[]; paths: string[] }
interface ScanResult {
  summary: { files?: number; languages?: { name: string; files: number }[]; dependencies?: number; services?: number; env_vars?: number; findings?: number };
  dependencies: { name: string; version: string; manager: string }[];
  env_vars: { name: string }[];
  services: { name: string; image?: string }[];
  security_findings: { severity: string; title: string; file?: string }[];
  created_at: string;
}
interface StatsResult {
  meta: { stars: number; forks: number; open_issues: number; watchers: number; size_kb: number; language: string | null; created_at: string | null; updated_at: string | null; pushed_at: string | null; license: string | null };
  heatmap: { weeks: { week: number; days: number[] }[]; total: number };
  activity: Record<string, number>;
}

// Recent-event key → readable label (GitHub events, ~last 90 days).
const ACTIVITY_LABEL: { key: string; label: string }[] = [
  { key: "push", label: "Pushes" },
  { key: "pullrequest", label: "Pull requests" },
  { key: "issues", label: "Issues" },
  { key: "watch", label: "Stars" },
  { key: "fork", label: "Forks" },
  { key: "create", label: "Créations" },
  { key: "release", label: "Releases" },
];

const SEVERITY_TONE: Record<string, string> = {
  critical: "text-red-600 dark:text-red-400", high: "text-orange-600 dark:text-orange-400",
  medium: "text-amber-600 dark:text-amber-400", low: "text-sky-600 dark:text-sky-400",
};

function entriesAt(paths: string[], cwd: string) {
  const prefix = cwd ? cwd + "/" : "";
  const folders = new Set<string>();
  const files: string[] = [];
  for (const p of paths) {
    if (prefix && !p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) files.push(rest);
    else folders.add(rest.slice(0, slash));
  }
  return { folders: [...folders].sort(), files: files.sort() };
}

export function RepoDetailPage() {
  const { repoId } = useParams();
  const navigate = useNavigate();
  const { workspaceId, projectId, workspace, project } = useCurrentContext();
  const qc = useQueryClient();
  const base = workspace && project ? `/app/${workspace.slug}/${project.slug}` : "";

  const [branch, setBranch] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const { data: repo } = useQuery({
    queryKey: ["repository", repoId],
    enabled: !!repoId,
    queryFn: async () => {
      const { data } = await supabase.from("repositories").select("id, full_name, default_branch, private, last_scanned_at").eq("id", repoId!).maybeSingle();
      return data as Repo | null;
    },
  });

  const { data: tree, isLoading: treeLoading, error: treeError } = useQuery({
    queryKey: ["repo-browse", repoId, branch],
    enabled: !!repoId && !!workspaceId && !!projectId,
    queryFn: async () => {
      const res = await callEdge<LoadResult>("repo-browse", { workspace_id: workspaceId, project_id: projectId, repository_id: repoId, action: "load", ref: branch ?? undefined });
      return res;
    },
  });

  const { data: scan } = useQuery({
    queryKey: ["scan_result", repoId],
    enabled: !!repoId,
    queryFn: async () => {
      const { data } = await supabase.from("scan_results").select("*").eq("repository_id", repoId!).order("created_at", { ascending: false }).limit(1).maybeSingle();
      return data as ScanResult | null;
    },
  });

  const { data: stats } = useQuery({
    queryKey: ["repo-stats", repoId],
    enabled: !!repoId && !!workspaceId && !!projectId,
    retry: false,
    queryFn: async () => callEdge<StatsResult>("repo-browse", { workspace_id: workspaceId, project_id: projectId, repository_id: repoId, action: "stats" }),
  });

  const { data: fileData, isLoading: fileLoading } = useQuery({
    queryKey: ["repo-file", repoId, tree?.ref, openFile],
    enabled: !!openFile && !!tree,
    queryFn: async () => {
      const res = await callEdge<{ path: string; content: string | null }>("repo-browse", { workspace_id: workspaceId, project_id: projectId, repository_id: repoId, action: "file", ref: tree?.ref, path: openFile });
      return res;
    },
  });

  const entries = useMemo(() => entriesAt(tree?.paths ?? [], cwd), [tree?.paths, cwd]);
  const crumbs = cwd ? cwd.split("/") : [];

  async function rescan() {
    if (!repo || !workspaceId || !projectId) return;
    setRescanning(true);
    try {
      await callEdge("repo-scan", { workspace_id: workspaceId, project_id: projectId, github_repo: { full_name: repo.full_name, private: repo.private, default_branch: repo.default_branch ?? "main" } });
      await qc.invalidateQueries({ queryKey: ["scan_result", repoId] });
      await qc.invalidateQueries({ queryKey: ["repository", repoId] });
    } finally { setRescanning(false); }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Canvas */}
      <div
        className="relative min-w-0 flex-1 overflow-hidden bg-muted/20"
        style={{ backgroundImage: "radial-gradient(hsl(var(--muted-foreground) / 0.22) 1px, transparent 1px)", backgroundSize: "18px 18px" }}
      >
        {/* Top-left back */}
        <div className="absolute left-4 top-4 z-10">
          <Button size="sm" variant="outline" className="bg-background/80 backdrop-blur" onClick={() => navigate(`${base}/repos/list`)}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Dépôts
          </Button>
        </div>

        <div className="flex h-full items-center justify-center p-6 sm:p-10">
          <div className="flex h-[74vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
            {openFile ? (
              <CodeCard
                path={openFile}
                content={fileData?.content ?? null}
                loading={fileLoading}
                onClose={() => setOpenFile(null)}
              />
            ) : (
              <>
                {/* Card header — repo + branch */}
                <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary"><Github className="h-4 w-4" /></div>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{repo?.full_name ?? "…"}</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline"><GitBranch className="mr-1.5 h-3.5 w-3.5" />{tree?.ref ?? "…"}<ChevronRight className="ml-1 h-3 w-3 rotate-90" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                      {(tree?.branches ?? []).map((b) => (
                        <DropdownMenuItem key={b} onClick={() => { setBranch(b); setCwd(""); setOpenFile(null); }}>
                          <GitBranch className="h-3.5 w-3.5" /> {b}{b === tree?.ref && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Breadcrumb */}
                <div className="flex flex-wrap items-center gap-1 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
                  <button onClick={() => setCwd("")} className="inline-flex items-center gap-1 hover:text-foreground"><Home className="h-3.5 w-3.5" /></button>
                  {crumbs.map((c, i) => (
                    <span key={i} className="inline-flex items-center gap-1">
                      <ChevronRight className="h-3 w-3" />
                      <button onClick={() => setCwd(crumbs.slice(0, i + 1).join("/"))} className="hover:text-foreground">{c}</button>
                    </span>
                  ))}
                </div>

                {/* Tree listing */}
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {treeLoading ? (
                    <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : treeError ? (
                    <div className="p-4 text-sm text-destructive">{(treeError as Error).message}</div>
                  ) : (
                    <ul className="space-y-0.5">
                      {cwd && (
                        <li>
                          <button onClick={() => setCwd(crumbs.slice(0, -1).join("/"))} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/50">
                            <Folder className="h-4 w-4" /> ..
                          </button>
                        </li>
                      )}
                      {entries.folders.map((f) => (
                        <li key={f}>
                          <button onClick={() => setCwd(cwd ? `${cwd}/${f}` : f)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
                            <Folder className="h-4 w-4 text-sky-500" /> <span className="truncate">{f}</span>
                          </button>
                        </li>
                      ))}
                      {entries.files.map((f) => (
                        <li key={f}>
                          <button onClick={() => setOpenFile(cwd ? `${cwd}/${f}` : f)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
                            <FileCode className="h-4 w-4 text-muted-foreground" /> <span className="truncate">{f}</span>
                          </button>
                        </li>
                      ))}
                      {entries.folders.length === 0 && entries.files.length === 0 && (
                        <li className="px-2 py-6 text-center text-sm text-muted-foreground">Dossier vide.</li>
                      )}
                    </ul>
                  )}
                </div>
                <div className="border-t border-border/60 px-4 py-1.5 text-[11px] text-muted-foreground">
                  {(tree?.paths.length ?? 0)} fichiers · branche {tree?.ref}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Right info panel */}
      <aside className="hidden w-[540px] shrink-0 overflow-y-auto border-l border-border bg-card md:block lg:w-[640px] xl:w-[720px]">
        <div className="space-y-5 p-4">
          <div>
            <div className="flex items-center gap-2">
              <Github className="h-4 w-4" />
              <a href={`https://github.com/${repo?.full_name ?? ""}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm font-semibold hover:underline">{repo?.full_name ?? "…"}</a>
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <Badge variant="outline"><GitBranch className="mr-1 h-3 w-3" />{tree?.ref ?? repo?.default_branch ?? "main"}</Badge>
              {repo?.private ? <Badge variant="secondary">privé</Badge> : <Badge variant="outline">public</Badge>}
            </div>
          </div>

          <Button size="sm" variant="outline" className="w-full" onClick={rescan} disabled={rescanning}>
            {rescanning ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ScanLine className="mr-1.5 h-3.5 w-3.5" />} Re-scanner
          </Button>

          {stats && (
            <>
              <Section title="Statistiques">
                <div className="grid grid-cols-4 gap-2">
                  <Stat icon={Star} label="Stars" value={stats.meta.stars} />
                  <Stat icon={GitFork} label="Forks" value={stats.meta.forks} />
                  <Stat icon={CircleDot} label="Issues" value={stats.meta.open_issues} />
                  <Stat icon={Eye} label="Watchers" value={stats.meta.watchers} />
                </div>
                {(stats.meta.language || stats.meta.size_kb) ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                    {stats.meta.language && <Badge variant="secondary">{stats.meta.language}</Badge>}
                    {stats.meta.size_kb ? <Badge variant="outline">{(stats.meta.size_kb / 1024).toFixed(1)} Mo</Badge> : null}
                    {stats.meta.license && <Badge variant="outline">{stats.meta.license}</Badge>}
                    {stats.meta.pushed_at && <span>push {new Date(stats.meta.pushed_at).toLocaleDateString("fr-FR")}</span>}
                  </div>
                ) : null}
              </Section>

              <Section title="Activité récente (≈ 90 j)">
                {Object.keys(stats.activity).length === 0 ? (
                  <p className="text-xs text-muted-foreground">Aucune activité récente.</p>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {ACTIVITY_LABEL.filter((a) => stats.activity[a.key]).map((a) => (
                      <div key={a.key} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-xs">
                        <span className="text-muted-foreground">{a.label}</span><span className="font-semibold">{stats.activity[a.key]}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section title={`Commits — ${stats.heatmap.total} sur 12 mois`}>
                {stats.heatmap.weeks.length === 0
                  ? <p className="text-xs text-muted-foreground">Statistiques en cours de calcul par GitHub — réessayez dans un instant.</p>
                  : <Heatmap weeks={stats.heatmap.weeks} />}
              </Section>
            </>
          )}

          {scan ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Stat icon={Boxes} label="Fichiers" value={scan.summary.files ?? tree?.paths.length ?? 0} />
                <Stat icon={Braces} label="Dépendances" value={scan.summary.dependencies ?? scan.dependencies.length} />
                <Stat icon={Cpu} label="Services" value={scan.summary.services ?? scan.services.length} />
                <Stat icon={ShieldAlert} label="Findings" value={scan.security_findings.length} tone={scan.security_findings.length ? "text-red-500" : undefined} />
              </div>

              {(scan.summary.languages ?? []).length > 0 && (
                <Section title="Langages">
                  <div className="flex flex-wrap gap-1.5">{scan.summary.languages!.map((l) => <Badge key={l.name} variant="secondary">{l.name} · {l.files}</Badge>)}</div>
                </Section>
              )}
              {scan.security_findings.length > 0 && (
                <Section title={`Sécurité (${scan.security_findings.length})`}>
                  <ul className="space-y-1.5">
                    {scan.security_findings.map((f, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <ShieldAlert className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", SEVERITY_TONE[f.severity] ?? "text-muted-foreground")} />
                        <span><span className="font-medium">{f.title}</span>{f.file && <button onClick={() => { setOpenFile(f.file!); }} className="ml-1 text-muted-foreground underline-offset-2 hover:underline">{f.file}</button>}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
              {scan.services.length > 0 && (
                <Section title="Services"><div className="flex flex-wrap gap-1.5">{scan.services.map((s, i) => <Badge key={i} variant="outline">{s.name}{s.image ? ` · ${s.image}` : ""}</Badge>)}</div></Section>
              )}
              {scan.env_vars.length > 0 && (
                <Section title={`Variables d'env (${scan.env_vars.length})`}><div className="flex flex-wrap gap-1">{scan.env_vars.slice(0, 30).map((e, i) => <code key={i} className="rounded bg-secondary px-1.5 py-0.5 text-[10px]">{e.name}</code>)}</div></Section>
              )}
              {scan.dependencies.length > 0 && (
                <Section title={`Dépendances (${scan.dependencies.length})`}>
                  <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                    <table className="w-full text-[11px]">
                      <tbody>
                        {scan.dependencies.slice(0, 100).map((d, i) => (
                          <tr key={i} className="border-b border-border/50 last:border-0"><td className="px-2 py-1 font-mono">{d.name}</td><td className="px-2 py-1 text-right text-muted-foreground">{d.version}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Section>
              )}
              <p className="text-[11px] text-muted-foreground">Scan du {new Date(scan.created_at).toLocaleString("fr-FR")}</p>
            </>
          ) : (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">Aucun scan encore. Cliquez « Re-scanner ».</p>
          )}
        </div>
      </aside>
    </div>
  );
}

// Extension / basename → highlight.js language.
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", scala: "scala",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php", lua: "lua", r: "r", pl: "perl",
  css: "css", scss: "scss", less: "less", html: "xml", htm: "xml", xml: "xml", vue: "xml", svelte: "xml",
  json: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", env: "ini",
  sh: "bash", bash: "bash", zsh: "bash", sql: "sql", md: "markdown", markdown: "markdown", graphql: "graphql", diff: "diff",
};
function langOf(path: string): string | undefined {
  const base = path.split("/").pop()!.toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return EXT_LANG[ext];
}
function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function CodeCard({ path, content, loading, onClose }: { path: string; content: string | null; loading: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [lines, setLines] = useState<string[] | null>(null); // highlighted HTML per line
  async function copy() { try { await navigator.clipboard.writeText(content ?? ""); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } }

  // Highlight each line independently (keeps line-number alignment) with the
  // detected language, falling back to escaped plain text.
  useEffect(() => {
    if (content == null) { setLines(null); return; }
    let cancelled = false;
    (async () => {
      const raw = content.split("\n");
      try {
        const hljs = (await import("highlight.js/lib/common")).default;
        let language = langOf(path);
        if (!language || !hljs.getLanguage(language)) {
          try { language = hljs.highlightAuto(content.slice(0, 20000)).language; } catch { language = undefined; }
        }
        const valid = language && hljs.getLanguage(language) ? language : null;
        const out = raw.map((line) => {
          if (!line) return "";
          try { return valid ? hljs.highlight(line, { language: valid, ignoreIllegals: true }).value : escapeHtml(line); }
          catch { return escapeHtml(line); }
        });
        if (!cancelled) setLines(out);
      } catch {
        if (!cancelled) setLines(raw.map(escapeHtml));
      }
    })();
    return () => { cancelled = true; };
  }, [content, path]);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <FileCode className="h-4 w-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={copy} title="Copier">{copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}</Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose} title="Fermer"><X className="h-4 w-4" /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[#0d1117]">
        {loading || (content != null && lines == null) ? (
          <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-white/50" /></div>
        ) : content == null ? (
          <div className="p-6 text-sm text-white/50">Fichier binaire ou introuvable — impossible d'afficher le contenu.</div>
        ) : (
          <table className="w-full border-collapse font-mono text-[12px] leading-relaxed">
            <tbody>
              {lines!.map((html, i) => (
                <tr key={i}>
                  <td className="select-none border-r border-white/10 px-3 text-right align-top text-white/30" style={{ width: "1%" }}>{i + 1}</td>
                  <td className="hljs whitespace-pre-wrap break-words bg-transparent px-3 text-zinc-200" dangerouslySetInnerHTML={{ __html: html || " " }} />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Stat({ icon: Icon, label, value, tone }: { icon: typeof Boxes; label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-border p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Icon className="h-3.5 w-3.5" /> {label}</div>
      <div className={cn("mt-0.5 text-lg font-semibold", tone)}>{value}</div>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h4>{children}</div>;
}

// GitHub-style contribution heatmap: one column per week, 7 rows (Sun→Sat).
function Heatmap({ weeks }: { weeks: { week: number; days: number[] }[] }) {
  const COLORS = ["bg-muted", "bg-emerald-500/30", "bg-emerald-500/55", "bg-emerald-500/80", "bg-emerald-500"];
  const level = (n: number) => (n === 0 ? 0 : n < 3 ? 1 : n < 6 ? 2 : n < 10 ? 3 : 4);
  return (
    <div className="overflow-x-auto pb-1">
      <div className="flex gap-[3px]">
        {weeks.map((w, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {(w.days ?? []).map((d, di) => {
              const date = new Date((w.week + di * 86400) * 1000);
              return <div key={di} title={`${d} commit${d > 1 ? "s" : ""} · ${date.toLocaleDateString("fr-FR")}`} className={cn("h-2.5 w-2.5 rounded-[2px]", COLORS[level(d)])} />;
            })}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
        <span>moins</span>
        {COLORS.map((c, i) => <span key={i} className={cn("h-2.5 w-2.5 rounded-[2px]", c)} />)}
        <span>plus</span>
      </div>
    </div>
  );
}
