import { useState, useRef, useEffect, forwardRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Bot, BarChart3,
  Plus, Trash2, Send, FileText, Link2, LayoutGrid, Check, Copy, Sparkles, BookOpen, Search,
  Globe, FileUp, Type, RotateCcw, Store, RefreshCw, Package, Plug,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  SoftField, SoftInput, SoftTextarea, SoftSelect, SoftToggle, SoftRange,
  SoftColor, SoftNumber, SoftCheckbox, SoftComposerInput,
} from "@/components/ui/soft-form";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { GrainOverlay, CardLoaderDots } from "@/components/ui/card-9";
import { GoalsStudioPage } from "@/features/agent-rag/onboarding/GoalsStudio";
import { ActivationCockpitPage } from "@/features/agent-rag/onboarding/ActivationCockpit";

// This file used to BE a page (/agent/builder/:id/:tab) with its own sidebar.
// A public agent now lives in the service dashboard that owns it, exactly like
// an internal one, so what is left here are the six tabs themselves — the
// chrome around them belongs to the dashboard (PublicAgentInDashboard).
export type PublicAgentTab = "knowledge" | "playground" | "widget" | "analytics" | "onboarding" | "ecommerce" | "settings";

export interface Agent {
  id: string; project_id: string; name: string; description: string | null; persona: string | null;
  instructions: string | null; model: string; temperature: number;
  welcome_message: string | null; widget_config: any; public_key: string;
  enabled: boolean; onboarding_enabled: boolean; onboarding_copilot_enabled: boolean;
  onboarding_voice_enabled: boolean; onboarding_voice_model: string | null; accent_color: string | null;
  // Tool use via MCP (0201) — see the E-commerce tab.
  tool_use_enabled: boolean; max_tool_calls: number; storefront_url: string | null;
}
interface Source { id: string; type: string; title: string; status: string; chunk_count: number; byte_size?: number; error_message: string | null; created_at: string; }

// Onboarding is a conditional tab — only surfaced when the agent has the
// onboarding feature toggled on (see SettingsTab). The base builder is
// otherwise identical for every public agent.
export const VALID_PUBLIC_AGENT_TABS: PublicAgentTab[] = ["knowledge", "playground", "widget", "analytics", "onboarding", "ecommerce", "settings"];

/** The tab bodies, dispatched by slug. Fetching the agent and drawing the tab
 *  strip is the host's job. */
