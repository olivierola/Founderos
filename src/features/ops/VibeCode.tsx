import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Sparkles, Loader2, GitBranch, GitPullRequest, GitMerge, GitFork, FileCode, Send, ExternalLink,
  FilePenLine, Wand2, ArrowRight, Eye, Github, Package, Download, RefreshCw, Monitor,
  Mic, Compass, FlaskConical, Plug, ArrowUp, ChevronDown, Check,
  Copy, Pencil, RotateCcw, ThumbsUp, ThumbsDown, Brain, TerminalSquare,
  AlertTriangle, CheckCircle2, Trash2, SlidersHorizontal,
  FileText, Zap, Server, Workflow, Plus, Play, Power, FolderKanban,
} from "lucide-react";
import { MarkdownEditor } from "@/components/ui/markdown-editor";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Logo } from "@/components/Logo";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

interface Repo { id: string; full_name: string; default_branch: string | null; private: boolean }
interface Change { path: string; content: string }
interface VibeStep { t: string; label: string }
interface RunResult { message: string; base_branch: string; changes: Change[]; reads: string[]; steps?: VibeStep[]; finished?: boolean }

const SUBS = ["chat", "artifacts", "pr", "fork", "preview", "customize"] as const;
type SubId = (typeof SUBS)[number];

export function VibeCodePage() {
  const navigate = useNavigate();
  const { workspaceId, projectId, workspace, project } = useCurrentContext();
  const base = workspace && project ? `/app/${workspace.slug}/${project.slug}` : "";

  const { sub } = useParams();
  const active: SubId = (SUBS as readonly string[]).includes(sub ?? "") ? (sub as SubId) : "chat";
  const [repoId, setRepoId] = useState<string>("");
  const [branch, setBranch] = useState<string>("");
  const [result, setResult] = useState<RunResult | null>(null); // latest run — feeds the Artifacts tab

  const { data: repos, isLoading } = useQuery({
    queryKey: ["repositories", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("repositories").select("id, full_name, default_branch, private").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Repo[];
    },
  });

  const repo = useMemo(() => (repos ?? []).find((r) => r.id === repoId) ?? null, [repos, repoId]);
  useEffect(() => { if (!repoId && repos && repos.length) setRepoId(repos[0].id); }, [repos, repoId]);
  useEffect(() => { setBranch(repo?.default_branch ?? "main"); setResult(null); }, [repo?.id]);

  if (isLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  if ((repos ?? []).length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState icon={Github} title="Aucun dépôt connecté"
          description="Vibe Code travaille sur un dépôt GitHub connecté. Ajoutez et connectez un dépôt dans l'onglet Dépôts."
          action={<Button size="sm" onClick={() => navigate(`${base}/repos/list`)}>Aller aux Dépôts <ArrowRight className="ml-1.5 h-4 w-4" /></Button>} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* All tabs stay mounted (chat + run state persist across onglets). The
          repo/branch is chosen inside the chat composer (dropdown). */}
      <div className="relative min-h-0 flex-1">
        <div className={cn("absolute inset-0", active !== "chat" && "hidden")}>
          <VibeTab repoId={repoId} setRepoId={setRepoId} branch={branch} setBranch={setBranch} repos={repos ?? []} workspaceId={workspaceId} projectId={projectId} repo={repo} onResult={setResult} />
        </div>
        <div className={cn("absolute inset-0", active !== "artifacts" && "hidden")}><ArtifactsTab result={result} repo={repo} branch={branch} /></div>
        <div className={cn("absolute inset-0", active !== "pr" && "hidden")}><PrTab repoId={repoId} workspaceId={workspaceId} projectId={projectId} /></div>
        <div className={cn("absolute inset-0", active !== "fork" && "hidden")}><ForkTab repoId={repoId} repo={repo} workspaceId={workspaceId} projectId={projectId} /></div>
        <div className={cn("absolute inset-0", active !== "preview" && "hidden")}><PreviewTab repoId={repoId} workspaceId={workspaceId} projectId={projectId} /></div>
        <div className={cn("absolute inset-0", active !== "customize" && "hidden")}><CustomizeTab workspaceId={workspaceId} projectId={projectId} repos={repos ?? []} /></div>
      </div>
    </div>
  );
}

// ── Customize tab — mirrors the internal-agent "Personnaliser": a horizontal
// sub-tab bar over the coding agent's config surfaces (Instructions · Mémoire ·
// Connecteur). Same UX/logic as CUSTOMIZE_SECTIONS, adapted to the code agent.
interface VibeMemoryRow { id: string; content: string; session_id: string | null; created_at: string }

type VibeSection = "instructions" | "skills" | "memory" | "connectors" | "mcp" | "automation";
const VIBE_SECTIONS: { key: VibeSection; label: string; icon: typeof Wand2 }[] = [
  { key: "instructions", label: "Instructions", icon: FileText },
  { key: "skills", label: "Skills", icon: Zap },
  { key: "memory", label: "Memory", icon: Brain },
  { key: "connectors", label: "Connectors", icon: Plug },
  { key: "mcp", label: "MCP", icon: Server },
  { key: "automation", label: "Automation", icon: Workflow },
];

function CustomizeTab({ workspaceId, projectId, repos }: { workspaceId?: string | null; projectId?: string | null; repos: Repo[] }) {
  const [section, setSection] = useState<VibeSection>("instructions");
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Sub-tab bar — mirrors the internal-agent Personnaliser sections. */}
      <div className="scrollbar-hide flex h-14 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4">
        {VIBE_SECTIONS.map((s) => {
          const on = s.key === section;
          return (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-colors",
                on ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <s.icon className="h-4 w-4" /> {s.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {section === "instructions" && <VibeInstructions workspaceId={workspaceId} projectId={projectId} />}
        {section === "skills" && <VibeSkills workspaceId={workspaceId} projectId={projectId} />}
        {section === "memory" && <VibeMemory projectId={projectId} />}
        {section === "connectors" && <VibeConnector projectId={projectId} />}
        {section === "mcp" && <VibeMcp workspaceId={workspaceId} projectId={projectId} />}
        {section === "automation" && <VibeAutomations workspaceId={workspaceId} projectId={projectId} repos={repos} />}
      </div>
    </div>
  );
}

// Personnaliser → Instructions : rich markdown system prompt + default merge method.
function VibeInstructions({ workspaceId, projectId }: { workspaceId?: string | null; projectId?: string | null }) {
  const qc = useQueryClient();
  const [instructions, setInstructions] = useState("");
  const [mergeMethod, setMergeMethod] = useState<"squash" | "merge" | "rebase">("squash");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [preview, setPreview] = useState(false);

  const settingsQ = useQuery({
    queryKey: ["vibe_settings", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("vibe_settings").select("instructions, merge_method").eq("project_id", projectId!).maybeSingle();
      return (data ?? null) as { instructions: string; merge_method: "squash" | "merge" | "rebase" } | null;
    },
  });
  useEffect(() => {
    if (settingsQ.data) { setInstructions(settingsQ.data.instructions ?? ""); setMergeMethod(settingsQ.data.merge_method ?? "squash"); }
  }, [settingsQ.data]);

  async function save() {
    if (!workspaceId || !projectId) return;
    setSaving(true);
    try {
      await supabase.from("vibe_settings").upsert(
        { workspace_id: workspaceId, project_id: projectId, instructions, merge_method: mergeMethod, updated_at: new Date().toISOString() },
        { onConflict: "project_id" },
      );
      setSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ["vibe_settings", projectId] });
    } finally { setSaving(false); }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MarkdownEditor
        value={instructions}
        onChange={setInstructions}
        onSave={save}
        saving={saving}
        savedAt={savedAt}
        preview={preview}
        onTogglePreview={() => setPreview((p) => !p)}
        title="Instructions"
        description="Markdown décrivant comment l'agent de codage doit se comporter. Injecté comme prompt système à chaque run."
        placeholder={VIBE_INSTRUCTIONS_PLACEHOLDER}
        heightClass="h-[calc(100vh-19rem)]"
      />
      <div className="mt-3 flex shrink-0 flex-wrap items-center gap-3 border-t border-border/60 pt-3">
        <span className="text-xs font-medium text-foreground">Méthode de merge par défaut</span>
        <select
          value={mergeMethod}
          onChange={(e) => setMergeMethod(e.target.value as "squash" | "merge" | "rebase")}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value="squash">Squash</option>
          <option value="merge">Merge commit</option>
          <option value="rebase">Rebase</option>
        </select>
        <span className="text-[11px] text-muted-foreground">Utilisée par « Merger la PR ». Enregistrée avec les instructions.</span>
      </div>
    </div>
  );
}

const VIBE_INSTRUCTIONS_PLACEHOLDER = `# Rôle
Tu es un ingénieur senior sur ce dépôt.

## Conventions
- TypeScript strict, pas de \`any\`.
- Respecte le style et les patterns existants.
- Commits conventionnels (feat/fix/chore).

## Contraintes
- Ne touche jamais au dossier /legacy.
- Écris un test pour toute nouvelle fonction.`;

// Personnaliser → Mémoire : the facts the agent remembered (vibe_memory).
function VibeMemory({ projectId }: { projectId?: string | null }) {
  const qc = useQueryClient();
  const memQ = useQuery({
    queryKey: ["vibe_memory", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("vibe_memory").select("id, content, session_id, created_at").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as VibeMemoryRow[];
    },
  });
  async function deleteMemory(id: string) {
    await supabase.from("vibe_memory").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["vibe_memory", projectId] });
  }
  const globalMem = (memQ.data ?? []).filter((m) => !m.session_id);
  const sessionMem = (memQ.data ?? []).filter((m) => m.session_id);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium"><Brain className="h-4 w-4 text-primary" /> Mémoire de l'agent</div>
      <p className="text-xs text-muted-foreground">Ce que l'agent a retenu (préférences, décisions). Supprimez ce qui n'est plus pertinent.</p>
      <MemGroup title="Globale · tout le projet" items={globalMem} onDelete={deleteMemory} />
      <MemGroup title="Par session" items={sessionMem} onDelete={deleteMemory} />
      {!memQ.isLoading && (memQ.data ?? []).length === 0 && (
        <p className="text-xs text-muted-foreground">Aucun souvenir pour l'instant — l'agent en crée avec l'outil « remember » au fil des sessions.</p>
      )}
    </div>
  );
}

