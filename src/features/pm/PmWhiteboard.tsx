import { lazy, Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Trash2, StickyNote } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface Board { id: string; title: string; color: string; created_at: string; updated_at: string }

const BOARD_COLORS = ["#2F2FE4", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0891b2"];

export function PmWhiteboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const boardId = searchParams.get("board");
  return boardId
    ? <BoardCanvas boardId={boardId} onBack={() => setSearchParams({})} />
    : <BoardGallery onOpen={(id) => setSearchParams({ board: id })} />;
}

// ───────────────────────────── Gallery ──────────────────────────────────────
function BoardGallery({ onOpen }: { onOpen: (id: string) => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const { data: boards, isLoading } = useQuery({
    queryKey: ["pm_whiteboards", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("project_whiteboards")
        .select("id, title, color, created_at, updated_at")
        .eq("project_id", projectId!)
        .order("updated_at", { ascending: false });
      return (data ?? []) as Board[];
    },
  });

  async function createBoard() {
    if (!workspaceId || !projectId || !user) return;
    setCreating(true);
    try {
      const color = BOARD_COLORS[Math.floor(Math.random() * BOARD_COLORS.length)];
      const { data } = await supabase
        .from("project_whiteboards")
        .insert({ workspace_id: workspaceId, project_id: projectId, title: "Untitled board", color, created_by: user.id })
        .select("id")
        .single();
      queryClient.invalidateQueries({ queryKey: ["pm_whiteboards", projectId] });
      if (data) onOpen(data.id);
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this whiteboard and all its notes?")) return;
    await supabase.from("project_whiteboards").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["pm_whiteboards", projectId] });
  }

  return (
    <div className="space-y-6 px-6 py-6">
      <PageHeader title="Whiteboards" description="Collaborative canvases — brainstorm with sticky notes, live with your team." />
      {isLoading ? (
        <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {/* Create card */}
          <button
            onClick={createBoard}
            disabled={creating}
            className="group flex aspect-[4/3] flex-col items-center justify-center gap-2.5 rounded-md border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/60 hover:bg-primary/5 hover:text-primary disabled:opacity-50"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-secondary transition-colors group-hover:bg-primary/15">
              {creating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plus className="h-5 w-5" />}
            </span>
            <span className="text-sm font-medium">New whiteboard</span>
          </button>

          {(boards ?? []).map((b) => (
            <div
              key={b.id}
              onClick={() => onOpen(b.id)}
              className="group relative flex aspect-[4/3] cursor-pointer flex-col overflow-hidden rounded-md border border-border bg-card transition-all hover:border-foreground/25 hover:shadow-lg"
            >
              {/* Top accent line */}
              <div className="h-1 w-full" style={{ backgroundColor: b.color }} />
              {/* Preview area — dotted canvas feel + mini notes */}
              <div className="relative flex-1 overflow-hidden bg-secondary/20">
                <div className="absolute inset-0 opacity-40 [background-image:radial-gradient(circle,hsl(var(--border))_1px,transparent_1px)] [background-size:16px_16px]" />
                <span className="absolute left-5 top-6 h-10 w-14 rotate-[-5deg] rounded-[3px] bg-[#FEF08A] shadow-md" />
                <span className="absolute left-16 top-10 h-10 w-14 rotate-[4deg] rounded-[3px] bg-[#BFDBFE] shadow-md" />
                <span className="absolute left-9 top-[58px] h-10 w-14 rotate-[-1deg] rounded-[3px] bg-[#BBF7D0] shadow-md" />
                <span
                  className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md"
                  style={{ backgroundColor: b.color + "22", color: b.color }}
                >
                  <StickyNote className="h-3.5 w-3.5" />
                </span>
              </div>
              {/* Footer */}
              <div className="flex items-center justify-between border-t border-border bg-card px-3.5 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{b.title}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">Updated {new Date(b.updated_at).toLocaleDateString()}</div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); remove(b.id); }}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-destructive group-hover:opacity-100"
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────── Canvas (Excalidraw, lazy-loaded) ───────────────────
const WhiteboardEditor = lazy(() => import("./WhiteboardEditor"));

function BoardCanvas({ boardId, onBack }: { boardId: string; onBack: () => void }) {
  return (
    <Suspense fallback={<div className="flex h-[calc(100vh-3.5rem)] items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}>
      <WhiteboardEditor boardId={boardId} onBack={onBack} />
    </Suspense>
  );
}