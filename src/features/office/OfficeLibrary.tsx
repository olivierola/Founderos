import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Search, Trash2, Sparkles, FilePlus2,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import {
  type OfficeDoc, type OfficeKind, KIND_META, emptyContent, loadOfficeDocs, relativeDate,
} from "./shared";
import { OfficeAiCreateDialog } from "./OfficeAiCreateDialog";

const TABS: Array<{ key: "all" | OfficeKind; label: string }> = [
  { key: "all", label: "All" },
  { key: "document", label: "Documents" },
  { key: "spreadsheet", label: "Spreadsheets" },
  { key: "presentation", label: "Presentations" },
];

export function OfficeLibraryPage({ initialKind }: { initialKind?: OfficeKind } = {}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<"all" | OfficeKind>(initialKind ?? "all");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  const { data: docs, isLoading } = useQuery({
    queryKey: ["office_docs", projectId],
    enabled: !!projectId,
    queryFn: () => loadOfficeDocs(projectId!),
  });

  const filtered = useMemo(() => {
    let list = docs ?? [];
    if (tab !== "all") list = list.filter((d) => d.kind === tab);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (d) => d.title.toLowerCase().includes(q) || (d.preview_text ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [docs, tab, search]);

  async function create(kind: OfficeKind) {
    if (!workspaceId || !projectId || !user) return;
    setCreating(true);
    try {
      const { data, error } = await supabase
        .from("office_documents")
        .insert({
          workspace_id: workspaceId,
          project_id: projectId,
          kind,
          title: `Untitled ${KIND_META[kind].label.toLowerCase()}`,
          content: emptyContent(kind),
          emoji: KIND_META[kind].emoji,
          created_by: user.id,
        })
        .select("id")
        .single();
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ["office_docs", projectId] });
      navigate(`/app/${workspaceSlug}/${projectSlug}/office/${kind}/${data!.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this file?")) return;
    await supabase.from("office_documents").update({ is_archived: true }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["office_docs", projectId] });
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Bureautique"
        description="Create documents, spreadsheets and presentations — with AI built in."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setAiOpen(true)}>
              <Sparkles className="h-4 w-4" /> Create with AI
            </Button>
            {(["document", "spreadsheet", "presentation"] as OfficeKind[]).map((k) => {
              const M = KIND_META[k];
              return (
                <Button key={k} size="sm" variant="outline" onClick={() => create(k)} disabled={creating}>
                  <M.icon className={cn("h-4 w-4", M.accent)} /> {M.label}
                </Button>
              );
            })}
          </div>
        }
      />

      {/* Tabs + search */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors",
                tab === t.key ? "bg-foreground/10 font-medium text-foreground" : "text-muted-foreground hover:bg-foreground/5",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search files…" className="h-9 pl-8" />
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="h-36 animate-pulse rounded-lg bg-muted/40" />)}
        </div>
      ) : (docs ?? []).length === 0 ? (
        <EmptyState
          icon={FilePlus2}
          title="No files yet"
          description="Create your first document, spreadsheet or presentation — or generate one with AI."
          action={
            <div className="flex gap-2">
              <Button onClick={() => create("document")}><Plus className="h-4 w-4" /> New document</Button>
              <Button variant="outline" onClick={() => setAiOpen(true)}><Sparkles className="h-4 w-4" /> Create with AI</Button>
            </div>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Search} title="No matches" description="No files match the current filters." />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((d) => (
            <FileCard
              key={d.id}
              doc={d}
              onOpen={() => navigate(`/app/${workspaceSlug}/${projectSlug}/office/${d.kind}/${d.id}`)}
              onDelete={() => remove(d.id)}
            />
          ))}
        </div>
      )}

      <OfficeAiCreateDialog
        open={aiOpen}
        onOpenChange={setAiOpen}
        workspaceId={workspaceId}
        projectId={projectId}
        onCreated={(id, kind) => {
          queryClient.invalidateQueries({ queryKey: ["office_docs", projectId] });
          navigate(`/app/${workspaceSlug}/${projectSlug}/office/${kind}/${id}`);
        }}
      />
    </div>
  );
}

function FileCard({ doc, onOpen, onDelete }: { doc: OfficeDoc; onOpen: () => void; onDelete: () => void }) {
  const M = KIND_META[doc.kind];
  return (
    <Card className="group flex flex-col transition-colors hover:border-foreground/30">
      <CardContent className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between">
          <button onClick={onOpen} className="flex min-w-0 items-center gap-2 text-left">
            <span className="text-lg">{doc.emoji ?? M.emoji}</span>
            <span className="truncate font-medium">{doc.title}</span>
          </button>
          <button
            onClick={onDelete}
            className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        <button onClick={onOpen} className="flex-1 text-left">
          <p className="line-clamp-3 text-xs text-muted-foreground">
            {doc.preview_text || <span className="italic">Empty {M.label.toLowerCase()}</span>}
          </p>
        </button>
        <div className="flex items-center justify-between pt-1">
          <Badge variant="outline" className="gap-1 text-[10px]">
            <M.icon className={cn("h-3 w-3", M.accent)} /> {M.label}
          </Badge>
          <span className="text-[10px] text-muted-foreground">{relativeDate(doc.updated_at)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
