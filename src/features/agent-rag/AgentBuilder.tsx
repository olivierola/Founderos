import { useState, useRef, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Loader2, Bot, MessageSquare,
  Plus, Trash2, Send, FileText, Link2, LayoutGrid, Check, Copy, Sparkles, BookOpen, Search,
} from "lucide-react";
import { MetricCard } from "@/components/MetricCard";
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
  id: string; name: string; description: string | null; persona: string | null;
  instructions: string | null; model: string; temperature: number;
  welcome_message: string | null; widget_config: any; public_key: string;
  enabled: boolean; onboarding_enabled: boolean;
}
interface Source { id: string; type: string; title: string; status: string; chunk_count: number; error_message: string | null; created_at: string; }

const VALID_TABS: Tab[] = ["knowledge", "playground", "widget", "analytics", "settings"];

export function AgentBuilderPage() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug, agentId, tab: tabParam } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const tab: Tab = VALID_TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "knowledge";

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

function KnowledgeTab({ agent, workspaceId, projectId }: { agent: Agent; workspaceId: string | null; projectId: string | null }) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");

  const { data: sources } = useQuery({
    queryKey: ["rag_sources", agent.id],
    enabled: !!agent.id,
    refetchInterval: 4000,
    queryFn: async () => {
      const { data } = await supabase.from("rag_sources").select("*").eq("agent_id", agent.id).order("created_at", { ascending: false });
      return (data ?? []) as Source[];
    },
  });

  async function removeSource(id: string) {
    await supabase.from("rag_sources").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["rag_sources", agent.id] });
  }

  const filtered = (sources ?? []).filter((s) => {
    if (typeFilter && s.type !== typeFilter) return false;
    const q = search.trim().toLowerCase();
    if (q && !s.title.toLowerCase().includes(q)) return false;
    return true;
  });

  return (
    <div>
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Knowledge Base</h2>
        </div>
        <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add document</Button>
      </div>

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
          <Button className="mt-4" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add document</Button>
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
  open, onClose, onAdded, agent, workspaceId, projectId,
}: {
  open: boolean; onClose: () => void; onAdded: () => void;
  agent: Agent; workspaceId: string | null; projectId: string | null;
}) {
  const [type, setType] = useState<"text" | "url" | "saas_structure">("text");
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
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string; sources?: any[] }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [convId, setConvId] = useState<string | undefined>();
  const endRef = useRef<HTMLDivElement>(null);

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

  return (
    <Card>
      <CardContent className="flex h-[60vh] flex-col p-0">
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 && (
            <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
              <div>
                <Bot className="mx-auto mb-2 h-8 w-8 text-primary" />
                {agent.welcome_message ?? "Ask me anything about your knowledge base."}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>
                <p className="whitespace-pre-wrap">{m.content}</p>
                {m.sources && m.sources.length > 0 && (
                  <div className="mt-2 border-t border-border/50 pt-1.5 text-xs opacity-70">
                    {m.sources.length} source(s) · top match {(m.sources[0]?.similarity * 100).toFixed(0)}%
                  </div>
                )}
              </div>
            </div>
          ))}
          {busy && <div className="flex justify-start"><div className="rounded-lg bg-secondary px-3 py-2"><Loader2 className="h-4 w-4 animate-spin" /></div></div>}
          <div ref={endRef} />
        </div>
        <div className="flex gap-2 border-t border-border p-3">
          <Input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Type a message…" />
          <Button onClick={send} disabled={busy || !input.trim()}><Send className="h-4 w-4" /></Button>
        </div>
      </CardContent>
    </Card>
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
  // text contents
  text_main_label: "Need help?",
  text_start_chat: "Start a chat",
  text_send: "Send",
  text_placeholder: "Type a message…",
};

// Section row: label/description on the left, controls on the right (ElevenLabs style).
function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 border-b border-border py-6 lg:grid-cols-[260px_1fr]">
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
      <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-5 w-5 cursor-pointer rounded-full border-0 bg-transparent p-0" />
        <input value={value} onChange={(e) => onChange(e.target.value)} className="w-full bg-transparent text-sm outline-none" />
      </div>
    </div>
  );
}

function RadiusRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-3">
      <label className="text-sm">{label}</label>
      <Input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-9" />
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
      <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="h-9" />
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
    config: ${JSON.stringify(cfg)}
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
        <div className="rounded-md border border-border p-3 text-sm text-muted-foreground">
          The agent answers from its knowledge base. Paste the embed code on the pages where you want the chat widget.
        </div>
        <div>
          <div className="mb-1 text-sm font-medium">Embed code</div>
          <pre className="max-h-48 overflow-auto rounded-md border border-border bg-background/40 p-3 text-xs"><code>{snippet}</code></pre>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => { navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />} Copy snippet
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">Public key: <code className="text-foreground">{agent.public_key}</code></p>
        </div>
        <Toggle label="Feedback collection" desc="Visitors can rate their satisfaction from 1 to 5 after the conversation." checked={cfg.feedback} onChange={(v) => set("feedback", v)} />
      </Section>

      {/* Interface */}
      <Section title="Interface" desc="Configure the parts of the widget interface.">
        <Toggle label="Collapsible" desc="Visitors can collapse the chat back to the bubble." checked={cfg.collapsible} onChange={(v) => set("collapsible", v)} />
        <div>
          <label className="mb-1 block text-sm font-medium">Variant</label>
          <div className="inline-flex rounded-md border border-border p-0.5">
            {["tiny", "compact", "full"].map((v) => (
              <button key={v} onClick={() => set("variant", v)} className={`rounded px-4 py-1.5 text-sm capitalize transition-colors ${cfg.variant === v ? "bg-secondary text-foreground" : "text-muted-foreground"}`}>{v}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Placement</label>
          <select value={cfg.placement} onChange={(e) => set("placement", e.target.value)} className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-2 text-sm">
            <option value="bottom-right">Bottom-right</option>
            <option value="bottom-left">Bottom-left</option>
          </select>
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
        <div className="inline-flex rounded-md border border-border p-0.5">
          {["orb", "image"].map((t) => (
            <button key={t} onClick={() => set("avatar_type", t)} className={`rounded px-4 py-1.5 text-sm capitalize transition-colors ${cfg.avatar_type === t ? "bg-secondary text-foreground" : "text-muted-foreground"}`}>{t}</button>
          ))}
        </div>
        {cfg.avatar_type === "orb" ? (
          <div className="grid grid-cols-2 gap-3">
            <ColorRow label="First color" value={cfg.avatar_first} onChange={(v) => set("avatar_first", v)} />
            <ColorRow label="Second color" value={cfg.avatar_second} onChange={(v) => set("avatar_second", v)} />
          </div>
        ) : (
          <Input placeholder="Avatar image URL" value={cfg.avatar_url} onChange={(e) => set("avatar_url", e.target.value)} />
        )}
      </Section>

      {/* Terms & Conditions */}
      <Section title="Terms & Conditions" desc="Require the visitor to accept your terms before chatting.">
        <Toggle label="Enable terms & conditions" checked={cfg.terms_enabled} onChange={(v) => set("terms_enabled", v)} />
        {cfg.terms_enabled && (
          <div>
            <label className="mb-1 block text-sm font-medium">Terms content <span className="text-xs text-muted-foreground">(Markdown)</span></label>
            <textarea value={cfg.terms_content} onChange={(e) => set("terms_content", e.target.value)} rows={5} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
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
function AnalyticsTab({ agent }: { agent: Agent }) {
  const { data, isLoading } = useQuery({
    queryKey: ["rag_analytics", agent.id],
    enabled: !!agent.id,
    queryFn: async () => {
      const [convos, msgs] = await Promise.all([
        supabase.from("rag_conversations").select("id, source, created_at, rating").eq("agent_id", agent.id).limit(1000),
        supabase.from("rag_messages").select("role, content, created_at").eq("agent_id", agent.id).eq("role", "user").order("created_at", { ascending: false }).limit(500),
      ]);
      return { convos: convos.data ?? [], questions: (msgs.data ?? []) as { content: string }[] };
    },
  });

  if (isLoading) return <EmptyState icon={Loader2} title="Loading…" />;
  const convos = data?.convos ?? [];
  const questions = data?.questions ?? [];
  const widget = convos.filter((c: any) => c.source === "widget").length;
  const ratings = convos.map((c: any) => c.rating).filter((r: any) => r != null);
  const avgRating = ratings.length ? (ratings.reduce((a: number, b: number) => a + b, 0) / ratings.length).toFixed(1) : "—";

  // Frequent question keywords (naive).
  const freq = new Map<string, number>();
  questions.forEach((q) => freq.set(q.content.slice(0, 60), (freq.get(q.content.slice(0, 60)) ?? 0) + 1));
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Conversations" value={String(convos.length)} icon={MessageSquare} />
        <MetricCard label="From widget" value={String(widget)} />
        <MetricCard label="Questions asked" value={String(questions.length)} />
        <MetricCard label="Avg rating" value={String(avgRating)} />
      </div>
      <Card>
        <CardHeader><CardTitle>Top questions</CardTitle></CardHeader>
        <CardContent>
          {top.length === 0 ? (
            <p className="text-sm text-muted-foreground">No questions yet.</p>
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
  );
}

// --- Settings -----------------------------------------------------------
function SettingsTab({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: agent.name, description: agent.description ?? "", persona: agent.persona ?? "",
    instructions: agent.instructions ?? "", model: agent.model, temperature: agent.temperature,
    welcome_message: agent.welcome_message ?? "", enabled: agent.enabled, onboarding_enabled: agent.onboarding_enabled,
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
        <div><label className="mb-1 block text-xs text-muted-foreground">Name</label><Input value={form.name} onChange={(e) => upd("name", e.target.value)} /></div>
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
