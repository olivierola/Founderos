import { useState, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MagnifyingGlassIcon as Search,
  StarIcon as Star,
  DownloadSimpleIcon as Download,
  ArrowSquareOutIcon as ExternalLink,
  FileTextIcon as FileText,
  FileCodeIcon as FileJson,
  FileCodeIcon as FileCode,
  LinkSimpleIcon as Link2,
  PaperclipIcon as Paperclip,
  PackageIcon as Package,
  FunnelIcon as Filter,
  XIcon as X,
  TargetIcon as Target,
  ArrowLeftIcon as ArrowLeft,
  ChartBarIcon as BarChart3,
  GitPullRequestIcon as GitPullRequest,
  FlaskIcon as FlaskConical,
  AtomIcon as Atom,
  PresentationChartIcon as Presentation,
} from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  type InternalAgent, type Deliverable, type Mission,
  downloadDeliverable, relativeDate,
} from "./shared";
import { ArtifactReport, ArtifactDeck } from "@/features/artifacts/BlockRenderer";
import { parseDocument } from "@/features/artifacts/blocks";
import { parseReportArtisan, ReportArtisanView } from "@/features/artifacts/ReportArtisanView";
import { CodingSession, tryParseCodingSession } from "./CodingSession";
import {
  TestSession, SimulationSession, tryParseTestSession, tryParseSimulationSession,
} from "./StudioSessions";
import { PerspectiveBook } from "@/components/ui/perspective-book";

// Sober but defined book-cover palette (works on the dark odin theme). Each cover
// is a muted "clothbound" jewel tone with white text on top.
const BOOK_COVERS: { bg: string; fg: string; sheen: string }[] = [
  { bg: "#33414f", fg: "#ffffff", sheen: "#46586a" }, // slate-blue
  { bg: "#1f4a40", fg: "#ffffff", sheen: "#2e6557" }, // pine
  { bg: "#4c3d23", fg: "#ffffff", sheen: "#665232" }, // amber
  { bg: "#46293f", fg: "#ffffff", sheen: "#5e3854" }, // plum
  { bg: "#263359", fg: "#ffffff", sheen: "#374878" }, // navy
  { bg: "#522f26", fg: "#ffffff", sheen: "#6e4135" }, // terracotta
  { bg: "#2f4a2c", fg: "#ffffff", sheen: "#42653d" }, // moss
  { bg: "#352c52", fg: "#ffffff", sheen: "#493d6e" }, // indigo
];

function coverFor(id: string): { bg: string; fg: string; sheen: string } {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return BOOK_COVERS[h % BOOK_COVERS.length];
}

// Mix a hex colour toward black — used for the darker spine / back cloth.
function darken(hex: string, amt = 0.5): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c * (1 - amt)));
  return "#" + ch.map((c) => c.toString(16).padStart(2, "0")).join("");
}

// The type a reader sees. Raw kinds are storage words ("presentation",
// "markdown"); a card is read by a human.
const KIND_LABEL: Record<string, string> = {
  report: "Rapport", presentation: "Présentation", markdown: "Document",
  json: "Données", code: "Code", url: "Lien", file: "Fichier", csv: "Tableur",
  coding_session: "Session de code", test_session: "Session de test",
  simulation_session: "Simulation",
};

const KIND_ICON: Record<string, any> = {
  report: BarChart3,
  presentation: Presentation,
  coding_session: GitPullRequest,
  test_session: FlaskConical,
  simulation_session: Atom,
  markdown: FileText,
  json: FileJson,
  code: FileCode,
  url: Link2,
  file: Paperclip,
};

// Renders a deliverable's body by kind: structured report, markdown (with
// embedded charts), code/json, or url.
function DeliverableBody({ d }: { d: Deliverable }) {
  // Studio artifacts first: each has its own session view (diffs & PR, cases &
  // defects, cohorts & quotes) and would otherwise fall through to raw JSON.
  const coding = tryParseCodingSession(d.content);
  if (coding) return <CodingSession session={coding} />;
  const test = tryParseTestSession(d.content);
  if (test) return <TestSession session={test} />;
  const sim = tryParseSimulationSession(d.content);
  if (sim) return <SimulationSession session={sim} />;

  // Reports and decks are Editor.js documents now — one renderer, no
  // format sniffing. Anything that is not one of the session kinds above and
  // not a url/json/code payload IS a block document.
  if (d.kind === "url") {
    return (
      <a href={d.content ?? d.file_url ?? "#"} target="_blank" rel="noreferrer" className="break-all text-sm text-primary underline">
        {d.content ?? d.file_url}
      </a>
    );
  }
  if (d.kind === "json" || d.kind === "code") {
    return <pre className="overflow-x-auto rounded-xl border border-border bg-muted/40 p-3 text-xs"><code>{d.content ?? "(no inline content)"}</code></pre>;
  }
  // A Rédacteur report is a finished HTML file, not blocks — show the file.
  const built = parseReportArtisan(d.content);
  // Inside a scrolling list the frame cannot fill its parent — it gets a height
  // of its own, and its own full-screen button for reading it properly.
  if (built) return <ReportArtisanView payload={built} title={d.name} fill={false} height="min(75vh, 820px)" />;

  const doc = parseDocument(d.content);
  return d.kind === "presentation" ? <ArtifactDeck doc={doc} title={d.name} /> : <ArtifactReport doc={doc} />;
}

