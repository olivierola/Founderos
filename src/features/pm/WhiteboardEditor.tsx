import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Pencil, Check } from "lucide-react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";

interface Props { boardId: string; onBack: () => void }

interface Scene { elements: readonly unknown[]; appState?: Record<string, unknown> }

// Full Figma/FigJam-style whiteboard backed by Excalidraw: shapes, arrows &
// connectors, free-hand drawing, text, sticky-style frames, drag-and-drop,
// multi-select, layers — all built in. We persist the scene as JSON on the
// board row and sync collaborators via Supabase Realtime.
export function WhiteboardEditor({ boardId, onBack }: Props) {
  const { user } = useAuth();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [title, setTitle] = useState("");
  const [titleEditing, setTitleEditing] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ignore the realtime echo of our own writes / the initial load.
  const applyingRemote = useRef(false);
  const lastLocalHash = useRef("");

  const { data: board, isLoading } = useQuery({
    queryKey: ["pm_whiteboard", boardId],
    queryFn: async () => {
      const { data } = await supabase
        .from("project_whiteboards")
        .select("id, title, scene")
        .eq("id", boardId)
        .maybeSingle();
      return data as { id: string; title: string; scene: Scene } | null;
    },
  });

  useEffect(() => { if (board) setTitle(board.title); }, [board?.id]);

  // Push the loaded scene into Excalidraw once the API is ready.
  const initialScene = board?.scene ?? { elements: [] };
  const onApiReady = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api;
  }, []);

  // Debounced save of the current scene.
  const persistScene = useCallback((elements: readonly unknown[], appState: Record<string, unknown>) => {
    if (applyingRemote.current) return;
    const subset = {
      viewBackgroundColor: appState.viewBackgroundColor,
      gridSize: appState.gridSize,
    };
    const hash = JSON.stringify(elements);
    if (hash === lastLocalHash.current) return; // no element change (pure pan/zoom)
    lastLocalHash.current = hash;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await supabase
        .from("project_whiteboards")
        .update({ scene: { elements, appState: subset }, updated_at: new Date().toISOString() })
        .eq("id", boardId);
      setSavedAt(Date.now());
    }, 700);
  }, [boardId]);

  // Realtime: apply remote scene updates (from other collaborators).
  useEffect(() => {
    const ch = supabase
      .channel(`wb_scene:${boardId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "project_whiteboards", filter: `id=eq.${boardId}` },
        (payload) => {
          const next = (payload.new as { scene?: Scene }).scene;
          if (!next || !apiRef.current) return;
          const incoming = JSON.stringify(next.elements ?? []);
          if (incoming === lastLocalHash.current) return; // our own echo
          applyingRemote.current = true;
          lastLocalHash.current = incoming;
          apiRef.current.updateScene({ elements: next.elements as any });
          // release the guard after the change settles
          setTimeout(() => { applyingRemote.current = false; }, 50);
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [boardId]);

  async function saveTitle(t: string) {
    const title = t.trim() || "Untitled board";
    setTitle(title);
    setTitleEditing(false);
    await supabase.from("project_whiteboards").update({ title, updated_at: new Date().toISOString() }).eq("id", boardId);
  }

  if (isLoading) {
    return <div className="flex h-[calc(100vh-3.5rem)] items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full flex-col">
      {/* Header */}
      <div className="flex h-12 items-center gap-2 border-b border-border px-4">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Boards
        </button>
        <span className="mx-2 text-border">|</span>
        {titleEditing ? (
          <input
            autoFocus
            defaultValue={title}
            onBlur={(e) => saveTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            className="rounded border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        ) : (
          <button onClick={() => setTitleEditing(true)} className="group flex items-center gap-1.5 text-sm font-semibold">
            {title || "…"}
            <Pencil className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )}
        {savedAt && Date.now() - savedAt < 3000 && (
          <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground"><Check className="h-3 w-3" /> Saved</span>
        )}
      </div>

      {/* Excalidraw canvas (smooth background, full toolset) */}
      <div className="min-h-0 flex-1">
        <Excalidraw
          excalidrawAPI={onApiReady}
          initialData={{
            elements: (initialScene.elements ?? []) as any,
            appState: { viewBackgroundColor: "#ffffff", currentItemFontFamily: 1 },
            scrollToContent: true,
          }}
          onChange={(elements, appState) => persistScene(elements, appState as any)}
          UIOptions={{ canvasActions: { toggleTheme: true } }}
        />
      </div>
    </div>
  );
}

export default WhiteboardEditor;
