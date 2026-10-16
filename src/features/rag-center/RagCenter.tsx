import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleNotchIcon as Loader2,
  PlusIcon as Plus,
  BooksIcon as Library,
  FileTextIcon as FileText,
  GlobeIcon as Globe,
  CubeIcon as Boxes,
  SparkleIcon as Sparkles,
  TrashIcon as Trash2,
  XIcon as X,
  ArrowLeftIcon as ArrowLeft,
  DatabaseIcon as Database,
  CheckCircleIcon as CheckCircle2,
  WarningIcon as AlertTriangle,
  ArrowsClockwiseIcon as RefreshCw,
  PowerIcon as Power,
  RobotIcon as Bot,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { ingestFile, ingestText, ingestUrl, setActivation } from "./api";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ConfirmProvider";

// ─────────────────────────────────────────────────────────────────── types
interface Collection {
  id: string; name: string; description: string | null; color: string;
  enabled: boolean; created_at: string;
}
interface Source {
  id: string; type: string; title: string; status: string;
  chunk_count: number; error_message: string | null; created_at: string;
}
interface ActivationRow { agent_kind: "rag_agent" | "internal_agent"; agent_id: string }

const SOURCE_ICON: Record<string, typeof FileText> = {
  text: FileText, url: Globe, document: FileText, saas_structure: Boxes,
};
const STATUS_CLS: Record<string, string> = {
  ready: "text-emerald-600", processing: "text-amber-600", pending: "text-muted-foreground", failed: "text-destructive",
};

