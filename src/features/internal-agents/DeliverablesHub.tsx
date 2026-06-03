import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search, Star, Download, ExternalLink, FileText, FileJson, FileCode,
  Link2, Paperclip, Package, Filter, X, Target,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  type InternalAgent, type Deliverable, type Mission,
  downloadDeliverable, relativeDate,
} from "./shared";

const KIND_ICON: Record<string, any> = {
  markdown: FileText,
  json: FileJson,
  code: FileCode,
  url: Link2,
  file: Paperclip,
};

export function DeliverablesHub({ agent }: { agent: InternalAgent }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [missionFilter, setMissionFilter] = useState<string | null>(null);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [preview, setPreview] = useState<Deliverable | null>(null);

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
          <Star className={cn("mr-1 h-3.5 w-3.5", pinnedOnly && "fill-current")} /> Pinned
        </Button>
        {kinds.length > 0 && (
          <select
            value={kindFilter ?? ""}
            onChange={(e) => setKindFilter(e.target.value || null)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">All types</option>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
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
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="h-32 animate-pulse rounded-lg bg-muted/40" />)}
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
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((d) => (
            <DeliverableCard
              key={d.id}
              d={d}
              missionTitle={missionTitle[d.mission_id]}
              onOpen={() => setPreview(d)}
              onTogglePin={() => togglePin(d)}
            />
          ))}
        </div>
      )}

      <DeliverablePreviewDialog
        d={preview}
        missionTitle={preview ? missionTitle[preview.mission_id] : undefined}
        onOpenChange={(o) => !o && setPreview(null)}
        onTogglePin={preview ? () => togglePin(preview) : undefined}
      />
    </div>
  );
}

function DeliverableCard({
  d, missionTitle, onOpen, onTogglePin,
}: {
  d: Deliverable;
  missionTitle?: string;
  onOpen: () => void;
  onTogglePin: () => void;
}) {
  const Icon = KIND_ICON[d.kind] ?? FileText;
  const snippet = d.summary ?? d.content?.replace(/[#*`>_]/g, "").slice(0, 160) ?? "";
  return (
    <Card className="group flex flex-col transition-colors hover:border-foreground/30">
      <CardContent className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <button onClick={onOpen} className="flex min-w-0 items-center gap-2 text-left">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{d.name}</span>
          </button>
          <button
            onClick={onTogglePin}
            className={cn(
              "shrink-0 rounded p-0.5 transition-colors",
              d.is_pinned ? "text-amber-500" : "text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-amber-500",
            )}
            title={d.is_pinned ? "Unpin" : "Pin"}
          >
            <Star className={cn("h-4 w-4", d.is_pinned && "fill-current")} />
          </button>
        </div>

        {snippet && (
          <button onClick={onOpen} className="flex-1 text-left">
            <p className="line-clamp-3 text-xs text-muted-foreground">{snippet}</p>
          </button>
        )}

        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Badge variant="outline" className="text-[10px]">{d.kind}</Badge>
            <span>{relativeDate(d.created_at)}</span>
          </div>
          <div className="flex items-center gap-0.5">
            {d.file_url ? (
              <a href={d.file_url} target="_blank" rel="noreferrer">
                <Button size="sm" variant="ghost"><ExternalLink className="h-3.5 w-3.5" /></Button>
              </a>
            ) : d.content ? (
              <Button size="sm" variant="ghost" onClick={() => downloadDeliverable(d)}>
                <Download className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
        {missionTitle && (
          <div className="truncate text-[10px] text-muted-foreground">
            <Target className="mr-1 inline h-2.5 w-2.5" />{missionTitle}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DeliverablePreviewDialog({
  d, missionTitle, onOpenChange, onTogglePin,
}: {
  d: Deliverable | null;
  missionTitle?: string;
  onOpenChange: (o: boolean) => void;
  onTogglePin?: () => void;
}) {
  if (!d) return null;
  const Icon = KIND_ICON[d.kind] ?? FileText;
  return (
    <Dialog open={!!d} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="truncate">{d.name}</span>
            <Badge variant="outline" className="text-[10px]">{d.kind}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {missionTitle && <span><Target className="mr-1 inline h-3 w-3" />{missionTitle}</span>}
          <span>· {relativeDate(d.created_at)}</span>
        </div>

        <div className="max-h-[60vh] overflow-y-auto rounded-md border border-border bg-muted/20 p-4">
          {d.kind === "markdown" ? (
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{d.content ?? "_Empty_"}</ReactMarkdown>
            </div>
          ) : d.kind === "url" ? (
            <a href={d.content ?? d.file_url ?? "#"} target="_blank" rel="noreferrer" className="break-all text-sm text-primary underline">
              {d.content ?? d.file_url}
            </a>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-xs">{d.content ?? "(no inline content)"}</pre>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border pt-3">
          {onTogglePin && (
            <Button size="sm" variant="outline" onClick={onTogglePin}>
              <Star className={cn("mr-1 h-3.5 w-3.5", d.is_pinned && "fill-current text-amber-500")} />
              {d.is_pinned ? "Pinned" : "Pin"}
            </Button>
          )}
          <div className="ml-auto flex gap-2">
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
      </DialogContent>
    </Dialog>
  );
}
