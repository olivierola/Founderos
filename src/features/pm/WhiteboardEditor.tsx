import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Pencil, Check, LibraryBig, X, Download } from "lucide-react";
import { Excalidraw, loadLibraryFromBlob } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { cn } from "@/lib/utils";
import { EXCALIDRAW_LIBRARY_GROUPS, libraryUrl, type LibDef } from "./excalidrawLibraries";

const DARK_BG = "#0c0c0e";
const LIGHT_BG = "#fafafa";

interface Props { boardId: string; onBack: () => void }

interface Scene { elements: readonly unknown[]; appState?: Record<string, unknown> }

// Full Figma/FigJam-style whiteboard backed by Excalidraw: shapes, arrows &
// connectors, free-hand drawing, text, sticky-style frames, drag-and-drop,
// multi-select, layers — all built in. We persist the scene as JSON on the
// board row and sync collaborators via Supabase Realtime.
export function WhiteboardEditor({ boardId, onBack }: Props) {
  const { user } = useAuth();
  const { theme } = useTheme();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [apiReady, setApiReady] = useState(0);
  const [title, setTitle] = useState("");
  const [titleEditing, setTitleEditing] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [libsOpen, setLibsOpen] = useState(false);
  const [loadingLib, setLoadingLib] = useState<string | null>(null);
  const [loadedLibs, setLoadedLibs] = useState<Set<string>>(new Set());
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
    setApiReady((n) => n + 1);
  }, []);

  // Debounced save of the current scene.
  const persistScene = useCallback((elements: readonly unknown[], appState: Record<string, unknown>) => {
    if (applyingRemote.current) return;
    // Don't persist viewBackgroundColor — it's theme-driven, not part of content.
    const subset = { gridSize: appState.gridSize };
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

  // The canvas background always follows the app theme (the whiteboard has no
  // custom bg of its own). Re-apply whenever the theme changes or the API mounts.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.updateScene({ appState: { viewBackgroundColor: theme === "dark" ? DARK_BG : LIGHT_BG } });
  }, [theme, apiReady]);

  // Fetch a .excalidrawlib and merge its shapes into the board's library panel.
  // Guard against re-adding an already-loaded (or in-flight) library, which
  // would duplicate every shape via merge:true.
  async function addLibrary(lib: LibDef) {
    const api = apiRef.current;
    if (!api) return;
    const key = lib.source;
    if (loadedLibs.has(key) || loadingLib === key) {
      api.updateLibrary({ libraryItems: [], merge: true, openLibraryMenu: true }); // just open the panel
      return;
    }
    setLoadingLib(key);
    try {
      const res = await fetch(libraryUrl(lib));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const items = await loadLibraryFromBlob(blob);
      await api.updateLibrary({ libraryItems: items, merge: true, openLibraryMenu: true });
      setLoadedLibs((s) => new Set(s).add(key));
    } catch (e) {
      alert(`Couldn't load "${lib.name}". ${e instanceof Error ? e.message : ""}`);
    } finally {
      setLoadingLib(null);
    }
  }

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
      <div className="flex h-12 items-center gap-2 border-b border-border bg-card/60 px-4 backdrop-blur">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Boards
        </button>
        <span className="mx-1 h-4 w-px bg-border" />
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
        <button
          onClick={() => setLibsOpen((o) => !o)}
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-secondary",
            libsOpen ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground",
          )}
        >
          <LibraryBig className="h-4 w-4" /> Libraries
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
      {/* Excalidraw canvas (smooth background, full toolset) */}
      <div className="fos-wb min-h-0 flex-1">
        <Excalidraw
          theme={theme}
          excalidrawAPI={onApiReady}
          initialData={{
            elements: (initialScene.elements ?? []) as any,
            appState: {
              viewBackgroundColor: theme === "dark" ? DARK_BG : LIGHT_BG,
              currentItemFontFamily: 1,
            },
            scrollToContent: true,
          }}
          onChange={(elements, appState) => persistScene(elements, appState as any)}
          UIOptions={{ canvasActions: { toggleTheme: true } }}
        />
      </div>

      {/* Business library catalog — load curated shape sets on demand */}
      {libsOpen && (
        <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-card">
          <div className="flex h-12 items-center justify-between border-b border-border px-3">
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold"><LibraryBig className="h-4 w-4" /> Libraries</span>
            <button onClick={() => setLibsOpen(false)} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"><X className="h-4 w-4" /></button>
          </div>
          <p className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
            Add curated shape sets — they appear in Excalidraw's library panel, ready to drag onto the board.
          </p>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
            {EXCALIDRAW_LIBRARY_GROUPS.map((g) => (
              <div key={g.label}>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{g.label}</div>
                <div className="space-y-1.5">
                  {g.libs.map((lib) => {
                    const key = lib.source;
                    const loaded = loadedLibs.has(key);
                    const loading = loadingLib === key;
                    return (
                      <button
                        key={key}
                        onClick={() => addLibrary(lib)}
                        disabled={loading}
                        className="flex w-full items-start gap-2 rounded-md border border-border p-2 text-left transition-colors hover:border-foreground/30 hover:bg-secondary/50 disabled:opacity-60"
                      >
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-secondary text-muted-foreground">
                          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : loaded ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Download className="h-3.5 w-3.5" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 truncate text-xs font-medium">
                            {lib.name}
                            {loaded && <span className="rounded bg-emerald-500/15 px-1 text-[9px] font-medium text-emerald-500">Added</span>}
                          </span>
                          {lib.items && <span className="block truncate text-[10px] text-muted-foreground">{lib.items}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}
      </div>
    </div>
  );
}

export default WhiteboardEditor;
