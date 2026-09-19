import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MagnifyingGlassIcon as Search,
  PlusIcon as Plus,
  UploadSimpleIcon as Upload,
  FileTextIcon as FileText,
  PresentationChartIcon as Presentation,
  TableIcon,
  ImageIcon,
  TextTIcon as Type,
  CircleNotchIcon as Loader2,
  ArrowLeftIcon as ArrowLeft,
  PaletteIcon as Palette,
  CheckIcon as Check,
  TrashIcon as Trash2,
  PencilLineIcon as PencilLine,
  EyeIcon as Eye,
  RobotIcon as Bot,
  HashIcon as Hash,
  TargetIcon as Target,
  CaretDownIcon as ChevronDown,
  XIcon as X,
  ArrowSquareOutIcon as ExternalLink,
} from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ToastProvider";
import { CodeBlock, CodeBlockCode } from "@/components/ui/code-block";
import { type ArtifactDoc } from "@/features/artifacts/shared";
import { ArtifactWorkspace } from "@/features/artifacts/ArtifactWorkspace";
import { ArtifactEditor } from "@/features/artifacts/ArtifactEditor";
import { type ArtifactOpenTarget } from "@/features/internal-agents/UiBlocks";
import { AgentIdentity } from "@/components/AgentIdentity";
import { BrandLogo } from "@/components/BrandLogo";
import { ArtifactDeck, ArtifactHeader } from "@/features/artifacts/BlockRenderer";
import { parseDocument, type ArtifactDocument } from "@/features/artifacts/blocks";
import { parseReportArtisan, ReportArtisanView } from "@/features/artifacts/ReportArtisanView";

const KIND_ICON: Record<string, typeof FileText> = {
  document: FileText, presentation: Presentation, spreadsheet: TableIcon, image: ImageIcon, text: Type,
};

/**
 * The wall's palette. Slate and the graph-paper tile are the quiet majority;
 * the inks are what turn a list of boxes into a composition. Every ink is deep
 * enough to carry white text and the white/60 second line under it.
 *
 * A card's stored `card_color` holds one of these keys. Anything else (older
 * rows still carry a shader preset name) falls back to the draw below.
 */
const CARD_TONES = [
  { key: "dark", label: "Ardoise", swatch: "#111111", className: "border-border bg-[#111111]" },
  { key: "grid", label: "Quadrillé", swatch: "#1b1b1b", className: "border-border bg-[#111111]" },
  { key: "blue", label: "Bleu", swatch: "#4f46e5", className: "border-blue-500/40 bg-blue-600" },
  { key: "bordeaux", label: "Bordeaux", swatch: "#7b1e3a", className: "border-[#b04566]/40 bg-[#7b1e3a]" },
] as const;
type ToneKey = (typeof CARD_TONES)[number]["key"];
const TONE_BY_KEY = new Map(CARD_TONES.map((t) => [t.key, t]));

/**
 * Which tone a card wears when nobody picked one for it. Drawn from the card's
 * own id, not from its position in the list: a positional rotation of period 7
 * consumed exactly nine grid cells per cycle (seven cards plus the extra row of
 * the two tall ones), and nine on a three-column wall dropped every accent into
 * the same column. Hashing the id also keeps a card's colour stable when the
 * list is filtered or re-sorted.
 */