// ─────────────────────────────────────────────────────────────── list page
export function RagCenterPage() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: collections, isLoading } = useQuery({
    queryKey: ["rag_collections", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("rag_collections").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Collection[];
    },
  });

  async function create(draft: { name: string; description: string }) {
    if (!workspaceId || !projectId || !draft.name.trim()) return;
    await supabase.from("rag_collections").insert({
      workspace_id: workspaceId, project_id: projectId, name: draft.name.trim(),
      description: draft.description || null, created_by: user?.id ?? null,
    });
    queryClient.invalidateQueries({ queryKey: ["rag_collections", projectId] });
    setOpen(false);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="RAG Center"
        description="Centralise knowledge into reusable collections, then activate them individually on your agents."
        actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New collection</Button>}
      />

      {isLoading ? <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (collections ?? []).length === 0 ? <EmptyState icon={Library} title="No collections yet" description="A collection is a knowledge base (docs, URLs, notes) you can attach to any number of agents." />
        : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(collections ?? []).map((c) => <CollectionCard key={c.id} c={c} onOpen={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/knowledge/${c.id}`)} />)}
          </div>
        )}

      <NewCollectionDialog open={open} onOpenChange={setOpen} onCreate={create} />
    </div>
  );
}

function CollectionCard({ c, onOpen }: { c: Collection; onOpen: () => void }) {
  const { data: stats } = useQuery({
    queryKey: ["rag_collection_stats", c.id],
    queryFn: async () => {
      const [{ data: sources }, { count: agents }] = await Promise.all([
        supabase.from("rag_sources").select("chunk_count, status").eq("collection_id", c.id),
        supabase.from("rag_collection_agents").select("id", { count: "exact", head: true }).eq("collection_id", c.id),
      ]);
      const list = (sources ?? []) as { chunk_count: number; status: string }[];
      return { sources: list.length, chunks: list.reduce((s, x) => s + (x.chunk_count ?? 0), 0), agents: agents ?? 0 };
    },
  });
  return (
    <Card className="cursor-pointer transition-colors hover:border-primary/40" onClick={onOpen}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted", c.color)}><Library className="h-4 w-4" /></span>
            <div className="min-w-0">
              <div className="truncate font-medium">{c.name}</div>
              {c.description && <div className="truncate text-xs text-muted-foreground">{c.description}</div>}
            </div>
          </div>
          {!c.enabled && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Disabled</span>}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1"><FileText className="h-3 w-3" /> {stats?.sources ?? 0} sources</span>
          <span className="flex items-center gap-1"><Database className="h-3 w-3" /> {stats?.chunks ?? 0} chunks</span>
          <span className="flex items-center gap-1"><Bot className="h-3 w-3" /> {stats?.agents ?? 0} agents</span>
        </div>
      </CardContent>
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── detail page
export function RagCollectionDetailPage() {
  const confirm = useConfirm();
  const { collectionId } = useParams();
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const queryClient = useQueryClient();

  const { data: collection, isLoading } = useQuery({
    queryKey: ["rag_collection", collectionId],
    enabled: !!collectionId,
    queryFn: async () => {
      const { data } = await supabase.from("rag_collections").select("*").eq("id", collectionId!).maybeSingle();
      return data as Collection | null;
    },
  });

  if (isLoading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!collection) return <EmptyState icon={Library} title="Collection not found" />;

  async function toggleEnabled() {
    await supabase.from("rag_collections").update({ enabled: !collection!.enabled }).eq("id", collection!.id);
    queryClient.invalidateQueries({ queryKey: ["rag_collection", collectionId] });
  }
  async function remove() {
    if (!(await confirm("Delete this collection and all its sources? Agents using it will lose this knowledge."))) return;
    await supabase.from("rag_collections").delete().eq("id", collection!.id);
    navigate(`/app/${workspaceSlug}/${projectSlug}/agent/collections`);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/collections`)}><ArrowLeft className="mr-1 h-3.5 w-3.5" /> Collections</Button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{collection.name}</h1>
        <Button size="sm" variant="outline" onClick={toggleEnabled}><Power className="mr-1 h-3.5 w-3.5" /> {collection.enabled ? "Disable" : "Enable"}</Button>
        <Button size="sm" variant="ghost" className="text-destructive" onClick={remove}><Trash2 className="h-4 w-4" /></Button>
      </div>
      {collection.description && <p className="text-sm text-muted-foreground">{collection.description}</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><SourcesPanel collection={collection} /></div>
        <div><ActivationPanel collection={collection} /></div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────── sources panel
function SourcesPanel({ collection }: { collection: Collection }) {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);

  const { data: sources, isLoading } = useQuery({
    queryKey: ["rag_collection_sources", collection.id],
    queryFn: async () => {
      const { data } = await supabase.from("rag_sources").select("*").eq("collection_id", collection.id).order("created_at", { ascending: false });
      return (data ?? []) as Source[];
    },
    refetchInterval: (q) => ((q.state.data as Source[] | undefined)?.some((s) => s.status === "processing") ? 3000 : false),
  });

  async function remove(id: string) {
    await supabase.from("rag_sources").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["rag_collection_sources", collection.id] });
    queryClient.invalidateQueries({ queryKey: ["rag_collection_stats", collection.id] });
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium"><Database className="h-4 w-4" /> Knowledge sources</div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => queryClient.invalidateQueries({ queryKey: ["rag_collection_sources", collection.id] })}><RefreshCw className="h-3.5 w-3.5" /></Button>
            <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add source</Button>
          </div>
        </div>

        {isLoading ? <div className="flex h-32 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          : (sources ?? []).length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No sources yet. Add text, a URL or a file to vectorize.</p>
          : (
            <div className="divide-y divide-border">
              {(sources ?? []).map((s) => {
                const Icon = SOURCE_ICON[s.type] ?? FileText;
                return (
                  <div key={s.id} className="group flex items-center gap-3 py-2.5">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{s.title}</div>
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className={cn("flex items-center gap-1 capitalize", STATUS_CLS[s.status] ?? "text-muted-foreground")}>
                          {s.status === "ready" ? <CheckCircle2 className="h-3 w-3" /> : s.status === "failed" ? <AlertTriangle className="h-3 w-3" /> : s.status === "processing" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                          {s.status}
                        </span>
                        {s.status === "ready" && <span className="text-muted-foreground">· {s.chunk_count} chunks</span>}
                        {s.error_message && <span className="truncate text-destructive">· {s.error_message}</span>}
                      </div>
                    </div>
                    <button onClick={() => remove(s.id)} className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                );
              })}
            </div>
          )}
      </CardContent>

      <AddSourceDialog
        open={addOpen} onClose={() => setAddOpen(false)} collection={collection}
        workspaceId={workspaceId} projectId={projectId}
        onAdded={() => { queryClient.invalidateQueries({ queryKey: ["rag_collection_sources", collection.id] }); queryClient.invalidateQueries({ queryKey: ["rag_collection_stats", collection.id] }); }}
      />
    </Card>
  );
}

const SOURCE_TYPES = [
  { value: "text" as const, label: "Text" },
  { value: "url" as const, label: "URL" },
  { value: "document" as const, label: "File" },
];

