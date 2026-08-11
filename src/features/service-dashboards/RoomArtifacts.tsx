import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Plus, Upload, FileText, Presentation, Table as TableIcon, Image as ImageIcon, Type, Loader2, ArrowLeft, Palette, Check, Trash2 } from "lucide-react";
import { WarpCard, WARP_CONFIGS, configForKey, cssGradientForConfig, type WarpConfig } from "@/components/ui/warp-card";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ToastProvider";
import { CodeBlock, CodeBlockCode } from "@/components/ui/code-block";
import { type ArtifactDoc } from "@/features/artifacts/shared";
import { ArtifactWorkspace } from "@/features/artifacts/ArtifactWorkspace";
import { type ArtifactOpenTarget } from "@/features/internal-agents/UiBlocks";
import { AgentIdentity } from "@/components/AgentIdentity";
import { ArtifactReport, ArtifactDeck } from "@/features/artifacts/BlockRenderer";
import { parseDocument } from "@/features/artifacts/blocks";

const KIND_ICON: Record<string, typeof FileText> = {
  document: FileText, presentation: Presentation, spreadsheet: TableIcon, image: ImageIcon, text: Type,
};

// Default shader preset per kind (used when a card has no custom colour); a
// custom `card_color` holds a WARP_CONFIGS key.
const KIND_CONFIG_KEY: Record<string, string> = {
  document: "cyan", presentation: "amber", spreadsheet: "green", image: "magenta", text: "violet",
};
const configOf = (kind: string, custom: string | null, index: number): WarpConfig =>
  configForKey(custom) ?? configForKey(KIND_CONFIG_KEY[kind]) ?? WARP_CONFIGS[index % WARP_CONFIGS.length].config;

interface OfficeMediaRow { id: string; kind: string; url: string | null; status: string; created_at: string }

/**
 * Room's "Artifacts" tab — a clean gallery (search + "in this room" / "other")
 * matching the reference, with room-scoped office_documents/office_media
 * (service_room_id). Clicking a card (or an inline chat artifact via
 * `openArtifact`) swaps this tab to the matching editor, in place.
 */