// Personnaliser → Connecteur : the coding agent's GitHub connection.
function VibeConnector({ projectId }: { projectId?: string | null }) {
  const navigate = useNavigate();
  const { workspaceSlug = "", projectSlug = "" } = useParams();
  const q = useQuery({
    queryKey: ["vibe_connector", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const [conn, repos] = await Promise.all([
        supabase.from("connectors").select("metadata").eq("project_id", projectId!).eq("provider", "github").maybeSingle(),
        supabase.from("repositories").select("id", { count: "exact", head: true }).eq("project_id", projectId!),
      ]);
      return {
        connected: !!conn.data,
        login: (conn.data?.metadata as { github_login?: string } | null)?.github_login ?? null,
        repoCount: repos.count ?? 0,
      };
    },
  });
  const d = q.data;
  const toRepos = () => navigate(`/app/${workspaceSlug}/${projectSlug}/repos/list`);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium"><Github className="h-4 w-4 text-primary" /> Connecteur GitHub</div>
      <p className="text-xs text-muted-foreground">L'agent de codage lit et écrit sur vos dépôts GitHub connectés.</p>
      <div className="rounded-xl border border-border bg-card/40 p-4 text-sm">
        {!d ? (
          <span className="text-xs text-muted-foreground">Chargement…</span>
        ) : d.connected ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Connecté{d.login ? <> en tant que <span className="font-medium">@{d.login}</span></> : ""}</span>
            <span className="text-xs text-muted-foreground">· {d.repoCount} dépôt{d.repoCount > 1 ? "s" : ""} suivi{d.repoCount > 1 ? "s" : ""}</span>
            <Button size="sm" variant="outline" className="ml-auto" onClick={toRepos}>Gérer dans Dépôts <ArrowRight className="ml-1 h-3.5 w-3.5" /></Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-amber-500"><AlertTriangle className="h-4 w-4" /> Aucun dépôt GitHub connecté.</span>
            <Button size="sm" className="ml-auto" onClick={toRepos}>Connecter <ArrowRight className="ml-1 h-3.5 w-3.5" /></Button>
          </div>
        )}
      </div>
    </div>
  );
}

// Personnaliser → Skills : reusable markdown task templates for the coding agent.
interface VibeSkill { id: string; name: string; description: string; body: string; created_at: string }