function AddSourceDialog({ open, onClose, onAdded, collection, workspaceId, projectId }: {
  open: boolean; onClose: () => void; onAdded: () => void;
  collection: Collection; workspaceId: string | null; projectId: string | null;
}) {
  const [type, setType] = useState<"text" | "url" | "document">("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() { setTitle(""); setContent(""); setUrl(""); setType("text"); }

  async function ingestTextUrl() {
    const scope = { workspaceId: workspaceId!, projectId: projectId!, collectionId: collection.id };
    if (type === "text") await ingestText(scope, title || type, content);
    if (type === "url") await ingestUrl(scope, url, title || undefined);
  }

  async function uploadFile(files: FileList | null) {
    if (!files || !workspaceId || !projectId) return;
    for (const file of Array.from(files)) await ingestFile({ workspaceId, projectId, collectionId: collection.id }, file);
  }

  async function submit(files?: FileList | null) {
    if (!workspaceId || !projectId) return;
    setBusy(true); setError(null);
    try {
      if (type === "document") await uploadFile(files ?? null);
      else await ingestTextUrl();
      reset(); onAdded(); onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Add knowledge source</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-1.5">
            {SOURCE_TYPES.map((t) => (
              <Button key={t.value} size="sm" variant={type === t.value ? "default" : "outline"} onClick={() => setType(t.value)}>{t.label}</Button>
            ))}
          </div>
          {type !== "document" && <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />}
          {type === "text" && (
            <textarea placeholder="Paste text / FAQ / docs…" value={content} onChange={(e) => setContent(e.target.value)} rows={6}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          )}
          {type === "url" && <Input placeholder="https://docs.example.com/page" value={url} onChange={(e) => setUrl(e.target.value)} />}
          {type === "document" && (
            <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border py-8 text-sm text-muted-foreground hover:bg-muted/30">
              <FileText className="h-5 w-5" />
              <span>Click to choose a file (PDF, DOCX, TXT, MD, max 15 MB)</span>
              <input type="file" className="hidden" onChange={(e) => submit(e.target.files)} />
            </label>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {type !== "document" && (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={() => submit()} disabled={busy || (type === "text" && !content) || (type === "url" && !url)}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Ingest &amp; vectorize
              </Button>
            </div>
          )}
          {type === "document" && busy && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Uploading &amp; processing…</div>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────── activation panel
function ActivationPanel({ collection }: { collection: Collection }) {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: ["internal_agents_for_rag", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("id, name").eq("project_id", projectId!).eq("is_archived", false).order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  const { data: activations } = useQuery({
    queryKey: ["rag_collection_agents", collection.id],
    queryFn: async () => {
      const { data } = await supabase.from("rag_collection_agents").select("agent_kind, agent_id").eq("collection_id", collection.id);
      return (data ?? []) as ActivationRow[];
    },
  });

  const activeIds = useMemo(() => new Set((activations ?? []).filter((a) => a.agent_kind === "internal_agent").map((a) => a.agent_id)), [activations]);

  // Activation = (1) link row for tracking + (2) the agent's rag_search tool
  // recomputed from the link table (api.ts, setActivation).
  async function toggle(agentId: string, on: boolean) {
    if (!workspaceId || !projectId) return;
    await setActivation({ workspaceId, projectId, collectionId: collection.id, agentId, on });
    queryClient.invalidateQueries({ queryKey: ["rag_collection_agents", collection.id] });
    queryClient.invalidateQueries({ queryKey: ["rag_collection_stats", collection.id] });
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-sm font-medium"><Power className="h-4 w-4" /> Activate on agents</div>
        <p className="text-[11px] text-muted-foreground">Turn this collection on for autonomous agents. Activated agents gain a knowledge tool scoped to the collections you enable.</p>
        {(agents ?? []).length === 0 ? <p className="py-4 text-center text-xs text-muted-foreground">No autonomous agents in this project yet.</p>
          : (
            <div className="space-y-1.5">
              {(agents ?? []).map((a) => {
                const on = activeIds.has(a.id);
                return (
                  <button key={a.id} onClick={() => toggle(a.id, !on)}
                    className={cn("flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm transition-colors",
                      on ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted/40")}>
                    <Bot className={cn("h-4 w-4", on ? "text-primary" : "text-muted-foreground")} />
                    <span className="flex-1 truncate">{a.name}</span>
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", on ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>{on ? "Active" : "Off"}</span>
                  </button>
                );
              })}
            </div>
          )}
      </CardContent>
    </Card>
  );
}

// ───────────────────────────────────────────────────────────────── dialogs
function NewCollectionDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: { name: string; description: string }) => Promise<void> }) {
  const [d, setD] = useState({ name: "", description: "" });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.name.trim()) return; setSaving(true); try { await onCreate(d); setD({ name: "", description: "" }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Library className="h-4 w-4 text-primary" /> New knowledge collection</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label><Input value={d.name} onChange={(e) => setD((p) => ({ ...p, name: e.target.value }))} autoFocus placeholder="Product docs, Legal KB…" /></div>
          <div><label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label><Input value={d.description} onChange={(e) => setD((p) => ({ ...p, description: e.target.value }))} placeholder="What this knowledge base covers" /></div>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Create</Button></div>
      </DialogContent>
    </Dialog>
  );
}