const TONE_BAG: ToneKey[] = [
  "dark", "blue", "dark", "grid", "dark", "bordeaux", "dark", "dark",
  "blue", "dark", "dark", "grid", "bordeaux", "dark", "dark",
];
/** FNV-1a, enough of a mixer to keep neighbouring uuids off the same bucket. */
function hashId(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
const toneAt = (id: string, custom: string | null): ToneKey =>
  (custom && TONE_BY_KEY.has(custom as ToneKey) ? (custom as ToneKey) : TONE_BAG[hashId(id) % TONE_BAG.length]);
/** The two tall slots per seven cards: what breaks the grid of equal boxes. */
const isTall = (index: number) => index % 7 === 0 || index % 7 === 4;

interface OfficeMediaRow { id: string; kind: string; url: string | null; status: string; created_at: string }

/** The three axes an artifact can be filtered along, all combined with AND. */
type FilterDim = "agent" | "room" | "mission";
type FilterOption = { id: string; label: string; count: number };

/**
 * One filter pill of the gallery's toolbar. Single choice per axis (the axes
 * combine, so "cet agent, dans cette mission" is one click each), with the
 * count of matching artifacts next to every option — a filter that would empty
 * the wall says so before you pick it.
 */
function FilterSelect({
  icon: Icon, label, empty, options, value, onChange,
}: {
  icon: typeof Bot; label: string; empty: string;
  options: FilterOption[];
  value: string | null; onChange: (id: string | null) => void;
}) {
  const selected = options.find((o) => o.id === value);
  const active = value != null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-2xl border px-3 py-2.5 text-sm transition-colors",
            active
              ? "border-foreground/25 bg-foreground/5 font-medium text-foreground"
              : "border-border bg-background text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          <span className="max-w-[8rem] truncate">{active ? (selected?.label ?? label) : label}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto rounded-xl">
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">{label}</DropdownMenuLabel>
        <DropdownMenuItem className="rounded-lg" onSelect={() => onChange(null)}>
          <span className="min-w-0 flex-1">Tous</span>
          {!active && <Check className="ml-2 h-3.5 w-3.5 text-primary" />}
        </DropdownMenuItem>
        {options.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            {options.map((o) => (
              <DropdownMenuItem key={o.id} className="rounded-lg" onSelect={() => onChange(o.id === value ? null : o.id)}>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                <span className="ml-2 text-[11px] tabular-nums text-muted-foreground">{o.count}</span>
                {o.id === value && <Check className="ml-1.5 h-3.5 w-3.5 text-primary" />}
              </DropdownMenuItem>
            ))}
          </>
        ) : (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{empty}</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
/**
 * La galerie des artefacts du service, et le lecteur qui s'ouvre par-dessus.
 *
 * Elle vivait dans son propre onglet, sous l'Assistant. Elle est maintenant
 * posée dans le Wiki du module de travail, et ce n'est pas un rangement : un
 * rapport produit par un agent et une page écrite à la main sont deux
 * DOCUMENTS du même service. Les tenir dans deux onglets obligeait à savoir,
 * avant de chercher, lequel des deux on cherchait — ce qu'on ignore justement
 * quand on cherche.
 *
 * La hauteur suit désormais le CONTENEUR (`h-full`) et non plus la fenêtre
 * moins la navbar : posée dans le Wiki, la mesure en `100vh` dépassait de la
 * hauteur de l'en-tête et poussait une barre de défilement de trop.
 */
export function ArtifactsBrowser({
  workspaceId, projectId,
}: { workspaceId: string; projectId: string | null }) {
  const [viewing, setViewing] = useState<ArtifactOpenTarget | null>(null);
  if (viewing) {
    return (
      <div className="h-full">
        <ArtifactViewer target={viewing} onBack={() => setViewing(null)} />
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto">
      <ArtifactGallery roomId={null} workspaceId={workspaceId} projectId={projectId} onOpen={setViewing} />
    </div>
  );
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
 * An agent's artifact, rendered — and editable.
 *
 * A report an agent wrote is not a receipt: the reader is the one who has to use
 * it, and a figure to correct or a paragraph to cut should not require asking
 * the agent again. Same Editor.js document, same renderer and same editor as a
 * hand-authored artifact; only the table differs (deliverables carry the run the
 * success contract verifies against).
 */
function DeliverableViewer({ id, title, onBack }: { id?: string; title: string; onBack: () => void }) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  // A report written by Le Rédacteur is a finished HTML file, not blocks: it is
  // shown as itself, with no editor and no app header (it carries its own).
  const built = parseReportArtisan(data?.content);

  // The header is system chrome now, so a `banner` block an older document still
  // carries would render a second title under the real one. Drop it from the
  // body and keep only its subtitle, which is the one part the agent knew and
  // the record does not.
  const legacyBanner = doc.blocks.find((b) => b.type === "banner");
  const subtitle = (legacyBanner?.data as { subtitle?: string } | undefined)?.subtitle;
  const body = legacyBanner ? { ...doc, blocks: doc.blocks.filter((b) => b.type !== "banner") } : doc;

  // Debounced write-back. `content` is a text column holding the JSON document,
  // so it is stringified here exactly as the agent wrote it.
  const persist = (next: ArtifactDocument) => {
    if (!id) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setSaving(true);
      try {
        await supabase.from("internal_agent_deliverables")
          .update({ content: JSON.stringify(next) }).eq("id", id);
        qc.invalidateQueries({ queryKey: ["room_deliverable_one", id] });
      } finally { setSaving(false); }
    }, 600);
  };

  return (
    <div className="relative flex h-full flex-col">
      {/* The only chrome left. A toolbar of one button is a toolbar that costs a
          strip of the document for nothing; this floats over the header instead. */}
      {!built && !isDeck && (
        <button
          type="button" onClick={onBack} aria-label="Retour aux artifacts"
          className="absolute left-3 top-3 z-30 flex h-8 w-8 items-center justify-center rounded-full bg-black/20 text-white backdrop-blur transition-colors hover:bg-black/35"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}
      <div className={built || isDeck ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto"}>
        {isLoading
          ? <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
          : built
          ? <ReportArtisanView payload={built} title={data?.name || title} onBack={onBack} />
          : isDeck
          // A deck is pages, not a scroll: it gets the whole panel and a thin bar,
          // where the full-bleed cover header would have eaten a third of the
          // first slide.
          ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
                <button
                  type="button" onClick={onBack} aria-label="Retour aux artifacts"
                  className="-ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <span className="truncate font-medium text-foreground">{data?.name || title}</span>
                <span className="hidden sm:inline">· présentation</span>
              </div>
              <div className="min-h-0 flex-1"><ArtifactDeck doc={body} fill title={data?.name || title} subtitle={subtitle} /></div>
            </div>
          )
          : (
            <>
              <ArtifactHeader
                title={data?.name || title}
                kind={isDeck ? "présentation" : "rapport"}
                subtitle={subtitle}
                cover={doc.cover}
                seed={id ?? title}
                // The cover lives in the document JSON, so it rides the same
                // debounced write as the blocks — no column, no second request.
                onCoverChange={(cover) => persist({ ...body, cover })}
                aside={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin text-white/70" /> : null}
              />
              {/* A report IS the editor: click anywhere and the caret is there,
                  with the block toolbar. No mode to switch, nothing to discover. */}
              <div className="mx-auto w-full max-w-[1060px] px-5 py-8 sm:px-8"><ArtifactEditor doc={body} onChange={persist} /></div>
            </>
          )}
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
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [roomFilter, setRoomFilter] = useState<string | null>(null);
  const [missionFilter, setMissionFilter] = useState<string | null>(null);

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
        .select("id, name, kind, created_at, agent_id, run_id, mission_id")
        .in("agent_id", ids)
        .order("created_at", { ascending: false }).limit(60);
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ id: string; name: string; kind: string; created_at: string; agent_id: string; run_id: string | null; mission_id: string | null }>;
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

  // Le travail produit AILLEURS (0211) : page Notion, issue Linear, doc Drive…
  // Il vit chez son hôte ; on n'en garde que l'adresse, donc la carte ouvre le
  // contenu réel au lieu d'en montrer une copie qui aurait déjà divergé.
  const { data: external } = useQuery({
    queryKey: ["room_external_artifacts", projectId],
    enabled: !!projectId,
    refetchInterval: 5000, // un agent peut en épingler un pendant qu'on regarde
    queryFn: async () => {
      const { data } = await supabase.from("external_artifacts")
        .select("id, title, url, provider, kind, summary, service_room_id, agent_id, created_by, card_color, created_at")
        .eq("project_id", projectId!).order("created_at", { ascending: false }).limit(60);
      return (data ?? []) as Array<{
        id: string; title: string; url: string; provider: string; kind: string;
        summary: string | null; service_room_id: string | null; agent_id: string | null;
        created_by: string | null; card_color: string | null; created_at: string;
      }>;
    },
  });

  // ── Provenance : de quelle room / mission sort un livrable ─────────────────
  // Un livrable ne porte que son agent et son run ; la room et la mission
  // pendent à ce run — une tâche de mission garde le run qui l'a exécutée, et
  // un tour de room garde le run derrière son message. On les résout ici, côté
  // client, pour que les filtres marchent aussi sur tout ce qui a été produit
  // avant : pas de colonne à ajouter, pas de backfill.
  const deliverableRunIds = useMemo(
    () => [...new Set((deliverables ?? []).map((d) => d.run_id).filter(Boolean))] as string[],
    [deliverables],
  );
  const { data: provenance } = useQuery({
    queryKey: ["artifact_provenance", projectId, deliverableRunIds.join(",")],
    enabled: deliverableRunIds.length > 0,
    queryFn: async () => {
      const [tasks, messages] = await Promise.all([
        supabase.from("service_room_tasks").select("run_id, mission_id").in("run_id", deliverableRunIds),
        supabase.from("service_room_messages").select("run_id, room_id, mission_id").in("run_id", deliverableRunIds),
      ]);
      const byRun = new Map<string, { roomId: string | null; missionId: string | null }>();
      const put = (runId: string | null, roomId: string | null, missionId: string | null) => {
        if (!runId) return;
        const cur = byRun.get(runId) ?? { roomId: null, missionId: null };
        byRun.set(runId, { roomId: cur.roomId ?? roomId, missionId: cur.missionId ?? missionId });
      };
      for (const m of (messages.data ?? []) as Array<{ run_id: string | null; room_id: string | null; mission_id: string | null }>) {
        put(m.run_id, m.room_id, m.mission_id);
      }
      for (const t of (tasks.data ?? []) as Array<{ run_id: string | null; mission_id: string | null }>) {
        put(t.run_id, null, t.mission_id);
      }
      // Le run d'une tâche connaît sa mission mais pas sa room : la mission, si.
      const missionIds = [...new Set([...byRun.values()].map((v) => v.missionId).filter(Boolean))] as string[];
      if (missionIds.length > 0) {
        const { data: rows } = await supabase.from("service_room_missions").select("id, room_id").in("id", missionIds);
        const roomOfMission = new Map((rows ?? []).map((m) => [(m as { id: string }).id, (m as { room_id: string | null }).room_id]));
        for (const [runId, v] of byRun) {
          if (!v.roomId && v.missionId) byRun.set(runId, { ...v, roomId: roomOfMission.get(v.missionId) ?? null });
        }
      }
      return byRun;
    },
  });

  // Les libellés des filtres. Chargés pour tout le projet (deux listes bornées)
  // plutôt que par ids : la clé de requête reste stable pendant qu'on filtre.
  const { data: roomNames } = useQuery({
    queryKey: ["artifact_filter_rooms", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("service_rooms").select("id, title")
        .eq("project_id", projectId!).order("updated_at", { ascending: false }).limit(200);
      return new Map((data ?? []).map((r) => [(r as { id: string }).id, (r as { title: string | null }).title || "Room sans titre"]));
    },
  });
  // Deux tables portent le mot « mission » : celles d'une room (l'onglet
  // Missions) et celles d'un agent (ce qu'on programme dans Schedules). Un
  // rapport peut sortir de l'une ou de l'autre, et de la fenêtre des filtres
  // les deux sont la même chose — une seule liste, donc.
  const { data: missionNames } = useQuery({
    queryKey: ["artifact_filter_missions", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const [rooms, agents] = await Promise.all([
        supabase.from("service_room_missions").select("id, title")
          .eq("project_id", projectId!).order("updated_at", { ascending: false }).limit(200),
        supabase.from("internal_agent_missions").select("id, title")
          .eq("project_id", projectId!).order("updated_at", { ascending: false }).limit(200),
      ]);
      const rows = [...(rooms.data ?? []), ...(agents.data ?? [])] as Array<{ id: string; title: string | null }>;
      return new Map(rows.map((m) => [m.id, m.title || "Mission sans titre"]));
    },
  });

  type Card = {
    id: string; title: string; kind: string;
    table: "office_documents" | "office_media" | "deliverable" | "external";
    inRoom: boolean; author: string; url?: string | null; status?: string;
    preview?: string | null; updatedAt: string; color: string | null;
    agentId?: string; roomId?: string | null; missionId?: string | null;
    /** Artifacts externes : le slug de l'outil, pour le logo sur la carte. */
    provider?: string;
  };
  const cards: Card[] = [
    ...(deliverables ?? []).map((d) => ({
      // Agent deliverables (reports…) are the headline artifacts — surface them in
      // the main section rather than burying them under "Other".
      id: d.id, title: d.name, kind: d.kind, table: "deliverable" as const,
      inRoom: true, author: "Agent", preview: null, updatedAt: d.created_at, color: null, agentId: d.agent_id,
      roomId: (d.run_id ? provenance?.get(d.run_id)?.roomId : null) ?? null,
      // La mission de room l'emporte : elle est la maille que l'utilisateur voit.
      missionId: (d.run_id ? provenance?.get(d.run_id)?.missionId : null) ?? d.mission_id ?? null,
    })),
    ...(docs ?? []).map((d) => ({
      id: d.id, title: d.title, kind: d.kind, table: "office_documents" as const,
      inRoom: roomId != null && (d as ArtifactDoc & { service_room_id?: string | null }).service_room_id === roomId,
      author: d.created_by && d.created_by === user?.id ? "You" : "Agent",
      preview: d.preview_text, updatedAt: d.updated_at,
      color: (d as ArtifactDoc & { card_color?: string | null }).card_color ?? null,
      roomId: (d as ArtifactDoc & { service_room_id?: string | null }).service_room_id ?? null,
      missionId: null,
    })),
    ...(external ?? []).map((x) => ({
      id: x.id, title: x.title, kind: x.kind, table: "external" as const,
      inRoom: roomId != null && x.service_room_id === roomId,
      author: x.created_by && x.created_by === user?.id ? "You" : "Agent",
      url: x.url, preview: x.summary, updatedAt: x.created_at, color: x.card_color ?? null,
      agentId: x.agent_id ?? undefined, roomId: x.service_room_id ?? null, missionId: null,
      provider: x.provider,
    })),
    ...(media ?? []).map((m) => ({
      id: m.id, title: m.prompt?.slice(0, 40) || "Image", kind: "image", table: "office_media" as const,
      inRoom: roomId != null && m.service_room_id === roomId, url: m.url, status: m.status,
      author: m.created_by && m.created_by === user?.id ? "You" : "Agent",
      preview: m.prompt, updatedAt: m.created_at, color: m.card_color ?? null,
      roomId: m.service_room_id ?? null, missionId: null,
    })),
  ];

  // ── Filtres : agent / room / mission, combinés en ET avec la recherche ─────
  // Un artifact sans agent (un document écrit à la main) ou sans mission sort
  // du lot dès qu'on filtre sur cette dimension : c'est la réponse juste à
  // « montre-moi ce que cet agent a produit ».
  const q = search.trim().toLowerCase();
  const matches = (c: Card, ignore?: FilterDim) =>
    (!q || c.title.toLowerCase().includes(q))
    && (ignore === "agent" || !agentFilter || c.agentId === agentFilter)
    && (ignore === "room" || !roomFilter || c.roomId === roomFilter)
    && (ignore === "mission" || !missionFilter || c.missionId === missionFilter);

  const filtered = cards.filter((c) => matches(c));
  const inRoom = roomId != null ? filtered.filter((c) => c.inRoom) : filtered;
  const other = roomId != null ? filtered.filter((c) => !c.inRoom) : [];
  const activeFilters = [agentFilter, roomFilter, missionFilter].filter(Boolean).length;
  const resetFilters = () => { setAgentFilter(null); setRoomFilter(null); setMissionFilter(null); };



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
    // Un artifact externe n'a pas de visionneuse ici : le contenu vit chez son
    // hôte, et l'ouvrir ailleurs qu'à sa source donnerait une copie figée.
    // `noopener` parce que la page ouverte peut réécrire celle qui l'a ouverte.
    if (c.table === "external") {
      if (c.url) window.open(c.url, "_blank", "noopener,noreferrer");
      return;
    }
    onOpen({ id: c.id, table: c.table as ArtifactOpenTarget["table"], kind: c.kind, title: c.title, agentId: c.agentId });
  };

  // The agents behind the artifacts, for the contributor avatar on each card —
  // the mosaic puts the author's face where a testimonial wall puts a portrait.
  // Tiré des CARTES, pas des seuls livrables : un artifact externe porte lui
  // aussi son agent, et le lire ailleurs laissait son nom absent du filtre et
  // son portrait absent de la carte.
  const cardAgentIds = [...new Set(cards.map((c) => c.agentId).filter(Boolean))] as string[];
  const { data: agentById } = useQuery({
    queryKey: ["artifact_agents", cardAgentIds.join(",")],
    enabled: cardAgentIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name, avatar_url").in("id", cardAgentIds);
      return new Map((data ?? []).map((a) => [(a as { id: string }).id, a as { id: string; name: string; avatar_url: string | null }]));
    },
  });

  // Les options d'un filtre sont tirées des artifacts eux-mêmes — jamais de la
  // liste complète des agents/rooms/missions : on ne propose que ce qui a
  // réellement produit quelque chose, compté sous les AUTRES filtres actifs,
  // pour qu'aucun choix ne mène à une grille vide.
  const optionsFor = (
    dim: FilterDim, keyOf: (c: Card) => string | null | undefined, nameOf: (id: string) => string | undefined,
  ): FilterOption[] => {
    const counts = new Map<string, number>();
    for (const c of cards) {
      const id = keyOf(c);
      if (!id || !matches(c, dim)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ id, label: nameOf(id) ?? "Sans titre", count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  const agentOptions = optionsFor("agent", (c) => c.agentId, (id) => agentById?.get(id)?.name);
  const roomOptions = optionsFor("room", (c) => c.roomId, (id) => roomNames?.get(id));
  const missionOptions = optionsFor("mission", (c) => c.missionId, (id) => missionNames?.get(id));

  // Delete an artifact whatever table it lives in. Confirmed, because there is
  // no undo: a deliverable holds the only copy of a report's content.
  async function deleteCard(c: Card) {
    if (!confirm(`Supprimer « ${c.title || "Sans titre"} » ? Cette action est définitive.`)) return;
    const table = c.table === "deliverable" ? "internal_agent_deliverables"
      : c.table === "external" ? "external_artifacts"
      : c.table;
    const { error } = await supabase.from(table).delete().eq("id", c.id);
    if (error) { toast.error(`Suppression impossible : ${error.message}`); return; }
    for (const k of ["dash_deliverables", "room_office_docs", "room_office_media", "room_external_artifacts"]) {
      queryClient.invalidateQueries({ queryKey: [k, projectId] });
    }
    toast.success("Artifact supprimé.");
  }

  async function setCardColor(c: Card, key: string | null) {
    await supabase.from(c.table).update({ card_color: key }).eq("id", c.id);
    queryClient.invalidateQueries({ queryKey: ["room_office_docs", projectId] });
    queryClient.invalidateQueries({ queryKey: ["room_office_media", projectId] });
  }
  const addTileClass = cn("group flex flex-col rounded-3xl bg-muted/50 p-4 text-left transition-colors hover:bg-muted/70", cardH);
  const dashedFrame = "flex h-full w-[46%] max-w-[7rem] items-center justify-center rounded-2xl border-2 border-dashed border-muted-foreground/25 bg-background/50";

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
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search artifacts"
              className="w-full rounded-2xl border border-border bg-background py-2.5 pl-11 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/20"
            />
          </div>
          <FilterSelect icon={Bot} label="Agent" empty="Aucun artifact rattaché à un agent."
            options={agentOptions} value={agentFilter} onChange={setAgentFilter} />
          <FilterSelect icon={Hash} label="Room" empty="Aucun artifact rattaché à une room."
            options={roomOptions} value={roomFilter} onChange={setRoomFilter} />
          <FilterSelect icon={Target} label="Mission" empty="Aucun artifact produit dans une mission."
            options={missionOptions} value={missionFilter} onChange={setMissionFilter} />
          {activeFilters > 0 && (
            <button
              type="button" onClick={resetFilters}
              className="flex items-center gap-1 rounded-2xl px-2 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" /> Réinitialiser
            </button>
          )}
        </div>

        {/* Management actions keep their compact tiles. */}
        {!search && activeFilters === 0 && (
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

        {filtered.length === 0 && (q !== "" || activeFilters > 0) && (
          <div className="rounded-3xl border border-dashed border-border/70 py-14 text-center">
            <p className="text-sm font-medium">Aucun artifact ne correspond</p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">Élargissez la recherche, ou retirez un filtre.</p>
            {activeFilters > 0 && (
              <button
                type="button" onClick={resetFilters}
                className="mt-4 rounded-full border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
              >
                Réinitialiser les filtres
              </button>
            )}
          </div>
        )}

        {roomId != null && inRoom.length > 0 && <div className="mb-2.5 text-sm font-semibold text-foreground">Artifacts in this room</div>}
        <motion.div initial="hidden" animate="visible" transition={{ staggerChildren: 0.06 }} className={cn("mb-6 grid gap-6", cardGridCols)}>
          {inRoom.map((c, i) => (
            <ArtifactCardItem key={c.table + "-" + c.id} color={c.color}
              title={c.title || 'Untitled'} description={descOf(c)} kind={c.kind}
              tone={toneAt(c.id, c.color)}
              tall={isTall(i)}
              provider={c.provider}
              href={c.table === "external" ? c.url ?? undefined : undefined}
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
              tone={toneAt(c.id, c.color)}
              tall={isTall(i)}
              provider={c.provider}
              href={c.table === "external" ? c.url ?? undefined : undefined}
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

// The hover picker (top-right) sets the card's tone. It stops propagation so
// choosing a colour doesn't open the artifact underneath.
/**
 * One artifact tile of the mosaic.
 *
 * Modelled on the testimonial wall: the content sits at the BOTTOM of the tile
 * (`mt-auto`), the identity line on the left, the portrait on the right — except
 * the portrait is the avatar of the agent that produced the artifact, not a
 * person. The tone comes from the palette above — the card's own colour when
 * someone picked one, the rotation otherwise — so the wall reads as a
 * composition rather than a table of identical boxes.
 */
function ArtifactCardItem({
  title, description, kind, tone, tall, agent, color, provider, href, onOpen, onColor, onDelete,
}: {
  title: string; description: string; kind: string;
  tone: ToneKey;
  /** Spans two rows in the mosaic — what breaks the grid of equal boxes. */
  tall?: boolean;
  /** The agent that produced it, when there is one. */
  agent?: { name: string; avatar_url: string | null };
  color: string | null;
  /** External artifacts: the tool that holds the content, as a logo slug. */
  provider?: string;
  /** Where an external artifact really lives. Present = the card is a LINK, so
   *  it gets the affordances of one: middle-click, ⌘-click, "copy address". A
   *  div with an onClick has none of that, and a card that opens another site
   *  had better behave like every other link on the web. */
  href?: string;
  onOpen: () => void; onColor: (key: string | null) => void; onDelete: () => void;
}) {
  const Icon = KIND_ICON[kind] ?? FileText;
  const paint = TONE_BY_KEY.get(tone) ?? CARD_TONES[0];
  // An external artifact IS a link, so it renders as one: ⌘-click opens a tab,
  // middle-click too, the status bar shows where it goes and "copy link address"
  // works. A div with an onClick offers none of that, and a card that leaves the
  // app should behave like every other link on the web.
  const Root = (href ? "a" : "div") as "a" | "div";
  return (
    <Root
      {...(href
        ? { href, target: "_blank", rel: "noopener noreferrer" }
        : { role: "button", tabIndex: 0, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter") onOpen(); } })}
      onClick={(e: React.MouseEvent) => {
        // Let the browser handle the modified clicks it already handles well.
        if (href && (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) return;
        e.preventDefault();
        onOpen();
      }}
      className={cn(
        "group/card relative flex h-full min-h-[168px] cursor-pointer flex-col justify-between overflow-hidden rounded-3xl border p-5 text-white no-underline transition-shadow hover:shadow-lg",
        tall && "lg:row-span-2",
        paint.className,
      )}
    >
      {/* The graph-paper wash of the reference's light tiles. */}
      {tone === "grid" && (
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:50px_56px] [mask-image:radial-gradient(ellipse_80%_50%_at_50%_0%,#000_70%,transparent_110%)]" />
      )}

      {/* The tool's own mark, on the tone the wall gives it: white-backed so a
          dark brand logo (Notion, GitHub) stays readable on a dark card. */}
      <span className="relative flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-white/50">
        {provider ? (
          <>
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-white/95 shadow-sm">
              <BrandLogo slug={provider} className="h-3 w-3" />
            </span>
            <span className="truncate">{kind}</span>
            <ExternalLink className="h-3 w-3 shrink-0 opacity-70" aria-label="S'ouvre dans l'outil" />
          </>
        ) : (
          <><Icon className="h-3.5 w-3.5" /> {kind}</>
        )}
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
          <div className="grid grid-cols-4 gap-1.5">
            {CARD_TONES.map((t) => (
              <button
                key={t.key}
                type="button"
                title={t.label}
                onClick={(e) => { e.stopPropagation(); onColor(t.key); }}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full ring-2 ring-transparent ring-offset-2 ring-offset-popover transition hover:scale-105",
                  color === t.key && "ring-ring",
                )}
                style={{ background: t.swatch }}
              >
                {color === t.key && <Check className="h-3.5 w-3.5 text-white drop-shadow" />}
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
    </Root>
  );
}