export function RoomArtifacts({
  roomId, workspaceId, projectId, openArtifact, onOpenArtifactHandled, onViewingChange,
}: {
  roomId: string;
  workspaceId: string;
  projectId: string | null;
  openArtifact: ArtifactOpenTarget | null;
  onOpenArtifactHandled: () => void;
  /** Reports whether the editor (vs. the gallery) is showing — the panel
   * hides its floating tab bar while an editor (which has its own header) is open. */
  onViewingChange?: (viewing: boolean) => void;
}) {
  const [viewing, setViewing] = useState<ArtifactOpenTarget | null>(null);

  // A click from the chat (RoomView) always wins and opens immediately.
  useEffect(() => {
    if (openArtifact) {
      setViewing(openArtifact);
      onOpenArtifactHandled();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openArtifact]);

  useEffect(() => { onViewingChange?.(!!viewing); }, [viewing, onViewingChange]);

  if (viewing) {
    return <ArtifactViewer target={viewing} onBack={() => setViewing(null)} />;
  }
  return <ArtifactGallery roomId={roomId} workspaceId={workspaceId} projectId={projectId} onOpen={setViewing} dense />;
}

/**
 * Dashboard-wide "Artifacts" page (the left-nav item, full-width — not a
 * room's side panel). Same gallery/viewer, but every artifact in the
 * project's rooms (no "in this room" split, since there's no single room
 * here) — reached at .../artifacts.
 */
export function DashboardArtifactsPage({ workspaceId, projectId }: { workspaceId: string; projectId: string | null }) {
  const [viewing, setViewing] = useState<ArtifactOpenTarget | null>(null);
  if (viewing) {
    return (
      <div className="h-[calc(100vh-3.5rem)]">
        <ArtifactViewer target={viewing} onBack={() => setViewing(null)} />
      </div>
    );
  }
  return <ArtifactGallery roomId={null} workspaceId={workspaceId} projectId={projectId} onOpen={setViewing} />;
}

function ArtifactViewer({ target, onBack, dense }: { target: ArtifactOpenTarget; onBack: () => void; dense?: boolean }) {
  if (target.table === "code") {
    return (
      <div className="flex h-full flex-col">
        <div className="relative z-20 flex items-center gap-2 border-b border-border bg-background/95 backdrop-blur px-4 py-3">
          <button type="button" onClick={onBack} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="truncate text-sm font-semibold">{target.title || "Code"}</span>
          {target.language && <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{target.language}</span>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <CodeBlock className="min-h-full">
            <CodeBlockCode code={target.content ?? ""} language={target.language || "text"} />
          </CodeBlock>
        </div>
      </div>
    );
  }
  if (target.table === "office_media") {
    return <MediaViewer id={target.id} title={target.title} onBack={onBack} />;
  }
  if (target.table === "deliverable") {
    return <DeliverableViewer id={target.id} title={target.title} onBack={onBack} />;
  }
  // An office_documents row is an Editor.js document now — read it, or edit it
  // in place. The Plate and SheetJS editors it used to open are retired.
  return <ArtifactWorkspace docId={target.id!} onBack={onBack} />;
}

/**
 * An artifact, rendered.
 *
 * One path for everything now: the stored content is an Editor.js document and
 * BlockRenderer draws it — a report scrolls, a presentation is cut into slides.
 * The old branch (parse the bespoke report schema, else fall back to markdown)
 * is gone with the formats it served.
 */
function DeliverableViewer({ id, title, onBack }: { id?: string; title: string; onBack: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["room_deliverable_one", id],
    enabled: !!id,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_deliverables").select("id, name, kind, content").eq("id", id!).maybeSingle();
      return (data ?? null) as { id: string; name: string; kind: string; content: string } | null;
    },
  });
  const doc = parseDocument(data?.content);
  const isDeck = data?.kind === "presentation";

  return (
    <div className="flex h-full flex-col">
      <div className="relative z-20 flex items-center gap-2 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
        <button type="button" onClick={onBack} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="truncate text-sm font-semibold">{data?.name || title}</span>
        <span className="ml-auto rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {isDeck ? "présentation" : "rapport"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading
          ? <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
          : isDeck ? <ArtifactDeck doc={doc} /> : <ArtifactReport doc={doc} />}
      </div>
    </div>
  );
}

function MediaViewer({ id, title, onBack }: { id?: string; title: string; onBack: () => void }) {
  const { data: media } = useQuery({
    queryKey: ["office_media_one", id],
    enabled: !!id,
    queryFn: async () => {
      const { data } = await supabase.from("office_media").select("id, kind, url, status, created_at").eq("id", id!).maybeSingle();
      return data as OfficeMediaRow | null;
    },
    refetchInterval: (q) => (q.state.data as OfficeMediaRow | undefined)?.status === "generating" ? 1500 : false,
  });
  return (
    <div className="flex h-full flex-col">
      <div className="relative z-20 flex items-center gap-2 border-b border-border bg-background/95 backdrop-blur px-4 py-3">
        <button type="button" onClick={onBack} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="truncate text-sm font-semibold">{title}</span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {media?.status === "ready" && media.url ? (
          <img src={media.url} alt={title} className="max-h-full max-w-full rounded-lg object-contain" />
        ) : media?.status === "failed" ? (
          <p className="text-sm text-destructive">Échec de la génération.</p>
        ) : (
          <p className="text-sm text-muted-foreground">Génération en cours…</p>
        )}
      </div>
    </div>
  );
}