export function PublicAgentTabBody({ agent, tab, workspaceId, projectId }: {
  agent: Agent; tab: PublicAgentTab; workspaceId: string | null; projectId: string | null;
}) {
  // The onboarding tab only exists while the feature is on — a stale/direct
  // link falls back to the playground.
  const effectiveTab: PublicAgentTab = tab === "onboarding" && !agent.onboarding_enabled ? "playground" : tab;

  return (
    <div>
      {effectiveTab === "knowledge" && <KnowledgeTab agent={agent} workspaceId={workspaceId} projectId={projectId} />}
      {effectiveTab === "playground" && <PlaygroundTab agent={agent} workspaceId={workspaceId} projectId={projectId} />}
      {effectiveTab === "widget" && <WidgetTab agent={agent} />}
      {effectiveTab === "analytics" && <PublicAnalyticsTab agent={agent} />}
      {effectiveTab === "onboarding" && <OnboardingTab agent={agent} />}
      {effectiveTab === "ecommerce" && <EcommerceTab agent={agent} workspaceId={workspaceId} projectId={projectId} />}
      {effectiveTab === "settings" && <PublicSettingsTab agent={agent} />}
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
    const MAX_BYTES = 15 * 1024 * 1024; // keep in sync with rag-extract-file
    try {
      for (const file of Array.from(files)) {
        // Validate client-side so oversized files fail with a clear message
        // instead of a generic network "Failed to fetch" mid-upload.
        if (file.size > MAX_BYTES) {
          throw new Error(`"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB — the limit is 15 MB.`);
        }

        const path = `${projectId}/${agent.id}/${Date.now()}-${file.name.replace(/[^\w.\-]/g, "_")}`;

        // 1) Upload to Storage.
        try {
          const { error: upErr } = await supabase.storage
            .from("rag-docs")
            .upload(path, file, { upsert: false, contentType: file.type || "application/octet-stream" });
          if (upErr) throw new Error(upErr.message);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(
            /failed to fetch|networkerror|load failed/i.test(msg)
              ? `Upload of "${file.name}" was blocked by the network (CORS or connection). Check your connection and that this domain is allowed in Supabase Storage CORS.`
              : `Upload failed for "${file.name}": ${msg}`,
          );
        }

        // 2) Server-side extraction + embedding.
        try {
          await callEdge("rag-extract-file", {
            workspace_id: workspaceId, project_id: projectId, agent_id: agent.id,
            title: file.name, storage_path: path, mime: file.type,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(
            /failed to fetch|networkerror|load failed/i.test(msg)
              ? `Extraction request for "${file.name}" could not reach the server (network/CORS). The file did upload — retry to process it.`
              : `Could not process "${file.name}": ${msg}`,
          );
        }
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
        <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <SoftInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher…" className="pl-10" />
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
        <motion.div layout className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence mode="popLayout">
            {filtered.map((src) => (
              <KnowledgeCard key={src.id} source={src} onRemove={() => removeSource(src.id)} />
            ))}
          </AnimatePresence>
        </motion.div>
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

/**
 * A knowledge source, in the card-9 visual language: matte grain, soft 2xl
 * corners, a motion entrance, and the delete affordance top-right.
 *
 * It borrows PromoCard's LOOK, not its markup — PromoCard is a single promo
 * panel declaring role="dialog" aria-modal="true", which on a grid of twenty
 * documents would announce twenty modal dialogs to a screen reader. This is an
 * article in a list, so that is what it says it is.
 */
const KnowledgeCard = forwardRef<HTMLElement, { source: Source; onRemove: () => void }>(function KnowledgeCard({ source, onRemove }, ref) {
  const Icon = sourceIcon(source.type);
  const pending = source.status === "processing" || source.status === "pending";
  const failed = source.status === "failed";

  return (
    <motion.article
      ref={ref}
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20, transition: { duration: 0.2 } }}
      transition={{ duration: 0.35, ease: "easeInOut" }}
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-lg",
        failed && "border-destructive/40",
      )}
    >
      <GrainOverlay />

      <Button
        size="icon"
        variant="ghost"
        aria-label={`Supprimer ${source.title}`}
        onClick={onRemove}
        className="absolute right-3 top-3 z-20 h-8 w-8 rounded-full text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>

      <div className="relative z-10 flex h-full flex-col p-5">
        {/* While a source is being vectorised the card runs the family's loader
            dots, so a grid mid-ingest reads as working rather than stalled. */}
        {pending ? (
          <CardLoaderDots />
        ) : (
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-muted/70">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </span>
        )}

        <div className="mt-4 flex-grow">
          <p className="mb-1 text-xs font-medium capitalize text-muted-foreground">
            {source.type.replace("_", " ")}
          </p>
          <h3 className="line-clamp-2 text-base font-semibold leading-snug tracking-tight" title={source.title}>
            {source.title}
          </h3>
          {source.error_message && (
            <p className="mt-1.5 line-clamp-2 text-xs text-destructive" title={source.error_message}>
              {source.error_message}
            </p>
          )}
        </div>

        <div className="mt-5 flex flex-shrink-0 items-center gap-2">
          <Badge variant={source.status === "ready" ? "success" : failed ? "destructive" : "secondary"}>
            {source.status === "ready" ? `${source.chunk_count} chunks` : source.status}
          </Badge>
          {source.byte_size ? (
            <span className="text-xs text-muted-foreground">{fmtBytes(source.byte_size)}</span>
          ) : null}
        </div>
      </div>
    </motion.article>
  );
});


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
        <DialogHeader><DialogTitle>Ajouter un document</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <SoftSegmented
            value={type}
            onChange={(v) => setType(v)}
            options={SOURCE_TYPES.map((t) => ({ value: t.value, label: t.label }))}
          />
          {type !== "saas_structure" && <SoftInput placeholder="Titre" value={title} onChange={(e) => setTitle(e.target.value)} />}
          {type === "text" && (
            <SoftTextarea placeholder="Collez du texte, une FAQ, une doc…" value={content} onChange={(e) => setContent(e.target.value)} rows={6} />
          )}
          {type === "url" && <SoftInput placeholder="https://docs.exemple.com/page" value={url} onChange={(e) => setUrl(e.target.value)} />}
          {type === "saas_structure" && (
            <p className="rounded-xl bg-muted/50 p-3.5 text-xs text-muted-foreground">
              Importe les pages de votre app depuis le dernier scan de code. Lancez un scan d'abord.
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button className="rounded-full" onClick={ingest} disabled={busy || (type === "text" && !content) || (type === "url" && !url)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Vectoriser
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
    // The dotted ground reads as a canvas. It is a panel of its own rather than
    // a full-bleed layer, so it doesn't depend on the padding of whatever hosts
    // this tab (the host's floating tab bar changes it).
    <div
      className="grid grid-cols-1 gap-4 rounded-2xl border border-border/60 p-5 lg:grid-cols-[320px_1fr]"
      style={{ backgroundImage: "radial-gradient(hsl(var(--muted-foreground)/0.18) 1px, transparent 1px)", backgroundSize: "16px 16px" }}
    >
      {/* Left config panel */}
      <div className="space-y-4">
        <div className="rounded-2xl bg-muted/50 p-3.5">
          <div className={`flex items-center gap-2 text-sm font-medium ${trained ? "text-emerald-500" : "text-muted-foreground"}`}>
            <span className={`h-2 w-2 rounded-full ${trained ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
            {trained ? "Entraîné" : "Pas encore entraîné"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {stats ? `${stats.ready}/${stats.total} sources · ${stats.chunks} chunks · ${fmtBytes(stats.bytes)}` : "—"}
          </div>
        </div>

        <SoftField label="Modèle">
          <SoftSelect
            value={model}
            onChange={setModel}
            options={[
              { value: "groq", label: "Groq — Llama 3.3 70B" },
              { value: "deepseek", label: "DeepSeek" },
            ]}
          />
        </SoftField>

        <SoftField label="Instructions">
          <SoftTextarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={10}
            placeholder="## Rôle&#10;- Tu es…"
          />
        </SoftField>

        <Button onClick={saveCfg} disabled={savingCfg} className="w-full rounded-full">
          {savingCfg ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Enregistrer
        </Button>
      </div>

      {/* Right chat panel */}
      <div className="flex justify-center">
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
          <div className="px-4 pb-1 text-center text-[10px] text-muted-foreground">Powered by Anduran</div>
          <div className="flex items-center gap-2 border-t border-border p-3">
            <SoftComposerInput
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Message…"
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
// Mirrored by DEFAULTS in public/widget.js — the embed reads exactly these keys,
// so a knob added here needs the matching read there or it does nothing.
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

// Section row: its name on the left, its controls on the right. No description
// line — the control labels already say what each one does.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 border-b border-border/40 py-6 lg:grid-cols-[200px_1fr]">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-3">
      <label className="text-sm text-muted-foreground">{label}</label>
      <SoftColor value={value} onChange={onChange} />
    </div>
  );
}

function RadiusRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-3">
      <label className="text-sm text-muted-foreground">{label}</label>
      <SoftNumber value={value} onChange={onChange} unit="px" min={0} max={64} />
    </div>
  );
}

function TextRow({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-center gap-3">
      <label className="font-mono text-xs text-muted-foreground">{label}</label>
      <SoftInput value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Segmented picker — the pill row used for variant / placement / avatar type. */
function SoftSegmented<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-full bg-muted/50 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-full px-4 py-1.5 text-sm capitalize transition-colors",
            value === o.value ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function WidgetTab({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  // The agent's brand colour (Settings tab) seeds the accent and the avatar orb,
  // so an agent that was never opened here still embeds in its own colour
  // instead of the generic default — which is what widget.js falls back to too.
  const [cfg, setCfg] = useState<Record<string, any>>({
    ...WIDGET_DEFAULTS,
    accent: agent.accent_color ?? WIDGET_DEFAULTS.accent,
    avatar_first: agent.accent_color ?? WIDGET_DEFAULTS.avatar_first,
    avatar_second: agent.accent_color ?? WIDGET_DEFAULTS.avatar_second,
    ...(agent.widget_config ?? {}),
  });
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function set<K extends string>(k: K, v: any) { setCfg((c) => ({ ...c, [k]: v })); }

  // The widget is served as a single script tag with attributes — works in
  // every framework. Build the embed snippets per framework.
  const WIDGET_URL = "https://founderos-peach.vercel.app/widget.js";
  const oneLiner = `<script src="${WIDGET_URL}" data-agent="${agent.public_key}" defer></script>`;
  const reactSnippet = `import { useEffect } from "react";

export function FounderOSAgent() {
  useEffect(() => {
    const s = document.createElement("script");
    s.src = "${WIDGET_URL}";
    s.dataset.agent = "${agent.public_key}";
    s.defer = true;
    document.body.appendChild(s);
    return () => { s.remove(); };
  }, []);
  return null;
}`;
  const vueSnippet = `<!-- App.vue -->
<script setup>
import { onMounted } from "vue";
onMounted(() => {
  const s = document.createElement("script");
  s.src = "${WIDGET_URL}";
  s.dataset.agent = "${agent.public_key}";
  s.defer = true;
  document.body.appendChild(s);
});
</script>`;
  const angularSnippet = `// app.component.ts
ngOnInit() {
  const s = document.createElement("script");
  s.src = "${WIDGET_URL}";
  s.dataset["agent"] = "${agent.public_key}";
  s.defer = true;
  document.body.appendChild(s);
}`;
  const nextSnippet = `// app/layout.tsx (Next.js 13+ App Router)
import Script from "next/script";

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Script
          src="${WIDGET_URL}"
          data-agent="${agent.public_key}"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}`;
  const phpSnippet = `<!-- footer.php (WordPress / Laravel / any PHP template) -->
<script src="${WIDGET_URL}" data-agent="${agent.public_key}" defer></script>`;
  const wpSnippet = `// functions.php — enqueue the widget on every page
add_action("wp_footer", function () {
  echo '<script src="${WIDGET_URL}" data-agent="${agent.public_key}" defer></script>';
});`;
  const SNIPPETS: Record<string, string> = {
    HTML: oneLiner,
    React: reactSnippet,
    "Next.js": nextSnippet,
    Vue: vueSnippet,
    Angular: angularSnippet,
    PHP: phpSnippet,
    WordPress: wpSnippet,
  };
  const FRAMEWORKS = Object.keys(SNIPPETS);

  async function save() {
    setSaving(true); setSaved(false);
    try {
      await supabase.from("rag_agents").update({ widget_config: cfg }).eq("id", agent.id);
      queryClient.invalidateQueries({ queryKey: ["rag_agent", agent.id] });
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } finally { setSaving(false); }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="min-w-0">
      {/* No "Widget" title — the tab you clicked already said it. */}
      <div className="mb-2 flex items-center justify-end">
        <Button onClick={save} disabled={saving} className="rounded-full">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {saved ? "Enregistré" : "Enregistrer"}
        </Button>
      </div>

      {/* Setup / Embed */}
      <Section title="Intégration">
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Balise à coller</div>
          <pre className="overflow-x-auto whitespace-pre rounded-xl bg-muted/50 p-3.5 font-mono text-xs leading-relaxed text-foreground/90">{oneLiner}</pre>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 rounded-full"
            onClick={() => {
              navigator.clipboard.writeText(oneLiner);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
            {copied ? "Copié" : "Copier"}
          </Button>
        </div>

        {/* Framework-specific variants */}
        <FrameworkSnippets snippets={SNIPPETS} frameworks={FRAMEWORKS} />

        <SoftField label="Clé publique">
          <code className="block truncate rounded-xl bg-muted/50 px-3.5 py-2.5 font-mono text-xs">{agent.public_key}</code>
        </SoftField>
        <SoftToggle label="Collecte des avis" checked={cfg.feedback} onChange={(v) => set("feedback", v)} />
      </Section>

      {/* Interface */}
      <Section title="Interface">
        <SoftToggle label="Repliable" checked={cfg.collapsible} onChange={(v) => set("collapsible", v)} />
        <SoftToggle label="Afficher le branding" checked={cfg.show_branding} onChange={(v) => set("show_branding", v)} />
        <SoftField label="Variante">
          <SoftSegmented
            value={cfg.variant}
            onChange={(v) => set("variant", v)}
            options={[{ value: "tiny", label: "tiny" }, { value: "compact", label: "compact" }, { value: "full", label: "full" }]}
          />
        </SoftField>
        <SoftField label="Icône du lanceur">
          <SoftSegmented
            value={cfg.launcher_icon}
            onChange={(v) => set("launcher_icon", v)}
            options={[{ value: "chat", label: "chat" }, { value: "help", label: "help" }, { value: "sparkle", label: "sparkle" }]}
          />
        </SoftField>
        <SoftField label="Position">
          <SoftSelect
            className="max-w-xs"
            value={cfg.placement}
            onChange={(v) => set("placement", v)}
            options={[
              { value: "bottom-right", label: "En bas à droite" },
              { value: "bottom-left", label: "En bas à gauche" },
            ]}
          />
        </SoftField>
        <SoftField label="Questions suggérées">
          <SoftTextarea
            value={cfg.suggested_questions}
            onChange={(e) => set("suggested_questions", e.target.value)}
            rows={3}
            placeholder={"Une par ligne\nComment démarrer ?\nQuels sont vos tarifs ?"}
          />
        </SoftField>
      </Section>

      {/* Styling */}
      <Section title="Style">
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
      <Section title="Avatar">
        <SoftSegmented
          value={cfg.avatar_type}
          onChange={(v) => set("avatar_type", v)}
          options={[{ value: "orb", label: "orb" }, { value: "image", label: "image" }]}
        />
        {cfg.avatar_type === "orb" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ColorRow label="Couleur 1" value={cfg.avatar_first} onChange={(v) => set("avatar_first", v)} />
            <ColorRow label="Couleur 2" value={cfg.avatar_second} onChange={(v) => set("avatar_second", v)} />
          </div>
        ) : (
          <SoftInput placeholder="URL de l'image" value={cfg.avatar_url} onChange={(e) => set("avatar_url", e.target.value)} />
        )}
      </Section>

      {/* Terms & Conditions */}
      <Section title="Conditions">
        <SoftToggle label="Accepter les conditions avant de discuter" checked={cfg.terms_enabled} onChange={(v) => set("terms_enabled", v)} />
        {cfg.terms_enabled && (
          <SoftField label="Texte (Markdown)">
            <SoftTextarea value={cfg.terms_content} onChange={(e) => set("terms_content", e.target.value)} rows={5} />
          </SoftField>
        )}
      </Section>

      {/* Text contents */}
      <Section title="Libellés">
        <TextRow label="main_label" value={cfg.text_main_label} placeholder="Besoin d'aide ?" onChange={(v) => set("text_main_label", v)} />
        <TextRow label="start_chat" value={cfg.text_start_chat} placeholder="Démarrer" onChange={(v) => set("text_start_chat", v)} />
        <TextRow label="send" value={cfg.text_send} placeholder="Envoyer" onChange={(v) => set("text_send", v)} />
        <TextRow label="placeholder" value={cfg.text_placeholder} placeholder="Votre message…" onChange={(v) => set("text_placeholder", v)} />
      </Section>
      </div>

      <WidgetPreview agent={agent} cfg={cfg} />
    </div>
  );
}

/** Live preview of the embed. It runs the *real* public/widget.js in an iframe
 *  rather than re-implementing the chat in React: a second implementation is
 *  exactly how the embed drifted away from what this panel promised. The unsaved
 *  form state is pushed over postMessage, so the preview reacts without
 *  remounting (and without re-fetching the agent config) on every edit. */
function WidgetPreview({ agent, cfg }: { agent: Agent; cfg: Record<string, any> }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);

  // Same file the customer's site loads. In dev it is served by Vite from
  // public/, in prod by the deploy — either way it is same-origin here.
  const src = `${window.location.origin}/widget.js`;

  const srcDoc =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>` +
    `</head><body>` +
    `<script src="${src}" data-agent="${agent.public_key}" data-preview="1" data-onboarding="off"><\/script>` +
    `</body></html>`;

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === "founderos:preview-ready") setReady(true);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!ready) return;
    frameRef.current?.contentWindow?.postMessage({ type: "founderos:preview-config", config: cfg }, "*");
  }, [cfg, ready]);

  // Keep the frame tall enough for the chosen variant (see VARIANT_SIZE in
  // widget.js) plus a little breathing room.
  const height = cfg.variant === "tiny" ? 470 : cfg.variant === "compact" ? 550 : 650;

  return (
    <div className="xl:sticky xl:top-4 xl:self-start">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" />
        Aperçu en direct
      </div>
      <div
        className="flex items-center justify-center rounded-2xl border border-border/60 p-4"
        style={{ backgroundImage: "radial-gradient(hsl(var(--muted-foreground)/0.18) 1px, transparent 1px)", backgroundSize: "16px 16px" }}
      >
        <iframe
          ref={frameRef}
          title="Aperçu du widget"
          srcDoc={srcDoc}
          className="w-full rounded-xl border-0"
          style={{ height, colorScheme: "light" }}
        />
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Le vrai widget, branché sur l'agent : les messages envoyés ici comptent comme des conversations réelles.
      </p>
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
      <div className="font-stat-number mt-1 text-lg font-semibold tabular-nums">{value}</div>
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
        <div className="font-stat-number mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function PublicAnalyticsTab({ agent }: { agent: Agent }) {
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
      <div className="mb-4">
        <SoftSelect
          className="max-w-[13rem]"
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
          options={RANGES.map((r) => ({ value: String(r.value), label: r.label }))}
        />
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
// --- Onboarding (conditional tab) ---------------------------------------
// Only mounted when `agent.onboarding_enabled` is on. Groups the onboarding
// agent's controls: natural-language objectives, agent-level réglages
// (co-pilot / voice / voice model + per-goal guardrails) and activation
// analytics — all scoped to THIS agent.
const ONB_SUBTABS = [
  { value: "goals", label: "Objectifs" },
  { value: "settings", label: "Réglages" },
  { value: "activation", label: "Activation" },
] as const;
type OnbSubtab = (typeof ONB_SUBTABS)[number]["value"];

// Deepgram Aura voices offered for the spoken onboarding guide.
const AURA_VOICES = [
  { value: "aura-asteria-en", label: "Asteria (f · en)" },
  { value: "aura-luna-en", label: "Luna (f · en)" },
  { value: "aura-stella-en", label: "Stella (f · en)" },
  { value: "aura-athena-en", label: "Athena (f · en)" },
  { value: "aura-hera-en", label: "Hera (f · en)" },
  { value: "aura-orion-en", label: "Orion (m · en)" },
  { value: "aura-arcas-en", label: "Arcas (m · en)" },
  { value: "aura-perseus-en", label: "Perseus (m · en)" },
  { value: "aura-angus-en", label: "Angus (m · en)" },
  { value: "aura-zeus-en", label: "Zeus (m · en)" },
];

function OnboardingTab({ agent }: { agent: Agent }) {
  const [sub, setSub] = useState<OnbSubtab>("goals");
  return (
    <div>
      {/* Sub-tabs */}
      <div className="mb-4 flex flex-wrap gap-4 border-b border-border/40">
        {ONB_SUBTABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setSub(t.value)}
            className={`-mb-px border-b-2 pb-2 text-sm transition-colors ${sub === t.value ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {sub === "goals" && <GoalsStudioPage agentId={agent.id} />}
      {sub === "settings" && <OnboardingSettings agent={agent} />}
      {sub === "activation" && <ActivationCockpitPage agentId={agent.id} />}
    </div>
  );
}

function OnboardingSettings({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();

  // Agent-level onboarding switches.
  const [copilot, setCopilot] = useState(agent.onboarding_copilot_enabled);
  const [voice, setVoice] = useState(agent.onboarding_voice_enabled);
  const [voiceModel, setVoiceModel] = useState(agent.onboarding_voice_model ?? "aura-asteria-en");
  const [savingAgent, setSavingAgent] = useState(false);
  const [savedAgent, setSavedAgent] = useState(false);

  async function saveAgent() {
    setSavingAgent(true); setSavedAgent(false);
    try {
      await supabase.from("rag_agents").update({
        onboarding_copilot_enabled: copilot,
        onboarding_voice_enabled: voice,
        onboarding_voice_model: voiceModel,
        updated_at: new Date().toISOString(),
      }).eq("id", agent.id);
      queryClient.invalidateQueries({ queryKey: ["rag_agent", agent.id] });
      // Keep the inline toggles in GoalDetailView in sync.
      queryClient.invalidateQueries({ queryKey: ["onb_agent_voice", agent.id] });
      queryClient.invalidateQueries({ queryKey: ["onb_agent_copilot", agent.id] });
      setSavedAgent(true); setTimeout(() => setSavedAgent(false), 1500);
    } finally { setSavingAgent(false); }
  }

  // Guardrails live on a goal's `constraints` (the co-pilot brief reads them).
  const { data: goals } = useQuery({
    queryKey: ["onb_settings_goals", agent.id],
    enabled: !!agent.id,
    queryFn: async () => {
      const { data } = await supabase.from("onboarding_goals")
        .select("id, name, constraints")
        .eq("agent_id", agent.id).order("created_at", { ascending: false });
      return (data ?? []) as { id: string; name: string; constraints: Record<string, unknown> }[];
    },
  });

  const [goalId, setGoalId] = useState<string>("");
  const activeGoal = (goals ?? []).find((g) => g.id === goalId) ?? (goals ?? [])[0];
  useEffect(() => {
    if (!goalId && goals && goals.length > 0) setGoalId(goals[0]!.id);
  }, [goals, goalId]);

  const [tone, setTone] = useState("");
  const [noBlock, setNoBlock] = useState(false);
  const [locale, setLocale] = useState("");
  const [maxNudges, setMaxNudges] = useState<number | "">("");
  const [savingGuard, setSavingGuard] = useState(false);
  const [savedGuard, setSavedGuard] = useState(false);

  // Load the selected goal's constraints into the form.
  useEffect(() => {
    const c = (activeGoal?.constraints ?? {}) as Record<string, any>;
    setTone(typeof c.tone === "string" ? c.tone : "");
    setNoBlock(!!c.no_block);
    setLocale(typeof c.locale === "string" ? c.locale : "");
    setMaxNudges(typeof c.max_nudges_per_session === "number" ? c.max_nudges_per_session : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGoal?.id]);

  async function saveGuardrails() {
    if (!activeGoal) return;
    setSavingGuard(true); setSavedGuard(false);
    try {
      const prev = (activeGoal.constraints ?? {}) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...prev, no_block: noBlock };
      if (tone.trim()) next.tone = tone.trim(); else delete next.tone;
      if (locale.trim()) next.locale = locale.trim(); else delete next.locale;
      if (maxNudges === "") delete next.max_nudges_per_session; else next.max_nudges_per_session = Number(maxNudges);
      await supabase.from("onboarding_goals").update({ constraints: next }).eq("id", activeGoal.id);
      queryClient.invalidateQueries({ queryKey: ["onb_settings_goals", agent.id] });
      setSavedGuard(true); setTimeout(() => setSavedGuard(false), 1500);
    } finally { setSavingGuard(false); }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      {/* Agent onboarding switches */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Guide</h2>
        <SoftToggle label="Co-pilote agentique" checked={copilot} onChange={setCopilot} />
        <SoftToggle label="Guide parlé" checked={voice} onChange={setVoice} />
        <SoftField label="Voix de synthèse" className={cn(!voice && "opacity-50")}>
          <SoftSelect
            value={voiceModel}
            onChange={setVoiceModel}
            disabled={!voice}
            options={AURA_VOICES.map((v) => ({ value: v.value, label: v.label }))}
          />
        </SoftField>
        <Button onClick={saveAgent} disabled={savingAgent} className="rounded-full">
          {savingAgent ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {savedAgent ? "Enregistré" : "Enregistrer"}
        </Button>
      </section>

      {/* Guardrails on the active goal's constraints */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Garde-fous</h2>
          {(goals ?? []).length > 1 && (
            <SoftSelect
              className="max-w-[14rem]"
              align="end"
              value={goalId}
              onChange={setGoalId}
              options={(goals ?? []).map((g) => ({ value: g.id, label: g.name }))}
            />
          )}
        </div>
        {!activeGoal ? (
          <p className="text-xs text-muted-foreground">Créez un objectif pour définir ses garde-fous.</p>
        ) : (
          <>
            <SoftField label="Ton">
              <SoftInput value={tone} onChange={(e) => setTone(e.target.value)} placeholder="chaleureux, concis…" />
            </SoftField>
            <SoftToggle label="Ne pas bloquer l'écran" checked={noBlock} onChange={setNoBlock} />
            <div className="grid grid-cols-2 gap-4">
              <SoftField label="Locale">
                <SoftInput value={locale} onChange={(e) => setLocale(e.target.value)} placeholder="fr-FR" />
              </SoftField>
              <SoftField label="Relances max / session">
                <SoftInput type="number" min={0} value={maxNudges} onChange={(e) => setMaxNudges(e.target.value === "" ? "" : Number(e.target.value))} placeholder="3" />
              </SoftField>
            </div>
            <Button onClick={saveGuardrails} disabled={savingGuard} className="rounded-full">
              {savingGuard ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {savedGuard ? "Enregistré" : "Enregistrer"}
            </Button>
          </>
        )}
      </section>
    </div>
  );
}

// --- E-commerce (MCP-backed) --------------------------------------------
// A public agent reaches a catalogue — and gets ACTIONS — through MCP servers,
// not a bespoke REST integration per platform. Shopify's Storefront MCP is the
// reference case: one unauthenticated endpoint per store
// (https://{shop}/api/mcp) exposing catalogue search and cart operations.
//
// The workspace MCP registry (mcp_servers) is shared with the internal agents;
// what this tab owns is the attach side (rag_agent_mcp_servers) and, above all,
// the per-tool allowlist — a public agent is driven by anonymous traffic, so
// "the server exposes it" is not the same as "the agent may call it".
const MCP_STORE_PRESETS = [
  {
    key: "shopify",
    label: "Shopify — Storefront MCP",
    /** Per-store endpoint; only the shop domain varies. */
    url: (domain: string) => `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/api/mcp`,
    domainPlaceholder: "ma-boutique.myshopify.com",
    auth: "none" as const,
    help: "Endpoint public de votre boutique — aucune clé à fournir. Il expose la recherche catalogue et les opérations de panier.",
  },
  {
    key: "custom",
    label: "Autre serveur MCP",
    url: (raw: string) => raw.trim(),
    domainPlaceholder: "https://mon-serveur/mcp",
    auth: "header" as const,
    help: "Collez l'URL complète du serveur MCP (Streamable HTTP ou SSE). Ajoutez un en-tête d'authentification si le serveur en exige un.",
  },
];

interface McpServerRow {
  id: string; name: string; url: string; enabled: boolean;
  status: string | null; last_error: string | null;
  cached_tools: { name: string; description?: string }[] | null;
}
interface AttachRow { server_id: string; allowed_tools: string[] }

/** The tables and columns this tab writes to arrive with migration 0201. Until
 *  it is applied every toggle fails, and Postgres says so precisely — surfacing
 *  that beats a switch that silently refuses to move. */
function schemaMissing(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  return e.code === "42703" || e.code === "PGRST205" || e.code === "42P01"
    || /does not exist|schema cache/i.test(e.message ?? "");
}
function writeError(err: unknown): string {
  if (schemaMissing(err)) {
    return "La migration 0201 n'est pas encore appliquée sur cette base — lancez `supabase db push`, puis rechargez la page.";
  }
  const e = err as { message?: string } | null;
  return e?.message || "Échec de l'enregistrement.";
}

/** Compact switch for a list row, where a full-width SoftToggle would render as
 *  a large empty block (its label carries the width). */
function MiniSwitch({ checked, onChange, title }: {
  checked: boolean; onChange: (v: boolean) => void; title?: string;
}) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} title={title}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        checked ? "bg-primary" : "bg-border hover:bg-muted-foreground/30",
      )}
    >
      <span className={cn(
        "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
        checked && "translate-x-4",
      )} />
    </button>
  );
}

const ECOM_SUBTABS = [
  { value: "servers", label: "Boutique" },
  { value: "tools", label: "Outils" },
  { value: "activity", label: "Activité" },
] as const;
type EcomSubtab = (typeof ECOM_SUBTABS)[number]["value"];

function EcommerceTab({ agent, workspaceId }: {
  agent: Agent; workspaceId: string | null; projectId: string | null;
}) {
  const [sub, setSub] = useState<EcomSubtab>("servers");

  const { data: servers, refetch: refetchServers } = useQuery({
    queryKey: ["pa_mcp_servers", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("mcp_servers").select("id, name, url, enabled, status, last_error, cached_tools")
        .eq("workspace_id", workspaceId!).order("created_at");
      return (data ?? []) as McpServerRow[];
    },
  });

  const { data: attached, refetch: refetchAttached, error: attachError } = useQuery({
    queryKey: ["pa_mcp_attached", agent.id],
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rag_agent_mcp_servers").select("server_id, allowed_tools").eq("agent_id", agent.id);
      if (error) throw error;
      return (data ?? []) as AttachRow[];
    },
  });

  const refetchAll = () => { refetchServers(); refetchAttached(); };

  // Without the migration nothing on this tab can save. Say so once, at the top,
  // instead of letting three sets of controls fail quietly.
  const needsMigration = schemaMissing(attachError);

  // Attaching a server is only two thirds of the job: tool use must be on AND at
  // least one tool ticked. Miss either and the agent silently stays a plain RAG
  // answerer — it will say "je n'ai pas d'information sur les produits" with
  // full confidence, which reads like a bug rather than a missing switch.
  const grantedCount = (attached ?? []).reduce((n, a) => n + (a.allowed_tools?.length ?? 0), 0);
  const inertReason = !needsMigration && (attached ?? []).length > 0
    ? (!agent.tool_use_enabled
        ? "« Autoriser cet agent à appeler des outils » est désactivé (onglet Boutique)."
        : grantedCount === 0
          ? "Aucun outil n'est coché (onglet Outils) — une liste vide n'autorise rien."
          : null)
    : null;

  return (
    <div className="mx-auto w-full max-w-3xl">
      {needsMigration && (
        <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs leading-relaxed">
          <div className="font-semibold text-amber-600 dark:text-amber-400">Schéma manquant</div>
          <p className="mt-1 text-muted-foreground">
            Les tables de cet onglet (<code className="font-mono">rag_agent_mcp_servers</code>,{" "}
            <code className="font-mono">rag_agents.tool_use_enabled</code>) n'existent pas encore sur
            cette base : les interrupteurs ci-dessous ne pourront rien enregistrer. Appliquez la
            migration <code className="font-mono">0201_public_agent_mcp.sql</code> avec{" "}
            <code className="font-mono">supabase db push</code>, puis rechargez la page.
          </p>
        </div>
      )}
      {inertReason && (
        <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs leading-relaxed">
          <div className="font-semibold text-amber-600 dark:text-amber-400">
            Serveur connecté, mais l'agent n'appellera aucun outil
          </div>
          <p className="mt-1 text-muted-foreground">
            {inertReason} Tant que c'est le cas, l'agent répond uniquement depuis sa base de
            connaissances et dira qu'il n'a pas d'information sur vos produits.
          </p>
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-4 border-b border-border/40">
        {ECOM_SUBTABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setSub(t.value)}
            className={`-mb-px border-b-2 pb-2 text-sm transition-colors ${sub === t.value ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {sub === "servers" && (
        <McpStoreServers
          agent={agent} workspaceId={workspaceId}
          servers={servers ?? []} attached={attached ?? []} onChanged={refetchAll}
        />
      )}
      {sub === "tools" && (
        <McpToolGrants
          agent={agent} servers={servers ?? []} attached={attached ?? []} onChanged={refetchAll}
        />
      )}
      {sub === "activity" && <McpToolActivity agent={agent} />}
    </div>
  );
}

function McpStoreServers({ agent, workspaceId, servers, attached, onChanged }: {
  agent: Agent; workspaceId: string | null;
  servers: McpServerRow[]; attached: AttachRow[]; onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [presetKey, setPresetKey] = useState("shopify");
  const [input, setInput] = useState("");
  const [name, setName] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const preset = MCP_STORE_PRESETS.find((p) => p.key === presetKey)!;
  const attachedIds = new Set(attached.map((a) => a.server_id));

  // Create the server in the workspace registry, discover its tools, attach it.
  async function connect() {
    if (!workspaceId || !input.trim()) return;
    setBusy(true); setError(null); setOkMsg(null);
    try {
      const url = preset.url(input);
      if (!/^https?:\/\//i.test(url)) throw new Error("L'URL doit être absolue (http/https).");

      const headers = presetKey === "custom" && authHeader.trim()
        ? { Authorization: authHeader.trim() }
        : {};

      // Validate before persisting — an unreachable endpoint should not leave a
      // broken server sitting in the registry.
      const test = await callEdge<{ ok: boolean; error?: string; count?: number }>("mcp-gateway", {
        action: "test", url, headers, transport: "http",
      });
      if (!test.ok) throw new Error(test.error || "Le serveur MCP n'a pas répondu.");

      const { data: created, error: insErr } = await supabase
        .from("mcp_servers")
        .insert({
          workspace_id: workspaceId,
          name: name.trim() || defaultName(presetKey, input),
          url, headers, transport: "http",
          auth_mode: Object.keys(headers).length ? "header" : preset.auth,
        })
        .select("id").single();
      if (insErr) throw new Error(insErr.message);

      // Cache the tool list on the row so rag-chat doesn't re-handshake per message.
      await callEdge("mcp-gateway", { action: "discover", server_id: created.id }).catch(() => {});
      const { error: attErr } = await supabase.from("rag_agent_mcp_servers")
        .upsert({ agent_id: agent.id, server_id: created.id, allowed_tools: [] }, { onConflict: "agent_id,server_id" });
      // The server is registered either way; failing to attach it is what would
      // otherwise leave a server visible in the list that nothing can enable.
      if (attErr) throw attErr;

      setInput(""); setName(""); setAuthHeader("");
      setOkMsg(`${test.count ?? 0} outil(s) détecté(s). Choisissez ceux que l'agent peut utiliser dans l'onglet Outils.`);
      onChanged();
    } catch (e) {
      setError(writeError(e));
    } finally { setBusy(false); }
  }

  async function toggleAttach(server: McpServerRow, on: boolean) {
    setError(null);
    const { error: err } = on
      ? await supabase.from("rag_agent_mcp_servers")
          .upsert({ agent_id: agent.id, server_id: server.id, allowed_tools: [] }, { onConflict: "agent_id,server_id" })
      : await supabase.from("rag_agent_mcp_servers")
          .delete().eq("agent_id", agent.id).eq("server_id", server.id);
    if (err) { setError(writeError(err)); return; }
    onChanged();
  }

  async function rediscover(server: McpServerRow) {
    setBusy(true);
    try { await callEdge("mcp-gateway", { action: "discover", server_id: server.id }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); onChanged(); }
  }

  async function saveAgent(patch: Record<string, unknown>) {
    setError(null);
    const { error: err } = await supabase.from("rag_agents").update(patch).eq("id", agent.id);
    if (err) { setError(writeError(err)); return; }
    queryClient.invalidateQueries({ queryKey: ["rag_agent", agent.id] });
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      {/* One error line for the whole panel: the toggles further down write too,
          and an error rendered only next to the connect button would be off
          screen exactly when they fail. */}
      {error && (
        <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Connecter une boutique</h2>
        <SoftSegmented
          value={presetKey}
          onChange={(v) => { setPresetKey(v); setInput(""); setError(null); setOkMsg(null); }}
          options={MCP_STORE_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
        />
        <SoftField label={presetKey === "shopify" ? "Domaine de la boutique" : "URL du serveur MCP"}>
          <SoftInput
            value={input}
            placeholder={preset.domainPlaceholder}
            onChange={(e) => setInput(e.target.value)}
          />
        </SoftField>
        {presetKey === "shopify" && input.trim() && (
          <p className="font-mono text-xs text-muted-foreground">→ {preset.url(input)}</p>
        )}
        <SoftField label="Nom (facultatif)">
          <SoftInput value={name} placeholder={defaultName(presetKey, input)} onChange={(e) => setName(e.target.value)} />
        </SoftField>
        {presetKey === "custom" && (
          <SoftField label="En-tête d'authentification (facultatif)">
            <SoftInput
              value={authHeader} placeholder="Bearer sk_…" autoComplete="off"
              onChange={(e) => setAuthHeader(e.target.value)}
            />
          </SoftField>
        )}
        <p className="rounded-xl bg-muted/50 p-3.5 text-xs leading-relaxed text-muted-foreground">{preset.help}</p>
        <Button onClick={connect} disabled={busy || !input.trim()} className="rounded-full">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          Tester et connecter
        </Button>
        {okMsg && <p className="text-sm text-emerald-500">{okMsg}</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Serveurs MCP de l'espace</h2>
        {servers.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucun serveur enregistré pour le moment.</p>
        ) : (
          <div className="space-y-2">
            {servers.map((s) => {
              const on = attachedIds.has(s.id);
              const toolCount = (s.cached_tools ?? []).length;
              return (
                <div key={s.id} className="flex items-start gap-3 rounded-2xl border border-border/60 p-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary">
                    <Store className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{s.name}</span>
                      <Badge variant={s.status === "ok" ? "success" : s.status === "error" ? "destructive" : "secondary"}>
                        {s.status === "ok" ? `${toolCount} outil(s)` : s.status === "error" ? "erreur" : "jamais testé"}
                      </Badge>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{s.url}</div>
                    {s.last_error && <div className="mt-1 line-clamp-2 text-xs text-destructive">{s.last_error}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="Redécouvrir les outils"
                      onClick={() => rediscover(s)} disabled={busy}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <MiniSwitch
                      checked={on} onChange={(v) => toggleAttach(s, v)}
                      title={on ? "Détacher de cet agent" : "Attacher à cet agent"}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Le registre MCP est partagé avec les agents internes. Activer un serveur ici l'attache
          à cet agent public uniquement.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Utilisation des outils</h2>
        <SoftToggle
          label="Autoriser cet agent à appeler des outils"
          checked={agent.tool_use_enabled}
          onChange={(v) => saveAgent({ tool_use_enabled: v })}
        />
        <SoftField label={`Appels d'outils max par message · ${agent.max_tool_calls ?? 4}`}>
          <SoftRange
            min={1} max={10} step={1}
            value={agent.max_tool_calls ?? 4}
            onChange={(e) => saveAgent({ max_tool_calls: Number(e.target.value) })}
            className="mt-2.5"
          />
        </SoftField>
        <SoftField label="URL de la vitrine (si les liens produits pointent ailleurs)">
          <SoftInput
            placeholder="https://boutique.mondomaine.com"
            defaultValue={agent.storefront_url ?? ""}
            onBlur={(e) => saveAgent({ storefront_url: e.target.value || null })}
          />
        </SoftField>
        <p className="rounded-xl bg-muted/50 p-3.5 text-xs leading-relaxed text-muted-foreground">
          Chaque appel d'outil est une requête vers la boutique et un aller-retour de plus avec le
          modèle : la limite protège le temps de réponse du widget autant que votre facture.
        </p>
      </section>
    </div>
  );
}

function defaultName(presetKey: string, input: string) {
  if (presetKey === "shopify") {
    const d = input.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return d ? `Shopify · ${d}` : "Shopify Storefront";
  }
  return "Serveur MCP";
}

function McpToolGrants({ agent, servers, attached, onChanged }: {
  agent: Agent; servers: McpServerRow[]; attached: AttachRow[]; onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(servers.map((s) => [s.id, s]));
  const rows = attached
    .map((a) => ({ attach: a, server: byId.get(a.server_id) }))
    .filter((r): r is { attach: AttachRow; server: McpServerRow } => !!r.server);

  async function setAllowed(serverId: string, tools: string[]) {
    setError(null);
    const { error: err } = await supabase.from("rag_agent_mcp_servers")
      .update({ allowed_tools: tools }).eq("agent_id", agent.id).eq("server_id", serverId);
    if (err) { setError(writeError(err)); return; }
    onChanged();
  }

  if (rows.length === 0) {
    return <EmptyState icon={Plug} title="Aucun serveur attaché" description="Connectez une boutique dans l'onglet Boutique pour voir ses outils." />;
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      {error && (
        <p className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
      )}
      <p className="rounded-xl bg-muted/50 p-3.5 text-xs leading-relaxed text-muted-foreground">
        Cochez les outils que l'agent peut appeler. Rien n'est autorisé par défaut : ce widget est
        exposé à tout internet, et un serveur boutique publie les opérations de panier à côté de la
        simple recherche catalogue.
      </p>
      {rows.map(({ attach, server }) => {
        const tools = server.cached_tools ?? [];
        const allowed = new Set(attach.allowed_tools ?? []);
        return (
          <section key={server.id} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h2 className="truncate text-sm font-semibold">{server.name}</h2>
              <div className="flex shrink-0 gap-1.5">
                <button
                  onClick={() => setAllowed(server.id, tools.map((t) => t.name))}
                  className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary"
                >
                  Tout
                </button>
                <button
                  onClick={() => setAllowed(server.id, [])}
                  className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary"
                >
                  Aucun
                </button>
              </div>
            </div>
            {tools.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Aucun outil en cache — lancez une redécouverte depuis l'onglet Boutique.
              </p>
            ) : (
              <ul className="divide-y divide-border/40 rounded-xl border border-border/60">
                {tools.map((t) => (
                  <li key={t.name} className="px-2.5 py-2">
                    <SoftCheckbox
                      checked={allowed.has(t.name)}
                      onChange={(on) => {
                        const next = new Set(allowed);
                        if (on) next.add(t.name); else next.delete(t.name);
                        setAllowed(server.id, [...next]);
                      }}
                      label={<span className="font-mono text-xs font-medium">{t.name}</span>}
                      hint={t.description}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function McpToolActivity({ agent }: { agent: Agent }) {
  const { data: calls } = useQuery({
    queryKey: ["pa_tool_calls", agent.id],
    refetchInterval: 10000,
    queryFn: async () => {
      const { data } = await supabase
        .from("rag_agent_tool_calls")
        .select("id, tool_name, args, ok, error, duration_ms, visitor_id, created_at")
        .eq("agent_id", agent.id).order("created_at", { ascending: false }).limit(50);
      return (data ?? []) as {
        id: string; tool_name: string; args: Record<string, unknown>; ok: boolean;
        error: string | null; duration_ms: number | null; visitor_id: string | null; created_at: string;
      }[];
    },
  });

  if ((calls ?? []).length === 0) {
    return <EmptyState icon={Package} title="Aucun appel d'outil" description="Les appels faits par l'agent pour vos visiteurs apparaîtront ici." />;
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-2">
      <p className="mb-3 text-xs text-muted-foreground">
        Chaque appel déclenché par un visiteur anonyme, avec ses arguments — utile pour comprendre
        une réponse étrange autant que pour répondre à une demande RGPD.
      </p>
      {(calls ?? []).map((c) => (
        <div key={c.id} className="rounded-xl border border-border/60 px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-medium">{c.tool_name}</span>
            <Badge variant={c.ok ? "success" : "destructive"}>{c.ok ? "ok" : "échec"}</Badge>
            {c.duration_ms != null && <span className="text-[11px] text-muted-foreground">{c.duration_ms} ms</span>}
            <span className="ml-auto text-[11px] text-muted-foreground">{new Date(c.created_at).toLocaleString()}</span>
          </div>
          {c.error && <div className="mt-1 line-clamp-2 text-xs text-destructive">{c.error}</div>}
          {c.args && Object.keys(c.args).length > 0 && (
            <pre className="mt-1.5 overflow-x-auto rounded-lg bg-muted/50 p-2 font-mono text-[11px] text-muted-foreground">
              {JSON.stringify(c.args)}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function PublicSettingsTab({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: agent.name, description: agent.description ?? "", persona: agent.persona ?? "",
    instructions: agent.instructions ?? "", model: agent.model, temperature: agent.temperature,
    welcome_message: agent.welcome_message ?? "", enabled: agent.enabled, onboarding_enabled: agent.onboarding_enabled,
    onboarding_copilot_enabled: agent.onboarding_copilot_enabled,
    accent_color: agent.accent_color ?? "#001BB7",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true); setSaved(false);
    try {
      await supabase.from("rag_agents").update({ ...form, updated_at: new Date().toISOString() }).eq("id", agent.id);
      queryClient.invalidateQueries({ queryKey: ["rag_agent", agent.id] });
      // Toggling onboarding_enabled must refresh the sidebar's conditional
      // Onboarding tab (it reads a separate flag query).
      queryClient.invalidateQueries({ queryKey: ["rag_agent_onb_flag", agent.id] });
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } finally { setSaving(false); }
  }

  function upd<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm((f) => ({ ...f, [k]: v })); }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div className="flex items-end gap-3">
        <SoftField label="Nom" className="flex-1">
          <SoftInput value={form.name} onChange={(e) => upd("name", e.target.value)} />
        </SoftField>
        <SoftField label="Couleur">
          <SoftColor value={form.accent_color} onChange={(v) => upd("accent_color", v)} className="w-40" />
        </SoftField>
      </div>
      <SoftField label="Description">
        <SoftInput value={form.description} onChange={(e) => upd("description", e.target.value)} />
      </SoftField>
      <SoftField label="Persona">
        <SoftInput value={form.persona} onChange={(e) => upd("persona", e.target.value)} placeholder="Tu es un agent de support…" />
      </SoftField>
      <SoftField label="Instructions">
        <SoftTextarea value={form.instructions} onChange={(e) => upd("instructions", e.target.value)} rows={4} />
      </SoftField>
      <SoftField label="Message d'accueil">
        <SoftInput value={form.welcome_message} onChange={(e) => upd("welcome_message", e.target.value)} />
      </SoftField>
      <div className="grid grid-cols-2 gap-4">
        <SoftField label="Modèle">
          <SoftSelect
            value={form.model}
            onChange={(v) => upd("model", v)}
            options={[
              { value: "groq", label: "Groq — Llama 3.3 70B" },
              { value: "deepseek", label: "DeepSeek" },
            ]}
          />
        </SoftField>
        <SoftField label={`Température · ${form.temperature}`}>
          <SoftRange min={0} max={1} step={0.1} value={form.temperature} onChange={(e) => upd("temperature", Number(e.target.value))} className="mt-2.5" />
        </SoftField>
      </div>
      <div className="space-y-2">
        <SoftToggle label="Widget actif" checked={form.enabled} onChange={(v) => upd("enabled", v)} />
        <SoftToggle label="Mode onboarding" checked={form.onboarding_enabled} onChange={(v) => upd("onboarding_enabled", v)} />
        <SoftToggle
          label="Co-pilote agentique" checked={form.onboarding_copilot_enabled}
          onChange={(v) => upd("onboarding_copilot_enabled", v)} disabled={!form.onboarding_enabled}
        />
      </div>
      <Button onClick={save} disabled={saving} className="rounded-full">
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {saved ? "Enregistré" : "Enregistrer"}
      </Button>
    </div>
  );
}

function FrameworkSnippets({ snippets, frameworks }: { snippets: Record<string, string>; frameworks: string[] }) {
  const [active, setActive] = useState<string>(frameworks[1] ?? frameworks[0]);
  const [copied, setCopied] = useState(false);
  const code = snippets[active] ?? "";
  return (
    <div>
      <div className="mb-1.5 text-sm font-medium">For your framework</div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {frameworks.map((fw) => (
          <button
            key={fw}
            type="button"
            onClick={() => setActive(fw)}
            className={
              "rounded-md border px-2.5 py-1 text-xs transition-colors " +
              (active === fw
                ? "border-primary/40 bg-primary/15 text-primary"
                : "border-border text-muted-foreground hover:bg-secondary")
            }
          >
            {fw}
          </button>
        ))}
      </div>
      <pre className="max-h-72 overflow-y-auto whitespace-pre rounded-md bg-secondary/50 p-3 font-mono text-xs leading-relaxed text-foreground/90">
        {code}
      </pre>
      <Button
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={() => {
          navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
        {copied ? "Copied" : `Copy ${active}`}
      </Button>
    </div>
  );
}