function VibeSkills({ workspaceId, projectId }: { workspaceId?: string | null; projectId?: string | null }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<VibeSkill | null>(null);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);

  const q = useQuery({
    queryKey: ["vibe_skills", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("vibe_skills").select("id, name, description, body, created_at").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as VibeSkill[];
    },
  });

  async function createSkill() {
    if (!workspaceId || !projectId) return;
    const { data } = await supabase.from("vibe_skills")
      .insert({ workspace_id: workspaceId, project_id: projectId, name: "Nouvelle skill", description: "", body: "" })
      .select("id, name, description, body, created_at").single();
    qc.invalidateQueries({ queryKey: ["vibe_skills", projectId] });
    if (data) setEditing(data as VibeSkill);
  }
  async function saveSkill() {
    if (!editing) return;
    setSaving(true);
    try {
      await supabase.from("vibe_skills")
        .update({ name: editing.name, description: editing.description, body: editing.body, updated_at: new Date().toISOString() })
        .eq("id", editing.id);
      qc.invalidateQueries({ queryKey: ["vibe_skills", projectId] });
    } finally { setSaving(false); }
  }
  async function removeSkill(id: string) {
    await supabase.from("vibe_skills").delete().eq("id", id);
    if (editing?.id === id) setEditing(null);
    qc.invalidateQueries({ queryKey: ["vibe_skills", projectId] });
  }

  if (editing) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}><ArrowRight className="mr-1 h-3.5 w-3.5 rotate-180" /> Skills</Button>
          <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="h-8 w-56" placeholder="Nom de la skill" />
          <Input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} className="h-8 min-w-0 flex-1" placeholder="Quand l'utiliser (description courte)" />
        </div>
        <MarkdownEditor
          value={editing.body}
          onChange={(v) => setEditing({ ...editing, body: v })}
          onSave={saveSkill}
          saving={saving}
          preview={preview}
          onTogglePreview={() => setPreview((p) => !p)}
          placeholder={"# Objectif\nDécris la tâche réutilisable.\n\n## Étapes\n1. …\n2. …"}
          heightClass="h-[calc(100vh-22rem)]"
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Skills</h2>
          <p className="text-xs text-muted-foreground">Modèles de tâches réutilisables (markdown) — ex. « Ajouter des tests », « Corriger le lint ».</p>
        </div>
        <Button size="sm" onClick={createSkill}><Plus className="mr-1.5 h-3.5 w-3.5" /> Nouvelle skill</Button>
      </div>
      {(q.data ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">Aucune skill pour l'instant.</p>
      ) : (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border">
          {(q.data ?? []).map((s) => (
            <li key={s.id} className="group flex items-center gap-3 px-3 py-2.5">
              <Zap className="h-4 w-4 shrink-0 text-primary" />
              <button onClick={() => setEditing(s)} className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm font-medium">{s.name}</div>
                {s.description && <div className="truncate text-[11px] text-muted-foreground">{s.description}</div>}
              </button>
              <button onClick={() => removeSkill(s.id)} title="Supprimer" className="shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-red-500">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Personnaliser → MCP : workspace MCP servers activated for the coding agent.
function VibeMcp({ workspaceId, projectId }: { workspaceId?: string | null; projectId?: string | null }) {
  const qc = useQueryClient();
  const serversQ = useQuery({
    queryKey: ["mcp_servers_for_vibe", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase.from("mcp_servers")
        .select("id, name, description, transport, enabled, cached_tools").eq("workspace_id", workspaceId!).order("name");
      return (data ?? []) as Array<{ id: string; name: string; description: string | null; transport: string; enabled: boolean; cached_tools: { name: string }[] | null }>;
    },
  });
  const attachedQ = useQuery({
    queryKey: ["vibe_mcp_servers", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("vibe_mcp_servers").select("server_id").eq("project_id", projectId!);
      return new Set((data ?? []).map((r) => (r as { server_id: string }).server_id));
    },
  });
  const attached = attachedQ.data ?? new Set<string>();

  async function toggle(serverId: string) {
    if (!workspaceId || !projectId) return;
    if (attached.has(serverId)) await supabase.from("vibe_mcp_servers").delete().eq("project_id", projectId).eq("server_id", serverId);
    else await supabase.from("vibe_mcp_servers").insert({ workspace_id: workspaceId, project_id: projectId, server_id: serverId });
    qc.invalidateQueries({ queryKey: ["vibe_mcp_servers", projectId] });
  }

  const servers = serversQ.data ?? [];
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">MCP</h2>
        <p className="text-xs text-muted-foreground">Serveurs MCP du workspace activés pour l'agent de codage — leurs outils deviennent appelables pendant un run.</p>
      </div>
      {servers.length === 0 ? (
        <p className="text-xs text-muted-foreground">Aucun serveur MCP dans ce workspace. Ajoutez-en un depuis la page MCP Servers.</p>
      ) : (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border">
          {servers.map((s) => {
            const on = attached.has(s.id);
            return (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                <Server className="h-4 w-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{s.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {(s.cached_tools ?? []).length} outil{(s.cached_tools ?? []).length > 1 ? "s" : ""} · {s.transport}{s.description ? ` · ${s.description}` : ""}
                  </div>
                </div>
                {!s.enabled && <Badge variant="outline" className="shrink-0 text-[10px] text-amber-500">désactivé</Badge>}
                <Button size="sm" variant={on ? "default" : "outline"} onClick={() => toggle(s.id)} disabled={!s.enabled}>
                  {on ? <><Check className="mr-1 h-3.5 w-3.5" /> Activé</> : "Activer"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Personnaliser → Automation : recurring coding tasks (prompt + repo + schedule).
interface VibeAutomation {
  id: string; name: string; prompt: string; repository_id: string | null; branch: string | null;
  schedule: "manual" | "hourly" | "daily" | "weekly"; enabled: boolean; last_run_at: string | null;
}
const SCHEDULE_LABEL: Record<VibeAutomation["schedule"], string> = {
  manual: "Manuel", hourly: "Toutes les heures", daily: "Quotidien", weekly: "Hebdomadaire",
};

function VibeAutomations({ workspaceId, projectId, repos }: { workspaceId?: string | null; projectId?: string | null; repos: Repo[] }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [repoId, setRepoId] = useState("");
  const [schedule, setSchedule] = useState<VibeAutomation["schedule"]>("daily");
  const [runningId, setRunningId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["vibe_automations", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("vibe_automations")
        .select("id, name, prompt, repository_id, branch, schedule, enabled, last_run_at")
        .eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as VibeAutomation[];
    },
  });

  async function create() {
    if (!workspaceId || !projectId || !name.trim() || !prompt.trim()) return;
    await supabase.from("vibe_automations").insert({
      workspace_id: workspaceId, project_id: projectId, name: name.trim(), prompt: prompt.trim(),
      repository_id: repoId || repos[0]?.id || null, schedule, enabled: true,
    });
    setCreating(false); setName(""); setPrompt(""); setRepoId(""); setSchedule("daily");
    qc.invalidateQueries({ queryKey: ["vibe_automations", projectId] });
  }
  async function toggleEnabled(a: VibeAutomation) {
    await supabase.from("vibe_automations").update({ enabled: !a.enabled }).eq("id", a.id);
    qc.invalidateQueries({ queryKey: ["vibe_automations", projectId] });
  }
  async function remove(id: string) {
    await supabase.from("vibe_automations").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["vibe_automations", projectId] });
  }
  async function runNow(a: VibeAutomation) {
    if (!workspaceId || !projectId) return;
    const rid = a.repository_id ?? repos[0]?.id;
    if (!rid) { setNotice("Aucun dépôt connecté pour lancer cette automatisation."); return; }
    setRunningId(a.id); setNotice(null);
    try {
      await callEdge("vibe-code", {
        workspace_id: workspaceId, project_id: projectId, repository_id: rid,
        action: "run", prompt: a.prompt, branch: a.branch || undefined,
      });
      await supabase.from("vibe_automations").update({ last_run_at: new Date().toISOString() }).eq("id", a.id);
      qc.invalidateQueries({ queryKey: ["vibe_automations", projectId] });
      setNotice(`« ${a.name} » lancée — suivez-la dans l'onglet Vibe Code.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally { setRunningId(null); }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Automation</h2>
          <p className="text-xs text-muted-foreground">Tâches de code récurrentes — un prompt, un dépôt, une fréquence.</p>
        </div>
        <Button size="sm" onClick={() => setCreating((c) => !c)}><Plus className="mr-1.5 h-3.5 w-3.5" /> Nouvelle automatisation</Button>
      </div>

      {notice && <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">{notice}</div>}

      {creating && (
        <div className="space-y-2 rounded-xl border border-border bg-card/40 p-3">
          <div className="flex flex-wrap gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom (ex. Corriger le lint)" className="h-8 w-56" />
            <select value={repoId || repos[0]?.id || ""} onChange={(e) => setRepoId(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs">
              {repos.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
            </select>
            <select value={schedule} onChange={(e) => setSchedule(e.target.value as VibeAutomation["schedule"])} className="h-8 rounded-md border border-border bg-background px-2 text-xs">
              {(Object.keys(SCHEDULE_LABEL) as VibeAutomation["schedule"][]).map((s) => <option key={s} value={s}>{SCHEDULE_LABEL[s]}</option>)}
            </select>
          </div>
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="Tâche à exécuter (ex. : corrige toutes les erreurs ESLint et ouvre une PR)" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>Annuler</Button>
            <Button size="sm" onClick={create} disabled={!name.trim() || !prompt.trim()}>Créer</Button>
          </div>
        </div>
      )}

      {(q.data ?? []).length === 0 && !creating ? (
        <p className="text-xs text-muted-foreground">Aucune automatisation.</p>
      ) : (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border">
          {(q.data ?? []).map((a) => (
            <li key={a.id} className="group flex items-center gap-3 px-3 py-2.5">
              <Workflow className={cn("h-4 w-4 shrink-0", a.enabled ? "text-primary" : "text-muted-foreground")} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{a.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {SCHEDULE_LABEL[a.schedule]} · {repos.find((r) => r.id === a.repository_id)?.full_name ?? "dépôt par défaut"}
                  {a.last_run_at ? ` · dernier run ${new Date(a.last_run_at).toLocaleDateString("fr-FR")}` : ""}
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => runNow(a)} disabled={runningId !== null}>
                {runningId === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              </Button>
              <button onClick={() => toggleEnabled(a)} title={a.enabled ? "Désactiver" : "Activer"}
                className={cn("shrink-0 transition-colors", a.enabled ? "text-emerald-500" : "text-muted-foreground hover:text-foreground")}>
                <Power className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => remove(a.id)} title="Supprimer" className="shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-red-500">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground">
        « ▶ » lance l'automatisation immédiatement. L'exécution planifiée (horaire/quotidienne/hebdo) nécessite le cron du scheduler — non branché pour l'instant.
      </p>
    </div>
  );
}

function MemGroup({ title, items, onDelete }: { title: string; items: VibeMemoryRow[]; onDelete: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title} · {items.length}</div>
      <ul className="space-y-1">
        {items.map((m) => (
          <li key={m.id} className="group flex items-start gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5 text-xs">
            <Brain className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 break-words">{m.content}</span>
            <button onClick={() => onDelete(m.id)} title="Oublier" className="shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-red-500">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Vibe tab — a chat space with the coding agent ────────────────────────────
interface ChatMsg { id: string; role: "user" | "assistant"; content: string; prompt?: string; result?: RunResult; pr?: { html_url: string; number: number; branch?: string; head_repo?: string }; error?: string; applyError?: string; loading?: boolean; applying?: boolean; createdAt?: string; repo?: string; branch?: string; dbId?: string; steps?: VibeStep[] }

interface PrDetail {
  number: number; title: string; state: string; draft: boolean; merged: boolean;
  mergeable: boolean | null; mergeable_state: string;
  additions: number; deletions: number; changed_files: number; commits: number;
  html_url: string; head: { ref: string }; base: { ref: string };
}
// PR head CI state + PR detail (from the vibe-code "pr_status" action).
interface CiState {
  state: "pending" | "success" | "failure" | "none";
  head_sha?: string;
  checks: { name: string; status: string; conclusion: string | null; url: string | null }[];
  failures: { check: string; path?: string; line?: number; level?: string; message: string }[];
  pr?: PrDetail | null;
}

const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "");

const SUGGESTIONS = [
  { icon: FlaskConical, label: "Ajoute des tests pour le module principal" },
  { icon: Compass, label: "Explique l'architecture du dépôt et propose des améliorations" },
  { icon: Plug, label: "Corrige les erreurs de lint / TypeScript" },
];

function VibeTab({ repoId, setRepoId, branch, setBranch, repos, workspaceId, projectId, repo, onResult }: {
  repoId: string; setRepoId: (id: string) => void; branch: string; setBranch: (b: string) => void; repos: Repo[];
  workspaceId: string | null; projectId: string | null; repo: Repo | null; onResult: (r: RunResult) => void;
}) {
  const { user } = useAuth();
  const name = ((user?.user_metadata?.name as string | undefined) ?? user?.email?.split("@")[0] ?? "").split(" ")[0];
  const [params, setParams] = useSearchParams();
  const sessionId = params.get("session");
  // A Vibe project binds every session to ONE repo — that repo is the context.
  const vibeProjectId = params.get("project");
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [viewChange, setViewChange] = useState<Change | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const loadedRef = useRef<string | null>(null);

  const { data: vibeProject } = useQuery({
    queryKey: ["vibe_project", vibeProjectId],
    enabled: !!vibeProjectId,
    queryFn: async () => {
      const { data } = await supabase.from("vibe_projects").select("id, name, repository_id, branch").eq("id", vibeProjectId!).maybeSingle();
      return data as { id: string; name: string; repository_id: string; branch: string | null } | null;
    },
  });
  // Lock the working repo (and default branch) to the project's.
  useEffect(() => {
    if (!vibeProject) return;
    if (vibeProject.repository_id && vibeProject.repository_id !== repoId) setRepoId(vibeProject.repository_id);
    if (vibeProject.branch) setBranch(vibeProject.branch);
  }, [vibeProject?.id, vibeProject?.repository_id]);

  /** Keep ?project when we rewrite the query string (adopting a session id). */
  const setSessionParam = (sid: string) => {
    const next: Record<string, string> = { session: sid };
    if (vibeProjectId) next.project = vibeProjectId;
    setParams(next, { replace: true });
  };

  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [messages]);

  // Load a session's messages when it changes via the sidebar (skip our own set).
  useEffect(() => {
    if (sessionId === loadedRef.current) return;
    loadedRef.current = sessionId;
    if (!sessionId) { setMessages([]); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("vibe_messages").select("id, role, content, meta, created_at").eq("session_id", sessionId).order("created_at", { ascending: true });
      if (cancelled) return;
      setMessages((data ?? []).map((m) => {
        const row = m as { id: string; role: "user" | "assistant"; content: string; created_at: string; meta: { status?: string; result?: RunResult; pr?: { html_url: string; number: number }; repo?: string; branch?: string; error?: string; steps?: VibeStep[] } };
        return {
          id: crypto.randomUUID(), dbId: row.id, role: row.role, content: row.content, createdAt: row.created_at,
          result: row.meta?.result, pr: row.meta?.pr, repo: row.meta?.repo, branch: row.meta?.branch, steps: row.meta?.steps ?? row.meta?.result?.steps,
          loading: row.role === "assistant" && row.meta?.status === "running",
          error: row.meta?.status === "failed" ? (row.meta?.error || "Échec") : undefined,
          prompt: row.role === "user" ? row.content : undefined,
        };
      }));
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || running || !repoId || !workspaceId || !projectId) return;
    const now = new Date().toISOString();
    const ctxRepo = repo?.full_name;
    const aId = crypto.randomUUID();
    setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", content: t, createdAt: now, repo: ctxRepo, branch }, { id: aId, role: "assistant", content: "", loading: true, prompt: t }]);
    setInput(""); setRunning(true);
    try {
      // The function persists the turns and runs the agent in the background;
      // poll the assistant row until it's done (avoids the request 504).
      const res = await callEdge<{ assistant_message_id: string | null; session_id: string | null; async: boolean; message?: string; base_branch?: string; changes?: Change[]; reads?: string[] }>(
        "vibe-code", { workspace_id: workspaceId, project_id: projectId, repository_id: repoId, action: "run", prompt: t, branch: branch || undefined, session_id: sessionId ?? undefined, vibe_project_id: vibeProjectId ?? undefined },
      );
      // Adopt the server-created session → a refresh restores this conversation.
      if (res.session_id && res.session_id !== sessionId) {
        loadedRef.current = res.session_id;
        setSessionParam(res.session_id);
      }
      qc.invalidateQueries({ queryKey: ["vibe_sessions", projectId] });

      const amid = res.assistant_message_id;
      if (res.async && amid) {
        const deadline = Date.now() + 4 * 60 * 1000;
        let settled = false;
        while (Date.now() < deadline && !settled) {
          await new Promise((r) => setTimeout(r, 2000));
          const { data } = await supabase.from("vibe_messages").select("content, meta").eq("id", amid).maybeSingle();
          const meta = (data as { content: string; meta: { status?: string; result?: RunResult; error?: string; steps?: VibeStep[] } } | null)?.meta;
          if (meta?.steps) setMessages((m) => m.map((x) => (x.id === aId ? { ...x, steps: meta.steps } : x)));
          if (meta?.status === "done" && meta.result) {
            onResult(meta.result);
            setMessages((m) => m.map((x) => (x.id === aId ? { ...x, content: meta.result!.message, result: meta.result, loading: false, createdAt: new Date().toISOString(), dbId: amid } : x)));
            settled = true;
          } else if (meta?.status === "failed") {
            setMessages((m) => m.map((x) => (x.id === aId ? { ...x, error: meta.error || "Échec", loading: false, createdAt: new Date().toISOString() } : x)));
            settled = true;
          }
        }
        if (!settled) setMessages((m) => m.map((x) => (x.id === aId ? { ...x, error: "Délai dépassé — la tâche est peut-être trop lourde. Réessayez avec une demande plus ciblée.", loading: false } : x)));
      } else if (res.message !== undefined) {
        const result: RunResult = { message: res.message, base_branch: res.base_branch ?? branch, changes: res.changes ?? [], reads: res.reads ?? [] };
        onResult(result);
        setMessages((m) => m.map((x) => (x.id === aId ? { ...x, content: result.message, result, loading: false, createdAt: new Date().toISOString(), dbId: amid ?? undefined } : x)));
      }
    } catch (e) {
      setMessages((m) => m.map((x) => (x.id === aId ? { ...x, error: e instanceof Error ? e.message : String(e), loading: false, createdAt: new Date().toISOString() } : x)));
    } finally { setRunning(false); }
  }

  async function createPr(msgId: string, res: RunResult, prompt: string, dbId?: string) {
    setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, applying: true } : x)));
    try {
      const out = await callEdge<{ pull_request?: { html_url: string; number: number }; branch?: string; head_repo?: string }>("vibe-code", {
        workspace_id: workspaceId, project_id: projectId, repository_id: repoId, action: "apply",
        base_branch: res.base_branch, title: prompt.slice(0, 72), body: res.message, changes: res.changes,
        message_id: dbId,
      });
      // Keep the PR head branch + repo (fork for fork-based PRs) to poll CI + push fixes.
      const pr = out.pull_request ? { ...out.pull_request, branch: out.branch, head_repo: out.head_repo } : undefined;
      setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, applying: false, pr, applyError: undefined } : x)));
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, applying: false, applyError: detail } : x)));
    }
  }

  // Poll a background assistant message row until it settles (shared by run/fix).
  async function pollAssistant(aId: string, amid: string) {
    const deadline = Date.now() + 4 * 60 * 1000;
    let settled = false;
    while (Date.now() < deadline && !settled) {
      await new Promise((r) => setTimeout(r, 2000));
      const { data } = await supabase.from("vibe_messages").select("content, meta").eq("id", amid).maybeSingle();
      const meta = (data as { content: string; meta: { status?: string; result?: RunResult; error?: string; steps?: VibeStep[] } } | null)?.meta;
      if (meta?.steps) setMessages((m) => m.map((x) => (x.id === aId ? { ...x, steps: meta.steps } : x)));
      if (meta?.status === "done" && meta.result) {
        onResult(meta.result);
        setMessages((m) => m.map((x) => (x.id === aId ? { ...x, content: meta.result!.message, result: meta.result, loading: false, createdAt: new Date().toISOString(), dbId: amid } : x)));
        settled = true;
      } else if (meta?.status === "failed") {
        setMessages((m) => m.map((x) => (x.id === aId ? { ...x, error: meta.error || "Échec", loading: false, createdAt: new Date().toISOString() } : x)));
        settled = true;
      }
    }
    if (!settled) setMessages((m) => m.map((x) => (x.id === aId ? { ...x, error: "Délai dépassé.", loading: false } : x)));
  }

  // Send the PR's CI errors back to the agent; the fix is committed to the PR branch.
  async function fixPr(pr: { number: number; branch?: string; head_repo?: string }) {
    if (!pr.branch || running) return;
    const aId = crypto.randomUUID();
    setMessages((m) => [...m, { id: aId, role: "assistant", content: "", loading: true, prompt: `Corriger les erreurs de CI (PR #${pr.number})` }]);
    setRunning(true);
    try {
      const res = await callEdge<{ assistant_message_id: string | null; session_id: string | null; async: boolean; error?: string; state?: string }>(
        "vibe-code", { workspace_id: workspaceId, project_id: projectId, repository_id: repoId, action: "fix_pr", branch: pr.branch, head_repo: pr.head_repo, pr_number: pr.number, session_id: sessionId ?? undefined },
      );
      if (res.error === "no_failures") {
        setMessages((m) => m.map((x) => (x.id === aId ? { ...x, content: "Aucune erreur de CI à corriger.", loading: false, createdAt: new Date().toISOString() } : x)));
        return;
      }
      if (res.session_id && res.session_id !== sessionId) { loadedRef.current = res.session_id; setSessionParam(res.session_id); }
      qc.invalidateQueries({ queryKey: ["vibe_sessions", projectId] });
      const amid = res.assistant_message_id;
      if (amid) await pollAssistant(aId, amid);
      // The fix was pushed to the PR branch → its CI panel re-polls automatically.
      qc.invalidateQueries({ queryKey: ["vibe_ci", repoId, pr.head_repo, pr.branch, pr.number] });
    } catch (e) {
      setMessages((m) => m.map((x) => (x.id === aId ? { ...x, error: e instanceof Error ? e.message : String(e), loading: false, createdAt: new Date().toISOString() } : x)));
    } finally { setRunning(false); }
  }

  const composer = (
    <div className="rounded-2xl border border-border bg-card/60 p-2 shadow-sm backdrop-blur">
      {/* Context row — the repo to work on. Inside a Vibe project the repo is
          fixed by the project, so it's shown locked instead of pickable. */}
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1">
        {vibeProject ? (
          <span
            title={`Projet « ${vibeProject.name} » — dépôt fixé par le projet`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/5 px-2 py-1 text-xs"
          >
            <FolderKanban className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="max-w-[110px] truncate font-medium">{vibeProject.name}</span>
            <span className="text-muted-foreground">·</span>
            <Github className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-[180px] truncate">{repo?.full_name ?? "…"}</span>
          </span>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs transition-colors hover:bg-muted/60">
                <Github className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-[220px] truncate">{repo?.full_name ?? "Choisir un dépôt"}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
              {repos.map((r) => (
                <DropdownMenuItem key={r.id} onClick={() => setRepoId(r.id)} className="gap-2">
                  <Github className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{r.full_name}</span>
                  {r.id === repoId && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground">
          <GitBranch className="h-3.5 w-3.5" />
          <input value={branch} onChange={(e) => setBranch(e.target.value)} className="w-16 bg-transparent outline-none" />
        </span>
      </div>
      {/* Input row */}
      <div className="flex items-end gap-2">
        <Textarea
          value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
          placeholder={`Demandez à Vibe Code de coder sur ${repo?.full_name ?? "votre dépôt"}…`}
          rows={1}
          className="max-h-40 min-h-[36px] resize-none border-0 bg-transparent px-1 py-2 text-sm shadow-none focus-visible:ring-0"
        />
        <button title="Dictée (bientôt)" className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-muted/60"><Mic className="h-4 w-4" /></button>
        <button onClick={() => send(input)} disabled={!input.trim() || running} className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:opacity-40">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );

  return (
    <div className="font-poppins flex h-full min-h-0 flex-col">
      {messages.length === 0 ? (
        // ── Hero (empty state) ──
        <div className="flex flex-1 flex-col items-center justify-center px-6">
          <div className="w-full max-w-2xl">
            <Logo size={44} className="mb-5" />
            <h1 className="mb-6 text-3xl font-semibold tracking-tight">Bon retour{name ? `, ${name}` : ""}</h1>
            <div className="mb-2 flex items-center justify-between rounded-xl border border-border bg-card/60 px-3 py-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-2"><Wand2 className="h-4 w-4 text-primary" /> Vibe Code lit et modifie le code de {repo?.full_name ?? "votre dépôt"}, puis ouvre une pull request.</span>
            </div>
            {composer}
            <div className="mt-6 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Suggestions pour vous</span>
            </div>
            <div className="mt-2 space-y-1">
              {SUGGESTIONS.map((s) => (
                <button key={s.label} onClick={() => send(s.label)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm transition-colors hover:bg-muted/50">
                  <s.icon className="h-4 w-4 text-muted-foreground" /> {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        // ── Conversation — messages scroll, composer floats below ──
        <div className="relative min-h-0 flex-1">
          <div ref={scroller} className="absolute inset-0 overflow-y-auto">
            <div className="mx-auto max-w-2xl space-y-5 px-4 pb-40 pt-6">
              {messages.map((m) => (
                <div key={m.id} className="group">
                  {m.role === "user" ? (
                    <div className="flex flex-col items-end">
                      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-foreground/10 px-4 py-2.5 text-sm">{m.content}</div>
                      <UserActions msg={m} onEdit={setInput} onResend={send} />
                    </div>
                  ) : (
                    <div className="flex flex-col items-start">
                      <AssistantMsg msg={m} onView={setViewChange} onCreatePr={(res) => createPr(m.id, res, m.prompt ?? "Vibe Code", m.dbId)} ctx={{ workspaceId, projectId, repoId }} onFixPr={fixPr} busy={running} />
                      {!m.loading && !m.error && <AssistantActions msg={m} />}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background/92 to-transparent pb-4 pt-14">
            <div className="pointer-events-auto mx-auto max-w-2xl px-4">{composer}</div>
          </div>
        </div>
      )}

      <Dialog open={!!viewChange} onOpenChange={(o) => !o && setViewChange(null)}>
        <DialogContent className="flex h-[82vh] max-w-4xl flex-col overflow-hidden p-0">
          <div className="min-h-0 flex-1"><CodePreview change={viewChange} repoId={repoId} branch={branch} /></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const actionBtn = "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground";

// Hover row under a USER message: time · repo/branch context · resend · edit · copy.
function UserActions({ msg, onEdit, onResend }: { msg: ChatMsg; onEdit: (c: string) => void; onResend: (c: string) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(msg.content); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  return (
    <div className="mr-1 mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      {msg.createdAt && <span className="text-[11px] tabular-nums text-muted-foreground/70">{fmtTime(msg.createdAt)}</span>}
      {msg.repo && (
        <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground" title="Contexte d'envoi">
          <Github className="h-3 w-3" /> <span className="max-w-[160px] truncate">{msg.repo}</span>
          {msg.branch && <><GitBranch className="ml-0.5 h-3 w-3" />{msg.branch}</>}
        </span>
      )}
      <button onClick={() => onResend(msg.content)} className={actionBtn} title="Renvoyer"><RotateCcw className="h-3.5 w-3.5" /></button>
      <button onClick={() => onEdit(msg.content)} className={actionBtn} title="Modifier"><Pencil className="h-3.5 w-3.5" /></button>
      <button onClick={copy} className={actionBtn} title={copied ? "Copié" : "Copier"}>{copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}</button>
    </div>
  );
}

// Hover row under an ASSISTANT reply: time · copy · feedback.
function AssistantActions({ msg }: { msg: ChatMsg }) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const copy = async () => { try { await navigator.clipboard.writeText(msg.content); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  return (
    <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      {msg.createdAt && <span className="text-[11px] tabular-nums text-muted-foreground/70">{fmtTime(msg.createdAt)}</span>}
      <button onClick={copy} className={actionBtn} title={copied ? "Copié" : "Copier"}>{copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}</button>
      <button onClick={() => setVote(vote === "up" ? null : "up")} className={cn(actionBtn, vote === "up" && "text-emerald-500")} title="Bonne réponse"><ThumbsUp className="h-3.5 w-3.5" /></button>
      <button onClick={() => setVote(vote === "down" ? null : "down")} className={cn(actionBtn, vote === "down" && "text-rose-500")} title="À améliorer"><ThumbsDown className="h-3.5 w-3.5" /></button>
    </div>
  );
}

// Live "what the agent is doing" timeline (Claude-Code style).
const STEP_META: Record<string, { icon: typeof Eye; label: string }> = {
  read: { icon: Eye, label: "Lecture" },
  write: { icon: FilePenLine, label: "Écriture" },
  memory: { icon: Brain, label: "Mémoire" },
};
function StepsTimeline({ steps, live }: { steps: VibeStep[]; live: boolean }) {
  return (
    <div className="space-y-1 rounded-xl border border-border/60 bg-muted/20 p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <TerminalSquare className="h-3.5 w-3.5" /> {live ? "L'agent travaille" : "Actions"}
        {live && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>
      {steps.map((s, i) => {
        const m = STEP_META[s.t] ?? { icon: FileCode, label: s.t };
        return (
          <div key={i} className="flex items-center gap-2 text-xs">
            <m.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-muted-foreground">{m.label}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-foreground/80">{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function AssistantMsg({ msg, onView, onCreatePr, ctx, onFixPr, busy }: {
  msg: ChatMsg; onView: (c: Change) => void; onCreatePr: (res: RunResult) => void;
  ctx: { workspaceId?: string | null; projectId?: string | null; repoId?: string | null };
  onFixPr: (pr: { number: number; branch?: string; head_repo?: string }) => void; busy: boolean;
}) {
  if (msg.error) return <div className="w-full rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">{msg.error}</div>;
  const res = msg.result;
  const steps = msg.steps ?? res?.steps ?? [];
  return (
    <div className="w-full space-y-3">
      {steps.length > 0 && <StepsTimeline steps={steps} live={!!msg.loading} />}
      {msg.loading && steps.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> L'agent démarre…</div>
      )}
      {msg.content && (
        <div className="chat-prose max-w-none break-words text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown></div>
      )}
      {res && res.reads.length > 0 && <div className="text-[11px] text-muted-foreground"><span className="font-medium">Fichiers lus :</span> {res.reads.slice(0, 10).join(", ")}{res.reads.length > 10 ? "…" : ""}</div>}
      {res && res.changes.length > 0 && (
        <div className="rounded-xl border border-border bg-card/50 p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Modifications proposées ({res.changes.length})</div>
          <ul className="space-y-1">
            {res.changes.map((c) => (
              <li key={c.path}>
                <button onClick={() => onView(c)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50">
                  <FilePenLine className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{c.path}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{c.content.split("\n").length} l.</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 border-t border-border/60 pt-2">
            {msg.pr ? (
              <PrCiPanel pr={msg.pr} ctx={ctx} onFix={() => onFixPr(msg.pr!)} busy={busy} />
            ) : (
              <div className="space-y-1.5">
                <Button size="sm" onClick={() => onCreatePr(res)} disabled={msg.applying}>
                  {msg.applying ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Création…</> : <><GitPullRequest className="mr-1.5 h-3.5 w-3.5" /> Créer la pull request</>}
                </Button>
                {msg.applyError && (
                  <div className="flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-500">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{msg.applyError}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {res && res.changes.length === 0 && msg.content && <div className="text-xs text-muted-foreground">Aucune modification de fichier proposée.</div>}
    </div>
  );
}

// Rich PR card under a message: PR meta + live CI + Fix (on failure) + Merge.
function PrCiPanel({ pr, ctx, onFix, busy }: {
  pr: { number: number; branch?: string; html_url: string; head_repo?: string };
  ctx: { workspaceId?: string | null; projectId?: string | null; repoId?: string | null };
  onFix: () => void; busy: boolean;
}) {
  const qc = useQueryClient();
  const [merging, setMerging] = useState(false);
  const [mergedLocal, setMergedLocal] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const key = ["vibe_ci", ctx.repoId, pr.head_repo, pr.branch, pr.number];
  const { data, isLoading } = useQuery<CiState>({
    queryKey: key,
    enabled: !!ctx.repoId,
    refetchInterval: (q) => (q.state.data?.state === "pending" ? 12000 : q.state.data?.state === "failure" ? 30000 : false),
    queryFn: () => callEdge<CiState>("vibe-code", {
      workspace_id: ctx.workspaceId, project_id: ctx.projectId, repository_id: ctx.repoId,
      action: "pr_status", branch: pr.branch, head_repo: pr.head_repo, pr_number: pr.number,
    }),
  });

  const d = data?.pr;
  const state = data?.state;
  const merged = mergedLocal || !!d?.merged;
  const closed = d?.state === "closed";

  async function merge() {
    setMerging(true); setMergeError(null);
    try {
      const res = await callEdge<{ ok?: boolean; merged?: boolean; error?: string; detail?: string }>("vibe-code", {
        workspace_id: ctx.workspaceId, project_id: ctx.projectId, repository_id: ctx.repoId,
        action: "merge_pr", pr_number: pr.number,
      });
      if (res.error) setMergeError(res.error);
      else if (res.merged) { setMergedLocal(true); qc.invalidateQueries({ queryKey: key }); }
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : String(e));
    } finally { setMerging(false); }
  }

  const stateBadge = merged
    ? <Badge className="border-transparent bg-violet-500/15 text-[10px] text-violet-500">merged</Badge>
    : closed ? <Badge variant="outline" className="text-[10px] text-muted-foreground">closed</Badge>
    : d?.draft ? <Badge variant="outline" className="text-[10px]">draft</Badge>
    : <Badge className="border-transparent bg-emerald-500/15 text-[10px] text-emerald-500">open</Badge>;

  const ciChip = (() => {
    if (!pr.branch) return null;
    if (isLoading && !data) return <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> CI…</span>;
    if (state === "pending") return <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-500"><Loader2 className="h-3 w-3 animate-spin" /> CI en cours</span>;
    if (state === "success") return <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-500"><CheckCircle2 className="h-3 w-3" /> CI réussie</span>;
    if (state === "failure") return <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-red-500"><AlertTriangle className="h-3 w-3" /> CI échouée</span>;
    return <span className="text-[11px] text-muted-foreground">Sans CI</span>;
  })();

  return (
    <div className="rounded-lg border border-border bg-background/60 p-3">
      {/* Header: PR link + title + state */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <a href={pr.html_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 hover:underline dark:text-emerald-400">
            <GitPullRequest className="h-4 w-4 shrink-0" /> PR #{pr.number} <ExternalLink className="h-3 w-3" />
          </a>
          {d?.title && <div className="mt-0.5 truncate text-xs text-foreground">{d.title}</div>}
        </div>
        {stateBadge}
      </div>

      {/* Meta row: branches · diffstat · files/commits · CI */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {d ? (
          <>
            <span className="inline-flex items-center gap-1 font-mono"><GitBranch className="h-3 w-3" />{d.head.ref} → {d.base.ref}</span>
            <span className="tabular-nums"><span className="text-emerald-500">+{d.additions}</span> <span className="text-red-500">−{d.deletions}</span></span>
            <span className="tabular-nums">{d.changed_files} fichier{d.changed_files > 1 ? "s" : ""}</span>
            <span className="tabular-nums">{d.commits} commit{d.commits > 1 ? "s" : ""}</span>
          </>
        ) : pr.branch ? (
          <span className="inline-flex items-center gap-1 font-mono"><GitBranch className="h-3 w-3" />{pr.branch}</span>
        ) : null}
        {ciChip}
      </div>

      {/* CI failures */}
      {state === "failure" && (data?.failures?.length ?? 0) > 0 && (
        <ul className="mt-2 space-y-1 border-t border-border/60 pt-2">
          {data!.failures.slice(0, 6).map((f, i) => (
            <li key={i} className="flex gap-2 text-[11px]">
              <span className="shrink-0 rounded bg-red-500/10 px-1 font-mono text-red-500">{f.check}</span>
              <span className="min-w-0 text-muted-foreground">
                {f.path && <span className="font-mono text-foreground/80">{f.path}{f.line ? `:${f.line}` : ""} </span>}
                {f.message}
              </span>
            </li>
          ))}
          {data!.failures.length > 6 && <li className="text-[11px] text-muted-foreground">+{data!.failures.length - 6} autres…</li>}
        </ul>
      )}

      {/* Actions */}
      {!merged && !closed && (
        <div className="mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2.5">
          {state === "failure" && (
            <Button size="sm" variant="outline" onClick={onFix} disabled={busy}>
              {busy ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Correction…</> : <><Wand2 className="mr-1.5 h-3.5 w-3.5" /> Corriger les erreurs</>}
            </Button>
          )}
          <Button size="sm" onClick={merge} disabled={merging || busy} className="bg-violet-600 hover:bg-violet-600/90">
            {merging ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Fusion…</> : <><GitMerge className="mr-1.5 h-3.5 w-3.5" /> Merger la PR</>}
          </Button>
          {state === "failure" && <span className="text-[11px] text-muted-foreground">CI en échec — corrige d'abord ou merge quand même.</span>}
        </div>
      )}
      {merged && (
        <div className="mt-2.5 flex items-center gap-1.5 border-t border-border/60 pt-2.5 text-xs font-medium text-violet-500">
          <GitMerge className="h-3.5 w-3.5" /> Pull request fusionnée.
        </div>
      )}
      {mergeError && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0 break-words">{mergeError}</span>
        </div>
      )}
    </div>
  );
}

// Unified line diff (LCS). type: same | add | del.
type DiffLine = { type: "same" | "add" | "del"; text: string; oldNo?: number; newNo?: number };
function diffLines(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr.length ? oldStr.split("\n") : [];
  const b = newStr.split("\n");
  const n = a.length, m = b.length;
  // Guard against huge O(n*m) diffs — fall back to "all added".
  if (n * m > 4_000_000) return b.map((text, i) => ({ type: "add", text, newNo: i + 1 }));
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0, oldNo = 1, newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: "same", text: a[i], oldNo: oldNo++, newNo: newNo++ }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: a[i], oldNo: oldNo++ }); i++; }
    else { out.push({ type: "add", text: b[j], newNo: newNo++ }); j++; }
  }
  while (i < n) out.push({ type: "del", text: a[i++], oldNo: oldNo++ });
  while (j < m) out.push({ type: "add", text: b[j++], newNo: newNo++ });
  return out;
}

function CodePreview({ change, repoId, branch }: { change: Change | null; repoId?: string; branch?: string }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { data: oldContent, isLoading } = useQuery({
    queryKey: ["vibe_old_file", repoId, branch, change?.path],
    enabled: !!change && !!repoId && !!workspaceId && !!projectId,
    queryFn: async () => {
      const res = await callEdge<{ content: string | null }>("repo-browse", { workspace_id: workspaceId, project_id: projectId, repository_id: repoId, action: "file", ref: branch, path: change!.path });
      return res.content ?? "";
    },
  });
  const isNewFile = change != null && !isLoading && oldContent === "";
  const diff = useMemo(() => (change && !isLoading ? diffLines(oldContent ?? "", change.content) : []), [change, oldContent, isLoading]);
  const adds = diff.filter((d) => d.type === "add").length;
  const dels = diff.filter((d) => d.type === "del").length;

  if (!change) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-[#0d1117] text-white/40">
        <FileCode className="h-8 w-8" /><span className="text-sm">Les modifications proposées s'afficheront ici.</span>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0d1117]">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5 text-white/80">
        <FileCode className="h-4 w-4" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{change.path}</span>
        {!isLoading && (adds > 0 || dels > 0) && (
          <span className="shrink-0 font-mono text-[11px]"><span className="text-emerald-400">+{adds}</span> <span className="text-red-400">−{dels}</span></span>
        )}
        <Badge variant={isNewFile ? "success" : "secondary"} className="shrink-0">{isNewFile ? "nouveau" : "modifié"}</Badge>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-white/40" /></div>
        ) : (
          <table className="w-full border-collapse font-mono text-[12px] leading-relaxed">
            <tbody>
              {diff.map((d, i) => (
                <tr key={i} className={cn(d.type === "add" && "bg-emerald-500/10", d.type === "del" && "bg-red-500/10")}>
                  <td className="select-none border-r border-white/10 px-2 text-right align-top text-white/25" style={{ width: "1%" }}>{d.oldNo ?? ""}</td>
                  <td className="select-none border-r border-white/10 px-2 text-right align-top text-white/25" style={{ width: "1%" }}>{d.newNo ?? ""}</td>
                  <td className={cn("select-none pl-2 align-top", d.type === "add" ? "text-emerald-400" : d.type === "del" ? "text-red-400" : "text-white/20")} style={{ width: "1%" }}>
                    {d.type === "add" ? "+" : d.type === "del" ? "−" : ""}
                  </td>
                  <td className={cn("whitespace-pre-wrap break-words px-2", d.type === "add" ? "text-emerald-200" : d.type === "del" ? "text-red-200" : "text-zinc-300")}>{d.text || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Artifacts tab ────────────────────────────────────────────────────────────
function ArtifactsTab({ result, repo, branch }: { result: RunResult | null; repo: Repo | null; branch: string }) {
  const [sel, setSel] = useState(0);
  function download(c: Change) {
    const blob = new Blob([c.content], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = c.path.split("/").pop() || "file.txt"; a.click();
    URL.revokeObjectURL(a.href);
  }
  if (!result || result.changes.length === 0) {
    return <div className="flex h-full items-center justify-center p-8"><EmptyState icon={Package} title="Aucun artifact" description="Les fichiers produits par l'agent Vibe Code (modifications proposées) apparaîtront ici. Lancez une tâche dans l'onglet Vibe Code." /></div>;
  }
  return (
    <div className="flex h-full min-h-0">
      <div className="w-[360px] shrink-0 overflow-y-auto border-r border-border p-3">
        <div className="mb-2 px-1 text-[11px] text-muted-foreground">{repo?.full_name} · {branch} · {result.changes.length} fichier(s)</div>
        <ul className="space-y-1">
          {result.changes.map((c, i) => (
            <li key={c.path} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5", sel === i ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-muted/50")}>
              <button onClick={() => setSel(i)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{c.path}</span>
              </button>
              <button onClick={() => download(c)} title="Télécharger" className="shrink-0 text-muted-foreground hover:text-foreground"><Download className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      </div>
      <CodePreview change={result.changes[sel] ?? null} repoId={repo?.id} branch={branch} />
    </div>
  );
}

// ── PR tab ───────────────────────────────────────────────────────────────────
interface PullRow { number: number; title: string; state: string; draft: boolean; html_url: string; user: string | null; created_at: string; updated_at: string; head: string | null; base: string | null; merged_at: string | null }
function PrTab({ repoId, workspaceId, projectId }: { repoId: string; workspaceId: string | null; projectId: string | null }) {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["repo-pulls", repoId],
    enabled: !!repoId && !!workspaceId && !!projectId,
    queryFn: async () => (await callEdge<{ pulls: PullRow[] }>("repo-browse", { workspace_id: workspaceId, project_id: projectId, repository_id: repoId, action: "pulls" })).pulls,
  });
  const tone = (p: PullRow) => p.merged_at ? { label: "merged", cls: "text-violet-500" } : p.state === "closed" ? { label: "closed", cls: "text-red-500" } : p.draft ? { label: "draft", cls: "text-muted-foreground" } : { label: "open", cls: "text-emerald-500" };
  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Pull requests</h2>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}><RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", isFetching && "animate-spin")} /> Actualiser</Button>
      </div>
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : error ? <p className="text-sm text-destructive">{(error as Error).message}</p>
        : (data ?? []).length === 0 ? <EmptyState icon={GitPullRequest} title="Aucune pull request" description="Les PR de ce dépôt (dont celles créées par Vibe Code) apparaîtront ici." />
        : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data!.map((p) => {
              const t = tone(p);
              return (
                <li key={p.number}>
                  <a href={p.html_url} target="_blank" rel="noreferrer" className="flex items-center gap-3 p-3 hover:bg-muted/40">
                    <GitPullRequest className={cn("h-4 w-4 shrink-0", t.cls)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{p.title}</span><span className={cn("text-[10px] uppercase", t.cls)}>{t.label}</span></div>
                      <div className="truncate text-[11px] text-muted-foreground">#{p.number} · {p.user} · {p.head} → {p.base} · {new Date(p.updated_at).toLocaleDateString("fr-FR")}</div>
                    </div>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </a>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}

// ── Fork tab ─────────────────────────────────────────────────────────────────
function ForkTab({ repoId, repo, workspaceId, projectId }: { repoId: string; repo: Repo | null; workspaceId: string | null; projectId: string | null }) {
  const [forking, setForking] = useState(false);
  const [fork, setFork] = useState<{ full_name: string | null; html_url: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { data: info } = useQuery({
    queryKey: ["repo-info", repoId],
    enabled: !!repoId && !!workspaceId && !!projectId,
    queryFn: async () => callEdge<{ is_fork: boolean; parent: string | null; html_url: string | null }>("repo-browse", { workspace_id: workspaceId, project_id: projectId, repository_id: repoId, action: "info" }),
  });
  async function doFork() {
    setForking(true); setErr(null);
    try {
      const res = await callEdge<{ full_name: string | null; html_url: string | null }>("repo-browse", { workspace_id: workspaceId, project_id: projectId, repository_id: repoId, action: "fork" });
      setFork(res);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setForking(false); }
  }
  return (
    <div className="mx-auto flex h-full max-w-lg flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary"><GitFork className="h-7 w-7 text-muted-foreground" /></div>
      <div>
        <h2 className="text-lg font-semibold">Forker {repo?.full_name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">Crée une copie du dépôt sur votre compte GitHub (via le token connecté). Utile pour proposer des changements sans droits d'écriture sur l'original.</p>
      </div>
      {info?.is_fork && info.parent && <Badge variant="secondary">Déjà un fork de {info.parent}</Badge>}
      {fork ? (
        <a href={fork.html_url ?? "#"} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600/90">
          <GitFork className="h-4 w-4" /> Fork créé : {fork.full_name} <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : (
        <Button onClick={doFork} disabled={forking}>{forking ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Fork en cours…</> : <><GitFork className="mr-1.5 h-4 w-4" /> Forker le dépôt</>}</Button>
      )}
      {err && <p className="text-sm text-destructive">{err}</p>}
    </div>
  );
}

// ── Preview tab (Vercel/Netlify preview deployments) ─────────────────────────
interface Deployment { id: number; environment: string | null; ref: string | null; sha: string; created_at: string | null; state: string; url: string | null }
function PreviewTab({ repoId, workspaceId, projectId }: { repoId: string; workspaceId: string | null; projectId: string | null }) {
  const [url, setUrl] = useState("");
  const [loaded, setLoaded] = useState("");
  const base = { workspace_id: workspaceId, project_id: projectId, repository_id: repoId };

  const { data: deployments, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["repo-deployments", repoId],
    enabled: !!repoId && !!workspaceId && !!projectId,
    refetchInterval: (q) => ((q.state.data as Deployment[] | undefined)?.some((d) => d.state === "pending" || d.state === "in_progress") ? 5000 : false),
    queryFn: async () => (await callEdge<{ deployments: Deployment[] }>("repo-browse", { ...base, action: "deployments" })).deployments,
  });
  const { data: info } = useQuery({
    queryKey: ["repo-info", repoId],
    enabled: !!repoId && !!workspaceId && !!projectId,
    queryFn: async () => callEdge<{ homepage: string | null }>("repo-browse", { ...base, action: "info" }),
  });

  const live = (deployments ?? []).filter((d) => d.url);
  // Auto-load the most recent successful deployment (else homepage).
  useEffect(() => {
    if (loaded) return;
    const best = live.find((d) => d.state === "success") ?? live[0];
    if (best?.url) { setUrl(best.url); setLoaded(best.url); }
    else if (info?.homepage) { setUrl(info.homepage); setLoaded(info.homepage); }
  }, [deployments, info?.homepage]); // eslint-disable-line react-hooks/exhaustive-deps

  const stateTone = (s: string) => s === "success" ? "text-emerald-500" : s === "failure" || s === "error" ? "text-red-500" : "text-amber-500";

  return (
    <div className="flex h-full min-h-0">
      {/* Deployments list */}
      <div className="flex w-[320px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold">Déploiements</span>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => refetch()} disabled={isFetching}><RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /></Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {isLoading ? (
            <div className="flex h-24 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : live.length === 0 ? (
            <div className="space-y-2 p-2 text-xs text-muted-foreground">
              <p>Aucun déploiement de preview trouvé.</p>
              <p>Connectez <span className="font-medium text-foreground">Vercel</span> ou <span className="font-medium text-foreground">Netlify</span> à ce dépôt : chaque pull request (dont celles de Vibe Code) obtiendra automatiquement une URL de preview qui s'affichera ici.</p>
            </div>
          ) : (
            <ul className="space-y-1">
              {live.map((d) => (
                <li key={d.id}>
                  <button onClick={() => { setUrl(d.url!); setLoaded(d.url!); }} className={cn("w-full rounded-md px-2 py-2 text-left transition-colors", loaded === d.url ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-muted/50")}>
                    <div className="flex items-center gap-1.5">
                      <span className={cn("h-1.5 w-1.5 rounded-full", d.state === "success" ? "bg-emerald-500" : d.state === "failure" || d.state === "error" ? "bg-red-500" : "bg-amber-500")} />
                      <span className="truncate text-sm font-medium">{d.environment ?? "preview"}</span>
                      <span className={cn("ml-auto text-[10px] uppercase", stateTone(d.state))}>{d.state}</span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{d.ref ?? d.sha}</div>
                    <div className="truncate text-[10px] text-muted-foreground">{d.url}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Iframe */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Monitor className="h-4 w-4 text-muted-foreground" />
          <Input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") setLoaded(url); }} placeholder="URL de preview (ou déploiement / tunnel)" className="h-8" />
          <Button size="sm" onClick={() => setLoaded(url)} disabled={!url}><Eye className="mr-1.5 h-3.5 w-3.5" /> Charger</Button>
          {loaded && <a href={loaded} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" title="Ouvrir dans un onglet"><ExternalLink className="h-4 w-4" /></a>}
        </div>
        <div className="min-h-0 flex-1 bg-muted/20">
          {loaded ? (
            <iframe title="preview" src={loaded} className="h-full w-full border-0 bg-white" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
              <Monitor className="h-8 w-8" />
              <span className="text-sm">Sélectionnez un déploiement, ou entrez une URL.</span>
              <span className="max-w-sm text-xs">Si la page reste blanche, l'app bloque probablement l'affichage en iframe (X-Frame-Options / CSP) — ouvrez-la dans un onglet.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
