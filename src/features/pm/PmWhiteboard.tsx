import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, ArrowLeft, Trash2, StickyNote, Pencil } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

interface Board { id: string; title: string; color: string; created_at: string; updated_at: string }
interface Node {
  id: string; board_id: string; kind: "note" | "text"; text: string; color: string;
  x: number; y: number; w: number; h: number;
}

const NOTE_COLORS = ["#FEF08A", "#BBF7D0", "#BFDBFE", "#FBCFE8", "#FED7AA", "#E9D5FF"];
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
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <PageHeader title="Whiteboards" description="Collaborative canvases — brainstorm with sticky notes, live with your team." />
      {isLoading ? (
        <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {/* Create card */}
          <button
            onClick={createBoard}
            disabled={creating}
            className="group flex h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-6 w-6 animate-spin" /> : <Plus className="h-6 w-6" />}
            <span className="text-sm font-medium">New whiteboard</span>
          </button>

          {(boards ?? []).map((b) => (
            <div
              key={b.id}
              onClick={() => onOpen(b.id)}
              className="group relative h-40 cursor-pointer overflow-hidden rounded-xl border border-border bg-card transition-all hover:-translate-y-0.5 hover:shadow-lg"
            >
              <div className="h-20" style={{ background: `linear-gradient(135deg, ${b.color}33, ${b.color}0d)` }}>
                <StickyNote className="absolute right-3 top-3 h-4 w-4" style={{ color: b.color }} />
              </div>
              <div className="p-3">
                <div className="truncate text-sm font-semibold">{b.title}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">Updated {new Date(b.updated_at).toLocaleDateString()}</div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); remove(b.id); }}
                className="absolute bottom-3 right-3 opacity-0 transition-opacity group-hover:opacity-100"
                title="Delete"
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Canvas ───────────────────────────────────────
function BoardCanvas({ boardId, onBack }: { boardId: string; onBack: () => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [titleEditing, setTitleEditing] = useState(false);

  const { data: board } = useQuery({
    queryKey: ["pm_whiteboard", boardId],
    queryFn: async () => {
      const { data } = await supabase.from("project_whiteboards").select("id, title, color, created_at, updated_at").eq("id", boardId).maybeSingle();
      return data as Board | null;
    },
  });

  const { data: nodes } = useQuery({
    queryKey: ["pm_whiteboard_nodes", boardId],
    queryFn: async () => {
      const { data } = await supabase
        .from("whiteboard_nodes")
        .select("id, board_id, kind, text, color, x, y, w, h")
        .eq("board_id", boardId);
      return (data ?? []) as Node[];
    },
  });

  // Realtime: any node change refreshes the board for everyone.
  useEffect(() => {
    const ch = supabase
      .channel(`wb_nodes:${boardId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "whiteboard_nodes", filter: `board_id=eq.${boardId}` },
        () => queryClient.invalidateQueries({ queryKey: ["pm_whiteboard_nodes", boardId] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [boardId, queryClient]);

  async function addNote() {
    if (!workspaceId || !user) return;
    const color = NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)];
    await supabase.from("whiteboard_nodes").insert({
      board_id: boardId, workspace_id: workspaceId, kind: "note",
      text: "", color,
      x: 80 + Math.random() * 280, y: 80 + Math.random() * 200, w: 180, h: 120,
      created_by: user.id,
    });
    queryClient.invalidateQueries({ queryKey: ["pm_whiteboard_nodes", boardId] });
  }

  async function saveTitle(title: string) {
    await supabase.from("project_whiteboards").update({ title, updated_at: new Date().toISOString() }).eq("id", boardId);
    queryClient.invalidateQueries({ queryKey: ["pm_whiteboard", boardId] });
    queryClient.invalidateQueries({ queryKey: ["pm_whiteboards", projectId] });
    setTitleEditing(false);
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full flex-col">
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Boards
        </button>
        <span className="mx-2 text-border">|</span>
        {titleEditing ? (
          <input
            autoFocus
            defaultValue={board?.title ?? ""}
            onBlur={(e) => saveTitle(e.target.value.trim() || "Untitled board")}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            className="rounded border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        ) : (
          <button onClick={() => setTitleEditing(true)} className="group flex items-center gap-1.5 text-sm font-semibold">
            {board?.title ?? "…"}
            <Pencil className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )}
        <button
          onClick={addNote}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> Sticky note
        </button>
      </div>

      <Canvas boardId={boardId} nodes={nodes ?? []} />
    </div>
  );
}

function Canvas({ boardId, nodes }: { boardId: string; nodes: Node[] }) {
  const queryClient = useQueryClient();

  // Optimistic local positions during a drag.
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);

  async function persist(id: string, patch: Partial<Node>) {
    await supabase.from("whiteboard_nodes").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["pm_whiteboard_nodes", boardId] });
  }

  function onDragStart(n: Node, e: React.MouseEvent) {
    if ((e.target as HTMLElement).tagName === "TEXTAREA") return; // don't drag while editing text
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const origX = n.x, origY = n.y;
    const onMove = (ev: MouseEvent) => setDrag({ id: n.id, x: origX + (ev.clientX - startX), y: origY + (ev.clientY - startY) });
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const x = origX + (ev.clientX - startX), y = origY + (ev.clientY - startY);
      setDrag(null);
      persist(n.id, { x: Math.max(0, x), y: Math.max(0, y) });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle,hsl(var(--border))_1px,transparent_1px)] [background-size:24px_24px]">
      {nodes.length === 0 && (
        <div className="pointer-events-none flex h-full items-center justify-center text-sm text-muted-foreground">
          Add a sticky note to start. Changes sync live with your team.
        </div>
      )}
      {nodes.map((n) => {
        const pos = drag && drag.id === n.id ? drag : n;
        return (
          <div
            key={n.id}
            onMouseDown={(e) => onDragStart(n, e)}
            className="group absolute flex cursor-grab flex-col rounded-md shadow-md active:cursor-grabbing"
            style={{ left: pos.x, top: pos.y, width: n.w, height: n.h, backgroundColor: n.color }}
          >
            <textarea
              defaultValue={n.text}
              onBlur={(e) => { if (e.target.value !== n.text) persist(n.id, { text: e.target.value }); }}
              placeholder="Type…"
              className="h-full w-full resize-none rounded-md bg-transparent p-2 text-sm text-zinc-900 placeholder:text-zinc-900/40 focus:outline-none"
            />
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={async () => { await supabase.from("whiteboard_nodes").delete().eq("id", n.id); queryClient.invalidateQueries({ queryKey: ["pm_whiteboard_nodes", boardId] }); }}
              title="Delete note"
              className="absolute -right-2 -top-2 hidden h-5 w-5 items-center justify-center rounded-full bg-destructive text-white group-hover:flex"
            >
              <Trash2 className="h-3 w-3" />
            </button>
            {/* Color swatches */}
            <div className="absolute -bottom-7 left-0 hidden gap-1 group-hover:flex" onMouseDown={(e) => e.stopPropagation()}>
              {NOTE_COLORS.map((c) => (
                <button key={c} onClick={() => persist(n.id, { color: c })} className={cn("h-4 w-4 rounded-full border border-black/10", n.color === c && "ring-2 ring-foreground")} style={{ backgroundColor: c }} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