function ArtifactGallery({
  roomId, workspaceId, projectId, onOpen, dense,
}: {
  roomId: string | null;
  workspaceId: string; projectId: string | null;
  onOpen: (t: ArtifactOpenTarget) => void;
  dense?: boolean;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState("");

  // Agent deliverables (reports, coding/test/simulation sessions) — first-class
  // artifacts. Joined via the agent so we can scope to this project.
  const { data: deliverables, error: deliverablesError } = useQuery({
    queryKey: ["dash_deliverables", projectId],
    enabled: !!projectId,
    refetchInterval: 5000, // pick up freshly-produced reports without a manual reload
    queryFn: async () => {
      // Two-step (no !inner embed — that silently drops rows on join/RLS quirks):
      // the project's agents, then their deliverables.
      const { data: agents, error: agentsErr } = await supabase
        .from("internal_agents").select("id").eq("project_id", projectId!);
      if (agentsErr) throw new Error(agentsErr.message);
      const ids = (agents ?? []).map((a) => (a as { id: string }).id);
      if (ids.length === 0) return [];
      // Errors are RAISED, not swallowed: an RLS refusal and "the agent never
      // saved anything" used to render as the exact same empty gallery, which
      // is the worst possible answer to "où est mon rapport ?".
      const { data, error } = await supabase
        .from("internal_agent_deliverables")
        .select("id, name, kind, created_at, agent_id")
        .in("agent_id", ids)
        .order("created_at", { ascending: false }).limit(60);
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ id: string; name: string; kind: string; created_at: string; agent_id: string }>;
    },
  });

  const { data: docs } = useQuery({
    queryKey: ["room_office_docs", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("office_documents").select("*")
        .eq("project_id", projectId!).eq("is_archived", false).order("updated_at", { ascending: false }).limit(60);
      return (data ?? []) as ArtifactDoc[];
    },
  });
  const { data: media } = useQuery({
    queryKey: ["room_office_media", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("office_media").select("id, kind, url, status, created_at, prompt, service_room_id, created_by, card_color")
        .eq("project_id", projectId!).order("created_at", { ascending: false }).limit(60);
      return (data ?? []) as Array<OfficeMediaRow & { prompt: string; service_room_id: string | null; created_by: string | null; card_color: string | null }>;
    },
  });

  type Card = { id: string; title: string; kind: string; table: "office_documents" | "office_media" | "deliverable"; inRoom: boolean; author: string; url?: string | null; status?: string; preview?: string | null; updatedAt: string; color: string | null; agentId?: string };
  const cards: Card[] = [
    ...(deliverables ?? []).map((d) => ({
      // Agent deliverables (reports…) are the headline artifacts — surface them in
      // the main section rather than burying them under "Other".
      id: d.id, title: d.name, kind: d.kind, table: "deliverable" as const,
      inRoom: true, author: "Agent", preview: null, updatedAt: d.created_at, color: null, agentId: d.agent_id,
    })),
    ...(docs ?? []).map((d) => ({
      id: d.id, title: d.title, kind: d.kind, table: "office_documents" as const,
      inRoom: roomId != null && (d as ArtifactDoc & { service_room_id?: string | null }).service_room_id === roomId,
      author: d.created_by && d.created_by === user?.id ? "You" : "Agent",
      preview: d.preview_text, updatedAt: d.updated_at,
      color: (d as ArtifactDoc & { card_color?: string | null }).card_color ?? null,
    })),
    ...(media ?? []).map((m) => ({
      id: m.id, title: m.prompt?.slice(0, 40) || "Image", kind: "image", table: "office_media" as const,
      inRoom: roomId != null && m.service_room_id === roomId, url: m.url, status: m.status,
      author: m.created_by && m.created_by === user?.id ? "You" : "Agent",
      preview: m.prompt, updatedAt: m.created_at, color: m.card_color ?? null,
    })),
  ];
  const q = search.trim().toLowerCase();
  const filtered = q ? cards.filter((c) => c.title.toLowerCase().includes(q)) : cards;
  const inRoom = roomId != null ? filtered.filter((c) => c.inRoom) : filtered;
  const other = roomId != null ? filtered.filter((c) => !c.inRoom) : [];



  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  async function uploadFile(file: File | undefined) {
    if (!file || !workspaceId || !projectId || !user) return;
    setUploading(true);
    try {
      const path = `${projectId}/${crypto.randomUUID()}-${file.name}`;
      const { error: upErr } = await supabase.storage.from("office-media").upload(path, file);
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("office-media").getPublicUrl(path);
      const { error: dbErr } = await supabase.from("office_media").insert({
        workspace_id: workspaceId, project_id: projectId, service_room_id: roomId,
        kind: file.type.startsWith("image/") ? "image" : "file", prompt: file.name, provider: "upload",
        status: "ready", url: pub.publicUrl, storage_path: path, created_by: user.id,
      });
      if (dbErr) throw dbErr;
      queryClient.invalidateQueries({ queryKey: ["room_office_media", projectId] });
      toast.success("Fichier envoyé avec succès.");
    } catch (err: any) {
      console.error("Failed to upload file", err);
      toast.error("Erreur téléversement : " + (err.message || "Erreur réseau"));
    } finally {
      setUploading(false);
    }
  }

  const gridCols = dense ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
  // Mosaic, not a table of equal boxes: three columns on wide screens with
  // tiles of uneven height (auto-rows + a taller span every fifth card), the
  // rhythm of the testimonial wall this is modelled on.
  const cardGridCols = dense
    ? "grid-cols-1 sm:grid-cols-2 auto-rows-[minmax(168px,auto)]"
    : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-[minmax(176px,auto)]";
  const cardH = dense ? "h-44" : "h-52";

  const descOf = (c: Card) => c.preview?.trim().slice(0, 140) || `${c.kind} · ${c.author}`;

  // Everything opens INLINE in this panel (deliverables too — no more navigating
  // away to /agent/internal/.../deliverables).
  const openCard = (c: Card) => {
    {
      onOpen({ id: c.id, table: c.table as ArtifactOpenTarget["table"], kind: c.kind, title: c.title, agentId: c.agentId });
    }
  };

  // The agents behind the artifacts, for the contributor avatar on each card —
  // the mosaic puts the author's face where a testimonial wall puts a portrait.
  const cardAgentIds = [...new Set((deliverables ?? []).map((d) => d.agent_id).filter(Boolean))] as string[];
  const { data: agentById } = useQuery({
    queryKey: ["artifact_agents", cardAgentIds.join(",")],
    enabled: cardAgentIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name, avatar_url").in("id", cardAgentIds);
      return new Map((data ?? []).map((a) => [(a as { id: string }).id, a as { id: string; name: string; avatar_url: string | null }]));
    },
  });

  // Delete an artifact whatever table it lives in. Confirmed, because there is
  // no undo: a deliverable holds the only copy of a report's content.
  async function deleteCard(c: Card) {
    if (!confirm(`Supprimer « ${c.title || "Sans titre"} » ? Cette action est définitive.`)) return;
    const table = c.table === "deliverable" ? "internal_agent_deliverables" : c.table;
    const { error } = await supabase.from(table).delete().eq("id", c.id);
    if (error) { toast.error(`Suppression impossible : ${error.message}`); return; }
    for (const k of ["dash_deliverables", "room_office_docs", "room_office_media"]) {
      queryClient.invalidateQueries({ queryKey: [k, projectId] });
    }
    toast.success("Artifact supprimé.");
  }

  async function setCardColor(c: Card, key: string | null) {
    await supabase.from(c.table).update({ card_color: key }).eq("id", c.id);
    queryClient.invalidateQueries({ queryKey: ["room_office_docs", projectId] });
    queryClient.invalidateQueries({ queryKey: ["room_office_media", projectId] });
  }
  const addTileClass = cn("group flex flex-col rounded-2xl bg-muted/50 p-4 text-left transition-colors hover:bg-muted/70", cardH);
  const dashedFrame = "flex h-full w-[46%] max-w-[7rem] items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/25 bg-background/50";

  // Hand-authored artifacts are back — in the new format. The tile creates an
  // EMPTY Editor.js document and opens it; there is no other shape to choose
  // from than the two the renderer knows.
  async function createBlank(kind: "report" | "presentation") {
    if (!workspaceId || !projectId || !user) { toast.error("Projet non sélectionné."); return; }
    const { data, error } = await supabase.from("office_documents").insert({
      workspace_id: workspaceId, project_id: projectId, service_room_id: roomId,
      kind, title: kind === "presentation" ? "Nouvelle présentation" : "Nouveau rapport",
      content: { blocks: [] }, created_by: user.id,
    }).select("id").single();
    if (error) { toast.error("Création impossible : " + error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["room_office_docs", projectId] });
    if (data) onOpen({ id: (data as { id: string }).id, table: "office_documents", kind, title: "" });
  }

  const newArtifactTile = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={addTileClass}>
          <div>
            <div className="text-[15px] font-semibold text-foreground">Nouvel artifact</div>
            <div className="mt-0.5 text-xs text-muted-foreground">Rapport ou présentation</div>
          </div>
          <div className="flex flex-1 items-center justify-center pt-3">
            <div className={dashedFrame}><Plus className="h-6 w-6 text-muted-foreground/45" /></div>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="rounded-xl">
        <DropdownMenuItem onClick={() => createBlank("report")}><FileText className="mr-2 h-4 w-4" /> Rapport</DropdownMenuItem>
        <DropdownMenuItem onClick={() => createBlank("presentation")}><Presentation className="mr-2 h-4 w-4" /> Présentation</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const uploadFileTile = (
    <button type="button" className={addTileClass} onClick={() => fileInputRef.current?.click()}>
      <div>
        <div className="text-[15px] font-semibold text-foreground">Upload file</div>
        <div className="mt-0.5 text-xs text-muted-foreground">File artifact</div>
      </div>
      <div className="flex flex-1 items-center justify-center pt-3">
        <div className={dashedFrame}>
          {uploading ? <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/50" /> : <Upload className="h-5 w-5 text-muted-foreground/45" />}
        </div>
      </div>
    </button>
  );

  return (
    <div className={cn("h-full overflow-y-auto p-4", dense ? "pt-16" : "pt-6 sm:px-6")}>
      <div className={cn("flex flex-col", !dense && "mx-auto max-w-5xl")}>
        {!dense && <h1 className="mb-4 text-lg font-semibold">Artifacts</h1>}
        <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => { uploadFile(e.target.files?.[0]); e.target.value = ""; }} />
        <div className="relative mb-5">
          <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search artifacts"
            className="w-full rounded-2xl border border-border bg-background py-2.5 pl-11 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/20"
          />
        </div>

        {/* Management actions keep their compact tiles. */}
        {!search && (
          <div className={cn("mb-6 grid gap-3", gridCols)}>
            {newArtifactTile}
            {uploadFileTile}
          </div>
        )}

        {deliverablesError && (
          <div className="mb-4 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            Les livrables des agents n'ont pas pu être chargés : {deliverablesError instanceof Error ? deliverablesError.message : "erreur inconnue"}.
            Les documents ci-dessous restent affichés.
          </div>
        )}

        {roomId != null && <div className="mb-2.5 text-sm font-semibold text-foreground">Artifacts in this room</div>}
        <motion.div initial="hidden" animate="visible" transition={{ staggerChildren: 0.06 }} className={cn("mb-6 grid gap-6", cardGridCols)}>
          {inRoom.map((c, i) => (
            <ArtifactCardItem key={c.table + "-" + c.id} color={c.color}
              title={c.title || 'Untitled'} description={descOf(c)} kind={c.kind}
              tone={i % 5 === 1 ? "accent" : i % 5 === 4 ? "grid" : "dark"}
              tall={i % 5 === 0 || i % 5 === 4}
              agent={c.agentId ? agentById?.get(c.agentId) : undefined}
              onOpen={() => openCard(c)}
              onColor={(key) => setCardColor(c, key)}
              onDelete={() => deleteCard(c)} />
          ))}
        </motion.div>

        {other.length > 0 && (
          <>
            <div className="mb-2.5 text-sm font-semibold text-foreground">Other artifacts</div>
            <motion.div initial="hidden" animate="visible" transition={{ staggerChildren: 0.06 }} className={cn("grid gap-6", cardGridCols)}>
              {other.map((c, i) => (
            <ArtifactCardItem key={c.table + "-" + c.id} color={c.color}
              title={c.title || 'Untitled'} description={descOf(c)} kind={c.kind}
              tone={i % 5 === 1 ? "accent" : i % 5 === 4 ? "grid" : "dark"}
              tall={i % 5 === 0 || i % 5 === 4}
              agent={c.agentId ? agentById?.get(c.agentId) : undefined}
              onOpen={() => openCard(c)}
              onColor={(key) => setCardColor(c, key)}
              onDelete={() => deleteCard(c)} />
          ))}
            </motion.div>
          </>
        )}
      </div>
    </div>
  );
}