export function DeliverablesHub({ agent }: { agent: InternalAgent }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [missionFilter, setMissionFilter] = useState<string | null>(null);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  // Selected deliverable opens inline (replaces the grid), not in a modal.
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("d"));

  // Deep-link: ?d=<id> (e.g. from a chat artifact card) opens that deliverable.
  useEffect(() => {
    const d = searchParams.get("d");
    if (d && d !== selectedId) setSelectedId(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function selectDeliverable(id: string | null) {
    setSelectedId(id);
    const next = new URLSearchParams(searchParams);
    if (id) next.set("d", id); else next.delete("d");
    setSearchParams(next, { replace: true });
  }

  const { data: deliverables, isLoading } = useQuery({
    queryKey: ["internal_agent_all_deliverables", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_deliverables")
        .select("id, run_id, mission_id, agent_id, kind, name, content, file_url, summary, is_pinned, created_at")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: false });
      return (data ?? []) as Deliverable[];
    },
  });

  const { data: missions } = useQuery({
    queryKey: ["internal_agent_missions_min", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_missions")
        .select("id, title")
        .eq("agent_id", agent.id);
      return (data ?? []) as Pick<Mission, "id" | "title">[];
    },
  });

  const missionTitle = useMemo(() => {
    const map: Record<string, string> = {};
    (missions ?? []).forEach((m) => { map[m.id] = m.title; });
    return map;
  }, [missions]);

  const kinds = useMemo(
    () => Array.from(new Set((deliverables ?? []).map((d) => d.kind))),
    [deliverables],
  );

  const filtered = useMemo(() => {
    let list = deliverables ?? [];
    if (pinnedOnly) list = list.filter((d) => d.is_pinned);
    if (kindFilter) list = list.filter((d) => d.kind === kindFilter);
    if (missionFilter) list = list.filter((d) => d.mission_id === missionFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (d) =>
          d.name.toLowerCase().includes(q) ||
          (d.summary ?? "").toLowerCase().includes(q) ||
          (d.content ?? "").toLowerCase().includes(q),
      );
    }
    // Pinned first, then newest.
    return [...list].sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      return b.created_at.localeCompare(a.created_at);
    });
  }, [deliverables, pinnedOnly, kindFilter, missionFilter, search]);

  async function togglePin(d: Deliverable) {
    await supabase
      .from("internal_agent_deliverables")
      .update({ is_pinned: !d.is_pinned })
      .eq("id", d.id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_all_deliverables", agent.id] });
  }

  const hasFilters = !!(kindFilter || missionFilter || pinnedOnly || search.trim());

  // Resolve from the live list so pin/unpin updates reflect immediately.
  const selected = selectedId ? (deliverables ?? []).find((d) => d.id === selectedId) ?? null : null;

  if (selected) {
    return (
      <DeliverableDetail
        d={selected}
        missionTitle={missionTitle[selected.mission_id]}
        onBack={() => selectDeliverable(null)}
        onTogglePin={() => togglePin(selected)}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search deliverables…"
            className="h-8 pl-8"
          />
        </div>
        <Button
          size="sm"
          variant={pinnedOnly ? "default" : "outline"}
          onClick={() => setPinnedOnly((p) => !p)}
        >
          <Star weight={pinnedOnly ? "fill" : "regular"} className="mr-1 h-3.5 w-3.5" /> Pinned
        </Button>
        {kinds.length > 0 && (
          <select
            value={kindFilter ?? ""}
            onChange={(e) => setKindFilter(e.target.value || null)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">All types</option>
            {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
          </select>
        )}
        {(missions ?? []).length > 0 && (
          <select
            value={missionFilter ?? ""}
            onChange={(e) => setMissionFilter(e.target.value || null)}
            className="h-8 max-w-[180px] rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">All missions</option>
            {(missions ?? []).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        )}
        {hasFilters && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => { setSearch(""); setKindFilter(null); setMissionFilter(null); setPinnedOnly(false); }}
          >
            <X className="mr-1 h-3.5 w-3.5" /> Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex flex-wrap gap-x-10 gap-y-8 px-1 pt-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="aspect-[49/60] w-[196px] animate-pulse rounded-[6px_4px_4px_6px] bg-muted/40" />
          ))}
        </div>
      ) : !deliverables || deliverables.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No deliverables yet"
          description="When this agent completes a mission, its outputs land here — reports, data, code and links across every run."
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Filter} title="No matches" description="No deliverables match the current filters." />
      ) : (
        <div className="flex flex-wrap gap-x-10 gap-y-8 px-1 pt-2 pb-4">
          {filtered.map((d) => (
            <DeliverableCard key={d.id} d={d} onOpen={() => selectDeliverable(d.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// Golden bookmark ribbon for pinned (favourite) deliverables — hangs from the
// top edge of the book with a forked tail.
function PinnedRibbon() {
  return (
    <span
      className="absolute right-[15%] -top-0.5 block h-[34px] w-[10px]"
      style={{
        // Satin sheen: soft dark edges, bright centre — reads as fabric, not a slab.
        background: "linear-gradient(90deg,#9a6d1a 0%,#d8b04e 26%,#f6e09a 50%,#d3a942 74%,#9a6d1a 100%)",
        clipPath: "polygon(0 0,100% 0,100% 100%,50% 66%,0 100%)",
        boxShadow: "0 1px 2px rgba(0,0,0,.3)",
      }}
    />
  );
}

function DeliverableCard({ d, onOpen }: { d: Deliverable; onOpen: () => void }) {
  const cover = coverFor(d.id);
  const snippet = d.summary ?? d.content?.replace(/[#*`>_]/g, "").replace(/\s+/g, " ").trim().slice(0, 220) ?? "";
  const when = new Date(d.created_at).toLocaleString("fr-FR", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  return (
    <PerspectiveBook
      onClick={onOpen}
      className="text-white"
      spineColor={darken(cover.bg, 0.55)}
      banner={d.is_pinned ? <PinnedRibbon /> : undefined}
      coverStyle={{
        cursor: "pointer",
        color: "#ffffff",
        backgroundColor: cover.bg,
        backgroundImage: `linear-gradient(160deg, ${cover.sheen}, ${cover.bg} 58%)`,
      }}
    >
      <div className="flex h-full flex-col">
        <h3 className="line-clamp-2 text-[16px] font-semibold leading-snug tracking-tight">{d.name}</h3>
        {snippet && (
          <p className="mt-2 line-clamp-3 text-[11px] leading-relaxed opacity-75">{snippet}</p>
        )}
        <p className="mt-auto pt-2 text-[10px] uppercase tracking-wide opacity-60">{when}</p>
      </div>
    </PerspectiveBook>
  );
}

// Full-width inline reader — replaces the grid inside the tab (no modal).
function DeliverableDetail({
  d, missionTitle, onBack, onTogglePin,
}: {
  d: Deliverable;
  missionTitle?: string;
  onBack: () => void;
  onTogglePin: () => void;
}) {
  const Icon = KIND_ICON[d.kind] ?? FileText;
  return (
    <div className="space-y-3">
      {/* Header bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Deliverables
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold">{d.name}</span>
          <Badge variant="outline" className="shrink-0 text-[10px]">{KIND_LABEL[d.kind] ?? d.kind}</Badge>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={onTogglePin}>
            <Star weight={d.is_pinned ? "fill" : "regular"} className={cn("mr-1 h-3.5 w-3.5", d.is_pinned && "text-amber-500")} />
            {d.is_pinned ? "Pinned" : "Pin"}
          </Button>
          {d.file_url && (
            <a href={d.file_url} target="_blank" rel="noreferrer">
              <Button size="sm" variant="outline"><ExternalLink className="mr-1 h-3.5 w-3.5" /> Open</Button>
            </a>
          )}
          {d.content && (
            <Button size="sm" onClick={() => downloadDeliverable(d)}>
              <Download className="mr-1 h-3.5 w-3.5" /> Download
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        {missionTitle && <span><Target className="mr-1 inline h-3 w-3" />{missionTitle}</span>}
        <span>{missionTitle ? "· " : ""}{relativeDate(d.created_at)}</span>
      </div>

      {/* Content — rendered directly on the tab background, like a document. */}
      <div className="px-1 pb-8 pt-2">
        <DeliverableBody d={d} />
      </div>
    </div>
  );
}
