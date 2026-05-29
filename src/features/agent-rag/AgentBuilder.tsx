import { useState, useRef, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Loader2, Bot, BarChart3,
  Plus, Trash2, Send, FileText, Link2, LayoutGrid, Check, Copy, Sparkles, BookOpen, Search,
  Globe, FileUp, Type, RotateCcw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

type Tab = "knowledge" | "playground" | "widget" | "analytics" | "settings";

interface Agent {
  id: string; project_id: string; name: string; description: string | null; persona: string | null;
  instructions: string | null; model: string; temperature: number;
  welcome_message: string | null; widget_config: any; public_key: string;
  enabled: boolean; onboarding_enabled: boolean; accent_color: string | null;
}
interface Source { id: string; type: string; title: string; status: string; chunk_count: number; byte_size?: number; error_message: string | null; created_at: string; }

const VALID_TABS: Tab[] = ["knowledge", "playground", "widget", "analytics", "settings"];

export function AgentBuilderPage() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug, agentId, tab: tabParam } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const tab: Tab = VALID_TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "playground";

  const { data: agent, isLoading } = useQuery({
    queryKey: ["rag_agent", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data } = await supabase.from("rag_agents").select("*").eq("id", agentId!).maybeSingle();
      return data as Agent | null;
    },
  });

  if (isLoading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!agent) return <EmptyState icon={Bot} title="Agent not found" />;

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/agents`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-secondary">
          <Bot className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
          {agent.description && <p className="text-sm text-muted-foreground">{agent.description}</p>}
        </div>
      </div>

      {tab === "knowledge" && <KnowledgeTab agent={agent} workspaceId={workspaceId} projectId={projectId} />}
      {tab === "playground" && <PlaygroundTab agent={agent} workspaceId={workspaceId} projectId={projectId} />}
      {tab === "widget" && <WidgetTab agent={agent} />}
      {tab === "analytics" && <AnalyticsTab agent={agent} />}
      {tab === "settings" && <SettingsTab agent={agent} />}
    </div>
  );
}

// --- Knowledge ----------------------------------------------------------
const SOURCE_TYPES = [
  { value: "text", label: "Text" },
  { value: "url", label: "URL" },
  { value: "saas_structure", label: "SaaS structure" },
] as const;

function sourceIcon(t: string) {
  return t === "url" ? Link2 : t === "saas_structure" ? LayoutGrid : FileText;
}

function fmtBytes(n: number) {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function KnowledgeTab({ agent, workspaceId, projectId }: { agent: Agent; workspaceId: string | null; projectId: string | null }) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [defaultType, setDefaultType] = useState<"text" | "url" | "saas_structure">("text");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: sources } = useQuery({
    queryKey: ["rag_sources", agent.id],
    enabled: !!agent.id,
    refetchInterval: 4000,
    queryFn: async () => {
      const { data } = await supabase.from("rag_sources").select("*").eq("agent_id", agent.id).order("created_at", { ascending: false });
      return (data ?? []) as Source[];
    },
  });

  const usedBytes = (sources ?? []).reduce((s, x) => s + (x.byte_size ?? 0), 0);

  async function removeSource(id: string) {
    await supabase.from("rag_sources").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["rag_sources", agent.id] });
  }

  function openDialog(t: "text" | "url" | "saas_structure") {
    setDefaultType(t);
    setAddOpen(true);
  }

  // Upload files to Storage, then trigger server-side extraction + ingestion.
  async function onFiles(files: FileList | null) {
    if (!files || !workspaceId || !projectId) return;
    setUploading(true); setUploadErr(null);
    try {
      for (const file of Array.from(files)) {
        const path = `${projectId}/${agent.id}/${Date.now()}-${file.name.replace(/[^\w.\-]/g, "_")}`;
        const { error: upErr } = await supabase.storage.from("rag-docs").upload(path, file, { upsert: false });
        if (upErr) throw new Error(upErr.message);
        await callEdge("rag-extract-file", {
          workspace_id: workspaceId, project_id: projectId, agent_id: agent.id,
          title: file.name, storage_path: path, mime: file.type,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["rag_sources", agent.id] });
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const filtered = (sources ?? []).filter((s) => {
    if (typeFilter && s.type !== typeFilter) return false;
    const q = search.trim().toLowerCase();
    if (q && !s.title.toLowerCase().includes(q)) return false;
    return true;
  });

  const ACTIONS = [
    { icon: Globe, label: "Add URL", onClick: () => openDialog("url") },
    { icon: FileUp, label: "Add Files", onClick: () => fileRef.current?.click() },
    { icon: Type, label: "Create Text", onClick: () => openDialog("text") },
    { icon: LayoutGrid, label: "SaaS structure", onClick: () => openDialog("saas_structure") },
  ];

  return (
    <div>
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Knowledge Base</h2>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border/60 px-3 py-1.5 text-xs">
          <span className={`h-2 w-2 rounded-full ${usedBytes > 0 ? "bg-emerald-400" : "bg-muted-foreground/40"}`} />
          RAG Storage: <span className="font-semibold text-foreground">{fmtBytes(usedBytes)}</span>
        </div>
      </div>

      {/* Action cards */}
      <input ref={fileRef} type="file" multiple accept=".txt,.md,.csv,.json,.html,.pdf,.docx" className="hidden" onChange={(e) => onFiles(e.target.files)} />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {ACTIONS.map((a) => (
          <button
            key={a.label}
            onClick={a.onClick}
            disabled={a.label === "Add Files" && uploading}
            className="flex flex-col items-center gap-2 rounded-lg border border-border/60 bg-card p-4 text-sm transition-colors hover:border-primary/40 hover:bg-secondary/40 disabled:opacity-60"
          >
            {a.label === "Add Files" && uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <a.icon className="h-5 w-5 text-muted-foreground" />}
            {a.label}
          </button>
        ))}
      </div>
      {uploadErr && <p className="mb-3 text-sm text-destructive">{uploadErr}</p>}

      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search Knowledge Base…" className="pl-9" />
      </div>

      {/* Type filter chips */}
      <div className="mb-5 flex flex-wrap gap-1.5">
        <button
          onClick={() => setTypeFilter("")}
          className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${typeFilter === "" ? "border-primary/40 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-secondary"}`}
        >
          All
        </button>
        {SOURCE_TYPES.map((t) => (
          <button
            key={t.value}
            onClick={() => setTypeFilter(t.value)}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${typeFilter === t.value ? "border-primary/40 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-secondary"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Cards grid / empty state */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-muted/10 py-16 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-md border border-border bg-card">
            <FileText className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="font-semibold">No documents found</div>
          <p className="mt-1 text-sm text-muted-foreground">
            {sources && sources.length > 0 ? "No documents match your filters." : "This agent has no attached documents yet."}
          </p>
          <Button className="mt-4" onClick={() => openDialog("text")}><Plus className="h-4 w-4" /> Add document</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((s) => {
            const Icon = sourceIcon(s.type);
            return (
              <Card key={s.id} className="group">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-secondary">
                      <Icon className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      onClick={() => removeSource(s.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="mt-3 truncate font-medium" title={s.title}>{s.title}</div>
                  {s.error_message && <div className="mt-0.5 truncate text-xs text-destructive">{s.error_message}</div>}
                  <div className="mt-3 flex items-center justify-between">
                    <Badge variant="outline" className="capitalize">{s.type.replace("_", " ")}</Badge>
                    <Badge variant={s.status === "ready" ? "success" : s.status === "failed" ? "destructive" : "secondary"}>
                      {s.status === "ready" ? `${s.chunk_count} chunks` : s.status}
                      {(s.status === "processing" || s.status === "pending") && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AddDocumentDialog
        open={addOpen}
        defaultType={defaultType}
        onClose={() => setAddOpen(false)}
        onAdded={() => { queryClient.invalidateQueries({ queryKey: ["rag_sources", agent.id] }); setAddOpen(false); }}
        agent={agent}
        workspaceId={workspaceId}
        projectId={projectId}
      />
    </div>
  );
}

function AddDocumentDialog({
  open, defaultType, onClose, onAdded, agent, workspaceId, projectId,
}: {
  open: boolean; defaultType: "text" | "url" | "saas_structure"; onClose: () => void; onAdded: () => void;
  agent: Agent; workspaceId: string | null; projectId: string | null;
}) {
  const [type, setType] = useState<"text" | "url" | "saas_structure">(defaultType);
  useEffect(() => { if (open) setType(defaultType); }, [open, defaultType]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ingest() {
    if (!workspaceId || !projectId) return;
    setBusy(true); setError(null);
    try {
      const payload: any = { workspace_id: workspaceId, project_id: projectId, agent_id: agent.id, type, title: title || (type === "saas_structure" ? "SaaS structure" : type) };
      if (type === "text") payload.content = content;
      if (type === "url") payload.url = url;
      await callEdge("rag-ingest", payload);
      setTitle(""); setContent(""); setUrl("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Add document</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-1.5">
            {SOURCE_TYPES.map((t) => (
              <Button key={t.value} size="sm" variant={type === t.value ? "default" : "outline"} onClick={() => setType(t.value)}>
                {t.label}
              </Button>
            ))}
          </div>
          {type !== "saas_structure" && <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />}
          {type === "text" && (
            <textarea placeholder="Paste text / FAQ / docs…" value={content} onChange={(e) => setContent(e.target.value)} rows={6}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          )}
          {type === "url" && <Input placeholder="https://docs.example.com/page" value={url} onChange={(e) => setUrl(e.target.value)} />}
          {type === "saas_structure" && (
            <p className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
              Imports your app's pages & interactive elements from the latest code scan, so the agent can guide users (onboarding). Run a code scan first.
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={ingest} disabled={busy || (type === "text" && !content) || (type === "url" && !url)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Ingest & vectorize
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- Playground ---------------------------------------------------------
function PlaygroundTab({ agent, workspaceId, projectId }: { agent: Agent; workspaceId: string | null; projectId: string | null }) {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string; sources?: any[] }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [convId, setConvId] = useState<string | undefined>();
  const endRef = useRef<HTMLDivElement>(null);

  // Quick-edit config in the left panel.
  const [model, setModel] = useState(agent.model);
  const [instructions, setInstructions] = useState(agent.instructions ?? "");
  const [savingCfg, setSavingCfg] = useState(false);

  const accent = agent.accent_color || "#001BB7";

  const { data: stats } = useQuery({
    queryKey: ["rag_pg_stats", agent.id],
    enabled: !!agent.id,
    queryFn: async () => {
      const { data } = await supabase.from("rag_sources").select("chunk_count, byte_size, status").eq("agent_id", agent.id);
      const rows = data ?? [];
      return {
        chunks: rows.reduce((s: number, r: any) => s + (r.chunk_count ?? 0), 0),
        bytes: rows.reduce((s: number, r: any) => s + (r.byte_size ?? 0), 0),
        ready: rows.filter((r: any) => r.status === "ready").length,
        total: rows.length,
      };
    },
  });
  const trained = (stats?.ready ?? 0) > 0;

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  async function send() {
    if (!input.trim() || !workspaceId || !projectId) return;
    const q = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", content: q }]);
    setBusy(true);
    try {
      const res = await callEdge<{ answer: string; conversation_id: string; sources: any[] }>("rag-chat", {
        workspace_id: workspaceId, project_id: projectId, agent_id: agent.id, message: q, conversation_id: convId,
      });
      setConvId(res.conversation_id);
      setMessages((m) => [...m, { role: "assistant", content: res.answer, sources: res.sources }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `Error: ${e instanceof Error ? e.message : String(e)}` }]);
    } finally { setBusy(false); }
  }

  function reset() { setMessages([]); setConvId(undefined); }

  async function saveCfg() {
    setSavingCfg(true);
    try {
      await supabase.from("rag_agents").update({ model, instructions }).eq("id", agent.id);
      queryClient.invalidateQueries({ queryKey: ["rag_agent", agent.id] });
    } finally { setSavingCfg(false); }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
      {/* Left config panel */}
      <div className="space-y-4">
        <h2 className="text-xl font-bold">Playground</h2>
        <Card>
          <CardContent className="p-4">
            <div className={`flex items-center gap-2 text-sm font-medium ${trained ? "text-emerald-400" : "text-muted-foreground"}`}>
              <span className={`h-2 w-2 rounded-full ${trained ? "bg-emerald-400" : "bg-muted-foreground/40"}`} />
              {trained ? "Trained" : "Not trained yet"}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {stats ? `${stats.ready}/${stats.total} sources · ${stats.chunks} chunks · ${fmtBytes(stats.bytes)}` : "—"}
            </div>
          </CardContent>
        </Card>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Model</label>
          <select value={model} onChange={(e) => setModel(e.target.value)} className="h-10 w-full rounded-md bg-secondary/60 px-3 text-sm outline-none">
            <option value="groq">Groq — Llama 3.3 70B (fast)</option>
            <option value="deepseek">DeepSeek Chat (deep)</option>
          </select>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Instructions (System prompt)</label>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={8}
            placeholder="### Role&#10;- You are a helpful assistant for…"
            className="w-full rounded-md bg-secondary/60 px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        <Button onClick={saveCfg} disabled={savingCfg} className="w-full">
          {savingCfg ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save changes
        </Button>
      </div>

      {/* Right chat panel (dotted background) */}
      <div
        className="flex justify-center rounded-lg border border-border/40 p-6"
        style={{ backgroundImage: "radial-gradient(hsl(var(--muted-foreground)/0.18) 1px, transparent 1px)", backgroundSize: "16px 16px" }}
      >
        <Card className="flex h-[68vh] w-full max-w-md flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md" style={{ background: `${accent}26` }}>
                <Bot className="h-4 w-4" style={{ color: accent }} />
              </div>
              <span className="truncate text-sm font-medium">{agent.name}</span>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={reset} title="Reset conversation">
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
          {/* Messages */}
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl bg-secondary px-3 py-2 text-sm">{agent.welcome_message ?? "Hi! What can I help you with?"}</div>
            </div>
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className="max-w-[85%] rounded-2xl px-3 py-2 text-sm" style={m.role === "user" ? { background: accent, color: "#fff" } : undefined}>
                  <p className={`whitespace-pre-wrap ${m.role === "assistant" ? "" : ""}`}>{m.content}</p>
                  {m.sources && m.sources.length > 0 && (
                    <div className="mt-1.5 border-t border-white/20 pt-1 text-[11px] opacity-70">
                      {m.sources.length} source(s){m.sources[0]?.similarity ? ` · top ${(m.sources[0].similarity * 100).toFixed(0)}%` : ""}
                    </div>
                  )}
                </div>
                {m.role === "assistant" && false}
              </div>
            ))}
            {messages.filter((m) => m.role === "assistant").length === 0 && messages.length === 0 && null}
            {busy && <div className="flex justify-start"><div className="rounded-2xl bg-secondary px-3 py-2"><Loader2 className="h-4 w-4 animate-spin" /></div></div>}
            <div ref={endRef} />
          </div>
          {/* Branding + input */}
          <div className="px-4 pb-1 text-center text-[10px] text-muted-foreground">Powered by FounderOS</div>
          <div className="flex items-center gap-2 border-t border-border p-3">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Message…"
              className="h-9 flex-1 rounded-full bg-secondary/60 px-4 text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              onClick={send}
              disabled={busy || !input.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-40"
              style={{ background: accent }}
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}

// --- Widget -------------------------------------------------------------
// Default widget config (text-chat adaptation of the ElevenLabs widget layout).
const WIDGET_DEFAULTS = {
  title: "Need help?",
  variant: "full",            // tiny | compact | full
  placement: "bottom-right",  // bottom-right | bottom-left
  collapsible: true,
  feedback: true,
  // colors
  base: "#ffffff",
  base_border: "#e5e7eb",
  base_subtle: "#6b7280",
  base_primary: "#18181b",
  accent: "#001BB7",
  accent_primary: "#ffffff",
  // radii (px)
  button_radius: 12,
  input_radius: 12,
  bubble_radius: 14,
  // avatar
  avatar_type: "orb",         // orb | image
  avatar_first: "#2792dc",
  avatar_second: "#9ce6e6",
  avatar_url: "",
  // terms
  terms_enabled: false,
  terms_content: "",
  // behavior
  launcher_icon: "chat",         // chat | help | sparkle
  suggested_questions: "",       // newline-separated quick replies
  show_branding: true,
  // text contents
  text_main_label: "Need help?",
  text_start_chat: "Start a chat",
  text_send: "Send",
  text_placeholder: "Type a message…",
};

// Section row: label/description on the left, controls on the right (ElevenLabs style).
function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 border-b border-border/40 py-6 lg:grid-cols-[260px_1fr]">
      <div>
        <h3 className="font-semibold">{title}</h3>
        {desc && <p className="mt-1 text-sm text-muted-foreground">{desc}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-3">
      <label className="text-sm">{label}</label>
      <div className="flex items-center gap-2 rounded-md bg-secondary/60 px-2.5 py-1.5">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-5 w-5 shrink-0 cursor-pointer rounded-full border-0 bg-transparent p-0" />
        <input value={value} onChange={(e) => onChange(e.target.value)} className="w-full bg-transparent font-mono text-sm outline-none" />
      </div>
    </div>
  );
}

function RadiusRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-3">
      <label className="text-sm">{label}</label>
      <div className="flex items-center rounded-md bg-secondary/60 pr-3">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-9 w-full bg-transparent px-2.5 text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="text-xs text-muted-foreground">px</span>
      </div>
    </div>
  );
}

function Toggle({ label, desc, checked, onChange }: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors ${checked ? "bg-primary" : "bg-secondary"}`}
      >
        <span className={`h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : ""}`} />
      </button>
      <div>
        <div className="text-sm font-medium">{label}</div>
        {desc && <div className="text-xs text-muted-foreground">{desc}</div>}
      </div>
    </label>
  );
}

function TextRow({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-center gap-3">
      <label className="font-mono text-xs text-muted-foreground">{label}</label>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md bg-secondary/60 px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
      />
    </div>
  );
}

function WidgetTab({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [cfg, setCfg] = useState<Record<string, any>>({ ...WIDGET_DEFAULTS, ...(agent.widget_config ?? {}) });
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function set<K extends string>(k: K, v: any) { setCfg((c) => ({ ...c, [k]: v })); }

  const base = (import.meta as any).env?.VITE_SUPABASE_URL ?? "https://YOUR_PROJECT.supabase.co";
  const snippet = `<script>
  window.FounderOSAgent = {
    key: "${agent.public_key}",
    endpoint: "${base}/functions/v1/rag-chat",
    welcome: ${JSON.stringify(agent.welcome_message ?? "Hi! How can I help you today?")},
    config: ${JSON.stringify(cfg, null, 2).replace(/\n/g, "\n    ")}
  };
</script>
<script src="${base}/functions/v1/rag-widget" async></script>`;

  async function save() {
    setSaving(true); setSaved(false);
    try {
      await supabase.from("rag_agents").update({ widget_config: cfg }).eq("id", agent.id);
      queryClient.invalidateQueries({ queryKey: ["rag_agent", agent.id] });
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } finally { setSaving(false); }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-bold">Widget</h2>
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {saved ? "Saved" : "Save"}
        </Button>
      </div>

      {/* Setup / Embed */}
      <Section title="Setup" desc="Attach the widget on your website.">
        <div className="rounded-md bg-secondary/50 p-3 text-sm text-muted-foreground">
          The agent answers from its knowledge base. Paste the embed code on the pages where you want the chat widget.
        </div>
        <div>
          <div className="mb-1.5 text-sm font-medium">Embed code</div>
          <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-secondary/50 p-3 font-mono text-xs leading-relaxed text-foreground/90">{snippet}</pre>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => { navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />} Copy snippet
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">Public key: <code className="rounded bg-secondary/60 px-1.5 py-0.5 text-foreground">{agent.public_key}</code></p>
        </div>
        <Toggle label="Feedback collection" desc="Visitors can rate their satisfaction from 1 to 5 after the conversation." checked={cfg.feedback} onChange={(v) => set("feedback", v)} />
      </Section>

      {/* Interface */}
      <Section title="Interface" desc="Configure the parts of the widget interface.">
        <Toggle label="Collapsible" desc="Visitors can collapse the chat back to the bubble." checked={cfg.collapsible} onChange={(v) => set("collapsible", v)} />
        <Toggle label="Show branding" desc="Display a small 'Powered by FounderOS' line at the bottom." checked={cfg.show_branding} onChange={(v) => set("show_branding", v)} />
        <div>
          <label className="mb-1.5 block text-sm font-medium">Variant</label>
          <div className="inline-flex rounded-md bg-secondary/60 p-0.5">
            {["tiny", "compact", "full"].map((v) => (
              <button key={v} onClick={() => set("variant", v)} className={`rounded px-4 py-1.5 text-sm capitalize transition-colors ${cfg.variant === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}>{v}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium">Launcher icon</label>
          <div className="inline-flex rounded-md bg-secondary/60 p-0.5">
            {["chat", "help", "sparkle"].map((v) => (
              <button key={v} onClick={() => set("launcher_icon", v)} className={`rounded px-4 py-1.5 text-sm capitalize transition-colors ${cfg.launcher_icon === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}>{v}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium">Placement</label>
          <select value={cfg.placement} onChange={(e) => set("placement", e.target.value)} className="h-9 w-full max-w-xs rounded-md bg-secondary/60 px-2.5 text-sm outline-none">
            <option value="bottom-right">Bottom-right</option>
            <option value="bottom-left">Bottom-left</option>
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium">Suggested questions</label>
          <textarea
            value={cfg.suggested_questions}
            onChange={(e) => set("suggested_questions", e.target.value)}
            rows={3}
            placeholder={"One per line, shown as quick replies\nHow do I get started?\nWhat are your pricing plans?"}
            className="w-full rounded-md bg-secondary/60 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      </Section>

      {/* Styling */}
      <Section title="Styling" desc="Customize the colors and shape of the widget to best fit your website.">
        <ColorRow label="Base" value={cfg.base} onChange={(v) => set("base", v)} />
        <ColorRow label="Base Border" value={cfg.base_border} onChange={(v) => set("base_border", v)} />
        <ColorRow label="Base Subtle" value={cfg.base_subtle} onChange={(v) => set("base_subtle", v)} />
        <ColorRow label="Base Primary" value={cfg.base_primary} onChange={(v) => set("base_primary", v)} />
        <ColorRow label="Accent" value={cfg.accent} onChange={(v) => set("accent", v)} />
        <ColorRow label="Accent Primary" value={cfg.accent_primary} onChange={(v) => set("accent_primary", v)} />
        <RadiusRow label="Button Radius" value={cfg.button_radius} onChange={(v) => set("button_radius", v)} />
        <RadiusRow label="Input Radius" value={cfg.input_radius} onChange={(v) => set("input_radius", v)} />
        <RadiusRow label="Bubble Radius" value={cfg.bubble_radius} onChange={(v) => set("bubble_radius", v)} />
      </Section>

      {/* Avatar */}
      <Section title="Avatar" desc="Configure the chat orb or provide your own avatar image.">
        <div className="inline-flex rounded-md bg-secondary/60 p-0.5">
          {["orb", "image"].map((t) => (
            <button key={t} onClick={() => set("avatar_type", t)} className={`rounded px-4 py-1.5 text-sm capitalize transition-colors ${cfg.avatar_type === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}>{t}</button>
          ))}
        </div>
        {cfg.avatar_type === "orb" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ColorRow label="First color" value={cfg.avatar_first} onChange={(v) => set("avatar_first", v)} />
            <ColorRow label="Second color" value={cfg.avatar_second} onChange={(v) => set("avatar_second", v)} />
          </div>
        ) : (
          <input placeholder="Avatar image URL" value={cfg.avatar_url} onChange={(e) => set("avatar_url", e.target.value)} className="h-9 w-full rounded-md bg-secondary/60 px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring" />
        )}
      </Section>

      {/* Terms & Conditions */}
      <Section title="Terms & Conditions" desc="Require the visitor to accept your terms before chatting.">
        <Toggle label="Enable terms & conditions" checked={cfg.terms_enabled} onChange={(v) => set("terms_enabled", v)} />
        {cfg.terms_enabled && (
          <div>
            <label className="mb-1.5 block text-sm font-medium">Terms content <span className="text-xs text-muted-foreground">(Markdown)</span></label>
            <textarea value={cfg.terms_content} onChange={(e) => set("terms_content", e.target.value)} rows={5} className="w-full rounded-md bg-secondary/60 px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring" />
          </div>
        )}
      </Section>

      {/* Text contents */}
      <Section title="Text contents" desc="Modify the text shown in the widget interface.">
        <TextRow label="main_label" value={cfg.text_main_label} placeholder="Need help?" onChange={(v) => set("text_main_label", v)} />
        <TextRow label="start_chat" value={cfg.text_start_chat} placeholder="Start a chat" onChange={(v) => set("text_start_chat", v)} />
        <TextRow label="send" value={cfg.text_send} placeholder="Send" onChange={(v) => set("text_send", v)} />
        <TextRow label="placeholder" value={cfg.text_placeholder} placeholder="Type a message…" onChange={(v) => set("text_placeholder", v)} />
      </Section>
    </div>
  );
}

// --- Analytics ----------------------------------------------------------
type AnalyticsTab = "general" | "tools" | "llms" | "knowledge";
const RANGES = [
  { value: 7, label: "Last week" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

// A KPI cell used in the General top band.
function Kpi({ label, value, active }: { label: string; value: string; active?: boolean }) {
  return (
    <div className={`min-w-0 px-4 py-3 ${active ? "border-b-2 border-primary" : ""}`}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// Card body placeholder when there's nothing to chart yet.
function NoData({ title }: { title: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-1 text-lg text-muted-foreground">—</div>
        <div className="flex h-40 flex-col items-center justify-center text-sm text-muted-foreground">
          <BarChart3 className="mb-2 h-7 w-7 opacity-30" />
          No data has been collected
        </div>
      </CardContent>
    </Card>
  );
}

function StatCard({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function AnalyticsTab({ agent }: { agent: Agent }) {
  const [tab, setTab] = useState<AnalyticsTab>("general");
  const [days, setDays] = useState(7);

  const { data, isLoading } = useQuery({
    queryKey: ["rag_analytics", agent.id, days],
    enabled: !!agent.id,
    queryFn: async () => {
      const since = new Date(Date.now() - days * 86400_000).toISOString();
      const [convos, msgs, llm, sources] = await Promise.all([
        supabase.from("rag_conversations").select("id, source, created_at, rating").eq("agent_id", agent.id).gte("created_at", since).limit(2000),
        supabase.from("rag_messages").select("role, content, sources, created_at").eq("agent_id", agent.id).gte("created_at", since).limit(3000),
        supabase.from("llm_usage").select("total_tokens, estimated_cost_cents, created_at").eq("project_id", agent.project_id).eq("feature", "rag-agent").gte("created_at", since).limit(3000),
        supabase.from("rag_sources").select("id, chunk_count, status").eq("agent_id", agent.id),
      ]);
      return {
        convos: convos.data ?? [],
        msgs: (msgs.data ?? []) as { role: string; content: string; sources: any[]; created_at: string }[],
        llm: (llm.data ?? []) as { total_tokens: number; estimated_cost_cents: number }[],
        sources: (sources.data ?? []) as { chunk_count: number; status: string }[],
      };
    },
  });

  const TABS: { value: AnalyticsTab; label: string }[] = [
    { value: "general", label: "General" },
    { value: "tools", label: "Tools" },
    { value: "llms", label: "LLMs" },
    { value: "knowledge", label: "Knowledge Base" },
  ];

  if (isLoading) return <EmptyState icon={Loader2} title="Loading…" />;
  const convos = data?.convos ?? [];
  const msgs = data?.msgs ?? [];
  const userMsgs = msgs.filter((m) => m.role === "user");
  const asstMsgs = msgs.filter((m) => m.role === "assistant");
  const llm = data?.llm ?? [];
  const sources = data?.sources ?? [];

  const totalConvos = convos.length;
  const widgetConvos = convos.filter((c: any) => c.source === "widget").length;
  const ratings = convos.map((c: any) => c.rating).filter((r: any) => r != null);
  const avgRating = ratings.length ? (ratings.reduce((a: number, b: number) => a + b, 0) / ratings.length).toFixed(1) : "—";
  const totalTokens = llm.reduce((s, x) => s + (x.total_tokens ?? 0), 0);
  const totalCost = llm.reduce((s, x) => s + (x.estimated_cost_cents ?? 0), 0) / 100;
  const llmRequests = llm.length;
  const docRefs = asstMsgs.reduce((s, m) => s + (Array.isArray(m.sources) ? m.sources.length : 0), 0);
  const answeredWithSources = asstMsgs.filter((m) => Array.isArray(m.sources) && m.sources.length > 0).length;
  const successRate = asstMsgs.length ? Math.round((answeredWithSources / asstMsgs.length) * 100) : null;
  const chunks = sources.reduce((s, x) => s + (x.chunk_count ?? 0), 0);

  // Top questions for the General view.
  const freq = new Map<string, number>();
  userMsgs.forEach((q) => freq.set(q.content.slice(0, 60), (freq.get(q.content.slice(0, 60)) ?? 0) + 1));
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const fmt = (n: number) => (n === 0 ? "—" : n.toLocaleString());

  return (
    <div>
      {/* Sub-tabs */}
      <div className="mb-4 flex flex-wrap gap-4 border-b border-border/40">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`-mb-px border-b-2 pb-2 text-sm transition-colors ${tab === t.value ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-md bg-secondary/60 px-2.5 py-1.5 text-sm">
          <span className="text-xs text-muted-foreground">Date Range</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="bg-transparent text-sm outline-none">
            {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <span className="rounded-md bg-secondary/60 px-2.5 py-1.5 text-sm">Agent · {agent.name}</span>
      </div>

      {tab === "general" && (
        <div className="space-y-4">
          {/* KPI band */}
          <Card>
            <CardContent className="grid grid-cols-2 divide-x divide-border/40 p-0 sm:grid-cols-3 lg:grid-cols-6">
              <Kpi label="Conversations" value={fmt(totalConvos)} active />
              <Kpi label="From widget" value={fmt(widgetConvos)} />
              <Kpi label="Messages" value={fmt(msgs.length)} />
              <Kpi label="Avg CSAT" value={avgRating} />
              <Kpi label="Total LLM cost" value={totalCost ? `€${totalCost.toFixed(2)}` : "—"} />
              <Kpi label="LLM requests" value={fmt(llmRequests)} />
            </CardContent>
          </Card>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <StatCard title="Overall success rate" value={successRate != null ? `${successRate}%` : "—"} hint="Answers grounded in a source" />
            <StatCard title="Average CSAT rating" value={ratings.length ? `${avgRating} / 5` : "—"} hint={`${ratings.length} rating(s)`} />
          </div>
          <Card>
            <CardHeader><CardTitle>Top questions</CardTitle></CardHeader>
            <CardContent>
              {top.length === 0 ? (
                <div className="flex h-32 flex-col items-center justify-center text-sm text-muted-foreground">
                  <BarChart3 className="mb-2 h-7 w-7 opacity-30" /> No data has been collected
                </div>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {top.map(([q, n]) => (
                    <li key={q} className="flex items-center justify-between gap-2">
                      <span className="truncate">{q}</span>
                      <Badge variant="secondary">{n}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "tools" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <NoData title="Total tool calls" />
          <NoData title="Average tool latency" />
          <NoData title="Total tool errors" />
          <NoData title="Average error rate" />
          <div className="lg:col-span-2 rounded-md bg-secondary/40 p-3 text-xs text-muted-foreground">
            This agent answers from its knowledge base and doesn't call external tools yet. Tool analytics will appear here once tool use is enabled.
          </div>
        </div>
      )}

      {tab === "llms" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <StatCard title="Total LLM requests" value={fmt(llmRequests)} />
          <StatCard title="Total tokens" value={fmt(totalTokens)} />
          <StatCard title="Total LLM cost" value={totalCost ? `€${totalCost.toFixed(2)}` : "—"} />
          <StatCard title="Avg cost / request" value={llmRequests ? `€${(totalCost / llmRequests).toFixed(4)}` : "—"} />
        </div>
      )}

      {tab === "knowledge" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <StatCard title="Total document references" value={fmt(docRefs)} hint="Chunks cited across answers" />
          <StatCard title="Answers with sources" value={asstMsgs.length ? `${answeredWithSources} / ${asstMsgs.length}` : "—"} />
          <StatCard title="Indexed chunks" value={fmt(chunks)} />
          <StatCard title="Ready sources" value={fmt(sources.filter((s) => s.status === "ready").length)} />
        </div>
      )}
    </div>
  );
}

// --- Settings -----------------------------------------------------------
function SettingsTab({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: agent.name, description: agent.description ?? "", persona: agent.persona ?? "",
    instructions: agent.instructions ?? "", model: agent.model, temperature: agent.temperature,
    welcome_message: agent.welcome_message ?? "", enabled: agent.enabled, onboarding_enabled: agent.onboarding_enabled,
    accent_color: agent.accent_color ?? "#001BB7",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true); setSaved(false);
    try {
      await supabase.from("rag_agents").update({ ...form, updated_at: new Date().toISOString() }).eq("id", agent.id);
      queryClient.invalidateQueries({ queryKey: ["rag_agent", agent.id] });
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } finally { setSaving(false); }
  }

  function upd<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm((f) => ({ ...f, [k]: v })); }

  return (
    <Card className="max-w-2xl">
      <CardContent className="space-y-3 p-5">
        <div className="flex items-end gap-3">
          <div className="flex-1"><label className="mb-1 block text-xs text-muted-foreground">Name</label><Input value={form.name} onChange={(e) => upd("name", e.target.value)} /></div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Accent color</label>
            <input type="color" value={form.accent_color} onChange={(e) => upd("accent_color", e.target.value)} className="h-10 w-12 cursor-pointer rounded-md border border-border bg-transparent p-0.5" title="Card accent color" />
          </div>
        </div>
        <div><label className="mb-1 block text-xs text-muted-foreground">Description</label><Input value={form.description} onChange={(e) => upd("description", e.target.value)} /></div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Persona</label>
          <Input value={form.persona} onChange={(e) => upd("persona", e.target.value)} placeholder="You are a friendly support agent for…" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Extra instructions</label>
          <textarea value={form.instructions} onChange={(e) => upd("instructions", e.target.value)} rows={3} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Welcome message</label>
          <Input value={form.welcome_message} onChange={(e) => upd("welcome_message", e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Model</label>
            <select value={form.model} onChange={(e) => upd("model", e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="groq">Groq (fast)</option>
              <option value="deepseek">DeepSeek (deep)</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Temperature ({form.temperature})</label>
            <input type="range" min={0} max={1} step={0.1} value={form.temperature} onChange={(e) => upd("temperature", Number(e.target.value))} className="mt-2 w-full accent-primary" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" checked={form.onboarding_enabled} onChange={(e) => upd("onboarding_enabled", e.target.checked)} /> Enable onboarding mode (guide users through the SaaS UI)</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" checked={form.enabled} onChange={(e) => upd("enabled", e.target.checked)} /> Agent enabled (widget active)</label>
        <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : <Check className="h-4 w-4" />} {saved ? "Saved" : "Save settings"}</Button>
      </CardContent>
    </Card>
  );
}