// A shader WarpCard plus a hover picker (top-right) to choose its shader preset.
// The picker stops propagation so choosing a preset doesn't open the artifact.
/**
 * One artifact tile of the mosaic.
 *
 * Modelled on the testimonial wall: the content sits at the BOTTOM of the tile
 * (`mt-auto`), the identity line on the left, the portrait on the right — except
 * the portrait is the avatar of the agent that produced the artifact, not a
 * person. Three tones alternate across the grid so the wall reads as a
 * composition rather than a table of identical boxes.
 */
function ArtifactCardItem({
  title, description, kind, tone, tall, agent, color, onOpen, onColor, onDelete,
}: {
  title: string; description: string; kind: string;
  tone: "dark" | "accent" | "grid";
  /** Spans two rows in the mosaic — what breaks the grid of equal boxes. */
  tall?: boolean;
  /** The agent that produced it, when there is one. */
  agent?: { name: string; avatar_url: string | null };
  color: string | null;
  onOpen: () => void; onColor: (key: string | null) => void; onDelete: () => void;
}) {
  const Icon = KIND_ICON[kind] ?? FileText;
  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      className={cn(
        "group/card relative flex h-full min-h-[168px] cursor-pointer flex-col justify-between overflow-hidden rounded-lg border p-5 transition-shadow hover:shadow-lg",
        tall && "lg:row-span-2",
        tone === "accent" ? "border-blue-500/40 bg-blue-600 text-white"
          : "border-border bg-[#111111] text-white",
      )}
    >
      {/* The graph-paper wash of the reference's light tiles. */}
      {tone === "grid" && (
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:50px_56px] [mask-image:radial-gradient(ellipse_80%_50%_at_50%_0%,#000_70%,transparent_110%)]" />
      )}

      <span className="relative flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-white/50">
        <Icon className="h-3.5 w-3.5" /> {kind}
      </span>

      <article className="relative mt-auto">
        <p className="line-clamp-3 text-sm text-white/80">{description}</p>
        <div className="flex items-end justify-between gap-3 pt-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold leading-tight">{title}</h2>
            <p className="truncate text-sm text-white/60">{agent ? agent.name : "Vous"}</p>
          </div>
          {agent ? (
            <AgentIdentity url={agent.avatar_url} seed={agent.name} size={56} rounded="rounded-xl"
              className="shrink-0 ring-1 ring-white/15" />
          ) : (
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-white/10">
              <Icon className="h-6 w-6 text-white/70" />
            </span>
          )}
        </div>
      </article>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            title="Style de la carte"
            className="absolute right-4 top-4 z-20 flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-white opacity-0 backdrop-blur transition-opacity hover:bg-white/25 group-hover/card:opacity-100"
          >
            <Palette className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto rounded-2xl p-2" onClick={(e) => e.stopPropagation()}>
          <div className="grid grid-cols-3 gap-1.5">
            {WARP_CONFIGS.map((c) => (
              <button
                key={c.key}
                type="button"
                title={c.label}
                onClick={(e) => { e.stopPropagation(); onColor(c.key); }}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-lg ring-2 ring-transparent transition hover:scale-105",
                  color === c.key && "ring-ring",
                )}
                style={{ backgroundImage: cssGradientForConfig(c.config) }}
              >
                {color === c.key && <Check className="h-3.5 w-3.5 text-white drop-shadow" />}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="mt-2 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" /> Supprimer
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onColor(null); }}
            className="mt-1 w-full rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Style par défaut
          </button>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

