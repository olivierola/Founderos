import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, ArrowLeft, Trash2, StickyNote, Pencil, Type, ZoomIn, ZoomOut, Maximize2, Eraser } from "lucide-react";
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
    <div className="space-y-6 px-6 py-6">
      <PageHeader title="Whiteboards" description="Collaborative canvases — brainstorm with sticky notes, live with your team." />
      {isLoading ? (
        <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid grid-cols-2 gap-5 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {/* Create card */}
          <button
            onClick={createBoard}
            disabled={creating}
            className="group flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border text-muted-foreground transition-colors hover:border-primary/60 hover:bg-primary/5 hover:text-primary disabled:opacity-50"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-secondary transition-colors group-hover:bg-primary/15">
              {creating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plus className="h-5 w-5" />}
            </span>
            <span className="text-sm font-medium">New whiteboard</span>
          </button>

          {(boards ?? []).map((b) => (
            <div
              key={b.id}
              onClick={() => onOpen(b.id)}
              className="group relative flex aspect-[4/3] cursor-pointer flex-col overflow-hidden rounded-2xl border border-border bg-card transition-all hover:-translate-y-1 hover:shadow-xl"
            >
              {/* Preview area — gradient + dotted canvas feel + mini notes */}
              <div className="relative flex-1 overflow-hidden" style={{ background: `linear-gradient(135deg, ${b.color}26, ${b.color}05)` }}>
                <div className="absolute inset-0 opacity-40 [background-image:radial-gradient(circle,hsl(var(--border))_1px,transparent_1px)] [background-size:16px_16px]" />
                <span className="absolute left-4 top-5 h-9 w-12 rotate-[-4deg] rounded-sm bg-[#FEF08A] shadow-sm" />
                <span className="absolute left-14 top-9 h-9 w-12 rotate-[3deg] rounded-sm bg-[#BFDBFE] shadow-sm" />
                <span className="absolute left-8 top-14 h-9 w-12 rotate-[-1deg] rounded-sm bg-[#BBF7D0] shadow-sm" />
                <span
                  className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-lg"
                  style={{ backgroundColor: b.color + "22", color: b.color }}
                >
                  <StickyNote className="h-3.5 w-3.5" />
                </span>
              </div>
              {/* Footer */}
              <div className="flex items-center justify-between border-t border-border px-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{b.title}</div>
                  <div className="text-[10px] text-muted-foreground">Updated {new Date(b.updated_at).toLocaleDateString()}</div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); remove(b.id); }}
                  className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
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

  const [defaultColor, setDefaultColor] = useState(NOTE_COLORS[0]);
  const [zoom, setZoom] = useState(1);

  async function addNode(kind: "note" | "text") {
    if (!workspaceId || !user) return;
    await supabase.from("whiteboard_nodes").insert({
      board_id: boardId, workspace_id: workspaceId, kind,
      text: "", color: kind === "text" ? "transparent" : defaultColor,
      x: 80 + Math.random() * 280, y: 80 + Math.random() * 200,
      w: kind === "text" ? 220 : 180, h: kind === "text" ? 60 : 120,
      created_by: user.id,
    });
    queryClient.invalidateQueries({ queryKey: ["pm_whiteboard_nodes", boardId] });
  }

  async function clearBoard() {
    if (!confirm("Clear all notes on this board?")) return;
    await supabase.from("whiteboard_nodes").delete().eq("board_id", boardId);
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
      </div>

      <div className="relative min-h-0 flex-1">
        {/* Floating toolbar */}
        <div className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-card/95 p-1 shadow-lg backdrop-blur">
          <ToolBtn label="Add sticky note" onClick={() => addNode("note")}><StickyNote className="h-4 w-4" /></ToolBtn>
          <ToolBtn label="Add text" onClick={() => addNode("text")}><Type className="h-4 w-4" /></ToolBtn>
          <Divider />
          {/* Default note color */}
          <div className="flex items-center gap-1 px-1">
            {NOTE_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setDefaultColor(c)}
                className={cn("h-5 w-5 rounded-full border border-black/10 transition-transform hover:scale-110", defaultColor === c && "ring-2 ring-foreground ring-offset-1 ring-offset-card")}
                style={{ backgroundColor: c }}
                title="Default note color"
              />
            ))}
          </div>
          <Divider />
          <ToolBtn label="Zoom out" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}><ZoomOut className="h-4 w-4" /></ToolBtn>
          <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <ToolBtn label="Zoom in" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))}><ZoomIn className="h-4 w-4" /></ToolBtn>
          <ToolBtn label="Reset zoom" onClick={() => setZoom(1)}><Maximize2 className="h-4 w-4" /></ToolBtn>
          <Divider />
          <ToolBtn label="Clear board" onClick={clearBoard}><Eraser className="h-4 w-4 text-destructive" /></ToolBtn>
        </div>

        <Canvas boardId={boardId} nodes={nodes ?? []} zoom={zoom} />
      </div>
    </div>
  );
}

function ToolBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={label} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
      {children}
    </button>
  );
}
function Divider() { return <span className="mx-0.5 h-5 w-px bg-border" />; }

function Canvas({ boardId, nodes, zoom }: { boardId: string; nodes: Node[]; zoom: number }) {
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
    // Divide pointer delta by zoom so 1px of cursor = 1px of canvas at any scale.
    const onMove = (ev: MouseEvent) => setDrag({ id: n.id, x: origX + (ev.clientX - startX) / zoom, y: origY + (ev.clientY - startY) / zoom });
    const onUp = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const x = origX + (ev.clientX - startX) / zoom, y = origY + (ev.clientY - startY) / zoom;
      setDrag(null);
      persist(n.id, { x: Math.max(0, x), y: Math.max(0, y) });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle,hsl(var(--border))_1px,transparent_1px)] [background-size:24px_24px]">
      {nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Use the toolbar to add a sticky note or text. Changes sync live with your team.
        </div>
      )}
      {/* Scaled canvas layer */}
      <div className="relative h-[2000px] w-[3000px] origin-top-left" style={{ transform: `scale(${zoom})` }}>
      {nodes.map((n) => {
        const pos = drag && drag.id === n.id ? drag : n;
        const isText = n.kind === "text";
        return (
          <div
            key={n.id}
            onMouseDown={(e) => onDragStart(n, e)}
            className={cn("group absolute flex cursor-grab flex-col rounded-md active:cursor-grabbing", isText ? "" : "shadow-md")}
            style={{ left: pos.x, top: pos.y, width: n.w, height: n.h, backgroundColor: isText ? "transparent" : n.color }}
          >
            <textarea
              defaultValue={n.text}
              onBlur={(e) => { if (e.target.value !== n.text) persist(n.id, { text: e.target.value }); }}
              placeholder={isText ? "Text…" : "Type…"}
              className={cn(
                "h-full w-full resize-none bg-transparent p-2 focus:outline-none",
                isText ? "text-base font-medium text-foreground placeholder:text-muted-foreground/50" : "rounded-md text-sm text-zinc-900 placeholder:text-zinc-900/40",
              )}
            />
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={async () => { await supabase.from("whiteboard_nodes").delete().eq("id", n.id); queryClient.invalidateQueries({ queryKey: ["pm_whiteboard_nodes", boardId] }); }}
              title="Delete note"
              className="absolute -right-2 -top-2 hidden h-5 w-5 items-center justify-center rounded-full bg-destructive text-white group-hover:flex"
            >
              <Trash2 className="h-3 w-3" />
            </button>
            {/* Color swatches (sticky notes only) */}
            {!isText && (
              <div className="absolute -bottom-7 left-0 hidden gap-1 group-hover:flex" onMouseDown={(e) => e.stopPropagation()}>
                {NOTE_COLORS.map((c) => (
                  <button key={c} onClick={() => persist(n.id, { color: c })} className={cn("h-4 w-4 rounded-full border border-black/10", n.color === c && "ring-2 ring-foreground")} style={{ backgroundColor: c }} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}
