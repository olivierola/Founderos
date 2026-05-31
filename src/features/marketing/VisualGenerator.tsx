import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Plus,
  Trash2,
  Type,
  Palette,
  Search,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Bold,
  Italic,
  Layers,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Copy as CopyIcon,
  ChevronUp,
  ChevronDown,
  Square,
  Circle as CircleIcon,
  Star,
  Minus,
  Shapes,
  Check,
  Loader2,
  Send,
  FileJson,
  Upload,
} from "lucide-react";
import { FontPicker } from "./FontPicker";
import { familyCss } from "./fonts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ToastProvider";
import {
  CANVAS_FORMATS,
  TEMPLATE_CATEGORIES,
  VISUAL_TEMPLATES,
  type CanvasFormat,
  type TemplateColors,
  type TemplateDef,
} from "./visualTemplates";

interface BaseLayer {
  id: string;
  /** 0..1 of canvas width / height */
  x: number;
  y: number;
  w: number;
  opacity: number;
  rotation: number;
  hidden?: boolean;
  locked?: boolean;
}

interface TextLayer extends BaseLayer {
  kind: "text";
  text: string;
  /** font-size in canvas units */
  fontSize: number;
  color: string;
  font: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
}

export type ShapeKind = "rect" | "circle" | "line" | "star" | "badge" | "arrow";

interface ShapeLayer extends BaseLayer {
  kind: "shape";
  shape: ShapeKind;
  /** Height in 0..1 (rect/ellipse/line) */
  h: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius?: number; // for rect rounded corners
}

type Layer = TextLayer | ShapeLayer;

interface VisualGeneratorProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Default content seeded from the post (title / body / handle). */
  initialContent?: { title?: string; body?: string; handle?: string };
  /** Persistence key — when set, the editor autosaves into localStorage. */
  persistKey?: string;
  /** Optional publish handler (e.g. uploads PNG + triggers the social post). */
  onPublish?: (pngBlob: Blob) => Promise<void> | void;
}

export function VisualGenerator({ open, onOpenChange, initialContent, persistKey, onPublish }: VisualGeneratorProps) {
  const [format, setFormat] = useState<CanvasFormat>(CANVAS_FORMATS[0]);
  const [customW, setCustomW] = useState(1200);
  const [customH, setCustomH] = useState(800);
  const [template, setTemplate] = useState<TemplateDef>(VISUAL_TEMPLATES[0]);
  const [colors, setColors] = useState<TemplateColors>(VISUAL_TEMPLATES[0].defaultColors);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [layers, setLayers] = useState<Layer[]>([]);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const toast = useToast();
  const stageRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const canvasW = format.id === "custom" ? customW : format.width;
  const canvasH = format.id === "custom" ? customH : format.height;

  // Tracks whether we already attempted to load the saved snapshot for the
  // current (open, persistKey) pair. Until this flips true the save effect
  // stays silent, so it cannot overwrite the snapshot with the empty initial
  // state before the load effect has had a chance to populate it.
  const [hydrated, setHydrated] = useState(false);
  const [restoredSnapshot, setRestoredSnapshot] = useState(false);

  // Load persisted state on open (per persistKey).
  useEffect(() => {
    if (!open) {
      setHydrated(false);
      setRestoredSnapshot(false);
      return;
    }
    if (!persistKey) {
      setHydrated(true);
      return;
    }
    try {
      const raw = localStorage.getItem("founderos.visual." + persistKey);
      if (raw) {
        const snap = JSON.parse(raw) as {
          formatId?: string;
          templateId?: string;
          colors?: TemplateColors;
          layers?: Layer[];
          customW?: number;
          customH?: number;
        };
        if (snap.formatId) {
          const f = CANVAS_FORMATS.find((x) => x.id === snap.formatId);
          if (f) setFormat(f);
        }
        if (snap.templateId) {
          const t = VISUAL_TEMPLATES.find((x) => x.id === snap.templateId);
          if (t) setTemplate(t);
        }
        if (snap.colors) setColors(snap.colors);
        if (snap.layers && snap.layers.length > 0) {
          setLayers(snap.layers);
          setRestoredSnapshot(true);
        }
        if (snap.customW) setCustomW(snap.customW);
        if (snap.customH) setCustomH(snap.customH);
      }
    } catch {
      /* ignore corrupted state */
    }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, persistKey]);

  // Autosave whenever editable state changes — but only after the load
  // effect ran, to avoid wiping the snapshot with the initial empty state.
  useEffect(() => {
    if (!open || !persistKey || !hydrated) return;
    const snap = {
      formatId: format.id,
      templateId: template.id,
      colors,
      layers,
      customW,
      customH,
    };
    try {
      localStorage.setItem("founderos.visual." + persistKey, JSON.stringify(snap));
    } catch {
      /* ignore quota */
    }
  }, [open, persistKey, hydrated, format, template, colors, layers, customW, customH]);

  // Seed text layers from the initial post content the first time the dialog
  // opens. Re-seed when the dialog is reopened with new content.
  useEffect(() => {
    if (!open) return;
    if (!hydrated) return;       // wait for the load effect
    if (restoredSnapshot) return; // user already has saved layers
    if (layers.length > 0) return;

    // Extract a sensible title (first sentence or first 50 chars), then the
    // body as everything after.
    const raw = (initialContent?.title || initialContent?.body || "").trim();
    let titleText = "";
    let bodyText = "";
    if (raw) {
      const firstLineBreak = raw.indexOf("\n");
      const firstSentence = raw.match(/^[^.!?]{5,80}[.!?]/);
      if (firstLineBreak > 0 && firstLineBreak <= 80) {
        titleText = raw.slice(0, firstLineBreak).trim();
        bodyText = raw.slice(firstLineBreak + 1).trim();
      } else if (firstSentence) {
        titleText = firstSentence[0].trim();
        bodyText = raw.slice(firstSentence[0].length).trim();
      } else {
        titleText = raw.slice(0, 50).trim();
        bodyText = raw.length > 50 ? raw.slice(50, 250).trim() : "";
      }
    }

    const seeds: Layer[] = [];
    const baseTextProps = { kind: "text" as const, opacity: 1, rotation: 0 };
    if (titleText) {
      const titleLen = titleText.length;
      const titleSize = titleLen < 30 ? canvasW / 12 : titleLen < 60 ? canvasW / 16 : canvasW / 22;
      seeds.push({
        ...baseTextProps,
        id: "l-title",
        text: titleText,
        x: 0.06, y: 0.22, w: 0.88,
        fontSize: Math.round(titleSize),
        color: "#ffffff",
        font: "Inter",
        bold: true, italic: false, align: "left",
      });
    }
    if (bodyText) {
      seeds.push({
        ...baseTextProps,
        id: "l-body",
        text: bodyText.slice(0, 180),
        x: 0.06, y: 0.52, w: 0.82,
        fontSize: Math.round(canvasW / 38),
        color: "#e5e7eb",
        font: "Inter",
        bold: false, italic: false, align: "left",
      });
    }
    if (initialContent?.handle) {
      seeds.push({
        ...baseTextProps,
        id: "l-handle",
        text: initialContent.handle,
        x: 0.06, y: 0.9, w: 0.5,
        fontSize: Math.round(canvasW / 56),
        color: "#cbd5e1",
        font: "Inter",
        bold: false, italic: false, align: "left",
      });
    }
    if (seeds.length === 0) {
      seeds.push({
        ...baseTextProps,
        id: "l-title",
        text: "Your headline goes here.",
        x: 0.06, y: 0.4, w: 0.88,
        fontSize: Math.round(canvasW / 14),
        color: "#ffffff",
        font: "Inter",
        bold: true, italic: false, align: "left",
      });
    }
    setLayers(seeds);
    setSelectedLayer(seeds[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialContent?.title, initialContent?.body]);

  // Clear layers ONLY when there's no persistence and the dialog is closed.
  // With persistKey we keep state so the user resumes where they left off.
  useEffect(() => {
    if (!open && !persistKey) {
      setLayers([]);
      setSelectedLayer(null);
    }
  }, [open, persistKey]);

  // Sync colors with template selection.
  function pickTemplate(t: TemplateDef) {
    setTemplate(t);
    setColors(t.defaultColors);
  }

  const filteredTemplates = useMemo(() => {
    return VISUAL_TEMPLATES.filter((t) => {
      if (categoryFilter !== "all" && t.category !== categoryFilter) return false;
      if (search.trim() && !t.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [categoryFilter, search]);

  const selectedLayerObj = layers.find((l) => l.id === selectedLayer) ?? null;

  function updateLayer(id: string, patch: Partial<Layer>) {
    setLayers((arr) => arr.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)));
  }

  function addTextLayer() {
    const id = "l-" + Math.random().toString(36).slice(2, 7);
    const newLayer: TextLayer = {
      kind: "text",
      id,
      text: "New text",
      x: 0.1, y: 0.5, w: 0.6,
      fontSize: Math.round(canvasW / 20),
      color: "#ffffff",
      font: "Inter",
      bold: false, italic: false, align: "left",
      opacity: 1, rotation: 0,
    };
    setLayers((arr) => [...arr, newLayer]);
    setSelectedLayer(id);
  }

  function addShape(shape: ShapeKind) {
    const id = "s-" + Math.random().toString(36).slice(2, 7);
    const newLayer: ShapeLayer = {
      kind: "shape",
      shape,
      id,
      x: 0.3, y: 0.4, w: 0.4, h: 0.2,
      fill: "#7C3AED",
      stroke: "#FFFFFF",
      strokeWidth: 0,
      radius: shape === "rect" ? 12 : 0,
      opacity: 1, rotation: 0,
    };
    setLayers((arr) => [...arr, newLayer]);
    setSelectedLayer(id);
  }

  function removeLayer(id: string) {
    setLayers((arr) => arr.filter((l) => l.id !== id));
    if (selectedLayer === id) setSelectedLayer(null);
  }

  function moveLayer(id: string, dir: "up" | "down") {
    setLayers((arr) => {
      const i = arr.findIndex((l) => l.id === id);
      if (i < 0) return arr;
      const next = [...arr];
      const j = dir === "up" ? Math.min(arr.length - 1, i + 1) : Math.max(0, i - 1);
      if (i === j) return arr;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function duplicateLayer(id: string) {
    setLayers((arr) => {
      const l = arr.find((x) => x.id === id);
      if (!l) return arr;
      const copy: Layer = { ...l, id: l.kind[0] + "-" + Math.random().toString(36).slice(2, 7), x: Math.min(l.x + 0.04, 0.9), y: Math.min(l.y + 0.04, 0.9) };
      return [...arr, copy];
    });
  }

  /* Build the SVG markup that combines the template background and the text
   * layers. Used both for live preview (innerHTML) and for export. */
  function buildSvg(): string {
    const bg = template.render(colors);
    const safeText = (t: string) =>
      t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const layerSvgs = layers
      .filter((l) => !l.hidden)
      .map((l) => {
        if (l.kind === "text") return renderTextSvg(l, canvasW, canvasH, safeText);
        return renderShapeSvg(l, canvasW, canvasH);
      })
      .join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvasW} ${canvasH}" width="${canvasW}" height="${canvasH}">${bg}${layerSvgs}</svg>`;
  }

  async function downloadPng() {
    setDownloading(true);
    try {
      const svg = buildSvg();
      const blob = new Blob([svg], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Could not render preview to image"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = canvasW;
      canvas.height = canvasH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No canvas context");
      ctx.drawImage(img, 0, 0, canvasW, canvasH);
      const pngUrl = canvas.toDataURL("image/png");
      URL.revokeObjectURL(url);
      const a = document.createElement("a");
      a.href = pngUrl;
      a.download = `founderos-visual-${Date.now()}.png`;
      a.click();
      toast.success("Visual downloaded");
    } catch (e) {
      toast.error("Export failed", e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

  function downloadSvg() {
    const svg = buildSvg();
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `founderos-visual-${Date.now()}.svg`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("SVG downloaded");
  }

  /* Export the full editor state as a portable JSON file. The user can
   * download it, share it, or re-import it later — even on another device. */
  function exportJson() {
    const snap = {
      $type: "founderos-visual/v1",
      formatId: format.id,
      customW,
      customH,
      templateId: template.id,
      colors,
      layers,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `founderos-visual-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Project saved", `${layers.length} layer${layers.length === 1 ? "" : "s"} exported`);
  }

  async function importJson(file: File) {
    try {
      const text = await file.text();
      const snap = JSON.parse(text) as {
        $type?: string;
        formatId?: string;
        templateId?: string;
        colors?: TemplateColors;
        layers?: Layer[];
        customW?: number;
        customH?: number;
      };
      if (snap.$type && snap.$type !== "founderos-visual/v1") {
        throw new Error("Unsupported file version");
      }
      if (snap.formatId) {
        const f = CANVAS_FORMATS.find((x) => x.id === snap.formatId);
        if (f) setFormat(f);
      }
      if (snap.templateId) {
        const t = VISUAL_TEMPLATES.find((x) => x.id === snap.templateId);
        if (t) setTemplate(t);
      }
      if (snap.colors) setColors(snap.colors);
      if (Array.isArray(snap.layers)) setLayers(snap.layers);
      if (snap.customW) setCustomW(snap.customW);
      if (snap.customH) setCustomH(snap.customH);
      setRestoredSnapshot(true);
      toast.success("Project loaded", `${(snap.layers ?? []).length} layer(s) restored`);
    } catch (e) {
      toast.error("Could not load file", e instanceof Error ? e.message : String(e));
    }
  }

  // Render the visual to a PNG blob and hand it off to the host (publish flow).
  const [publishing, setPublishing] = useState(false);
  async function publish() {
    if (!onPublish) return;
    setPublishing(true);
    try {
      const svg = buildSvg();
      const svgBlob = new Blob([svg], { type: "image/svg+xml" });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Could not render preview"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = canvasW;
      canvas.height = canvasH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No canvas context");
      ctx.drawImage(img, 0, 0, canvasW, canvasH);
      URL.revokeObjectURL(url);
      const pngBlob: Blob = await new Promise((res, rej) => {
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("Empty blob"))), "image/png");
      });
      await onPublish(pngBlob);
      toast.success("Visual published");
      // Clear the autosave once published so the next opening starts fresh.
      if (persistKey) {
        try {
          localStorage.removeItem("founderos.visual." + persistKey);
        } catch {}
      }
    } catch (e) {
      toast.error("Publish failed", e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  }

  /* Snap guides shown while dragging. */
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});

  /* Measured stage width — used to scale fontSize for HTML overlays. */
  const [stageWidth, setStageWidth] = useState(0);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setStageWidth(el.getBoundingClientRect().width);
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, [open]);

  /* Drag / resize handlers for text layers with snap to center and edges. */
  function handleDrag(layer: Layer, e: React.MouseEvent) {
    e.stopPropagation();
    setSelectedLayer(layer.id);
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const baseX = layer.x;
    const baseY = layer.y;
    const SNAP_THRESHOLD = 0.02; // 2% of canvas

    function snap(value: number, anchors: number[]): { v: number; hit: number | null } {
      for (const a of anchors) {
        if (Math.abs(value - a) < SNAP_THRESHOLD) return { v: a, hit: a };
      }
      return { v: value, hit: null };
    }

    function onMove(ev: MouseEvent) {
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      let newX = Math.max(0, Math.min(1 - layer.w, baseX + dx));
      let newY = Math.max(0, Math.min(0.98, baseY + dy));

      // Horizontal snap: left edge, center, right edge
      const centerX = newX + layer.w / 2;
      const sx = snap(centerX, [0.5]);
      if (sx.hit !== null) newX = sx.v - layer.w / 2;
      else {
        const sxLeft = snap(newX, [0.06, 0]);
        if (sxLeft.hit !== null) newX = sxLeft.v;
      }

      // Vertical snap: center, thirds
      const sy = snap(newY, [0.06, 0.22, 0.5, 0.78, 0.9]);
      if (sy.hit !== null) newY = sy.v;

      setGuides({
        x: Math.abs(newX + layer.w / 2 - 0.5) < SNAP_THRESHOLD ? 0.5 : undefined,
        y: [0.22, 0.5, 0.78].find((a) => Math.abs(newY - a) < SNAP_THRESHOLD),
      });

      updateLayer(layer.id, { x: newX, y: newY });
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setGuides({});
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92vh] max-h-[92vh] max-w-[1400px] flex-col overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>Visual generator</DialogTitle>
          <DialogDescription>
            Pick a template, recolor it, edit the text — export to PNG or SVG.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr_300px] overflow-hidden">
          {/* Left rail: templates */}
          <aside className="flex min-h-0 flex-col border-r border-border bg-card/40">
            <div className="space-y-2 border-b border-border p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search…"
                  className="h-8 pl-7 text-xs"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                <CatPill active={categoryFilter === "all"} onClick={() => setCategoryFilter("all")}>
                  All
                </CatPill>
                {TEMPLATE_CATEGORIES.map((c) => (
                  <CatPill key={c} active={categoryFilter === c} onClick={() => setCategoryFilter(c)}>
                    {c}
                  </CatPill>
                ))}
              </div>
            </div>
            <div className="grid flex-1 grid-cols-2 gap-2 overflow-y-auto p-3">
              {filteredTemplates.map((t) => {
                const html = t.render(t.defaultColors);
                return (
                  <button
                    key={t.id}
                    onClick={() => pickTemplate(t)}
                    className={cn(
                      "group relative overflow-hidden rounded-md border bg-card transition-all hover:scale-[1.02]",
                      template.id === t.id ? "border-[hsl(var(--primary-soft))] ring-2 ring-[hsl(var(--primary-soft)/0.4)]" : "border-border",
                    )}
                    style={{ aspectRatio: "1/1" }}
                  >
                    <svg
                      viewBox={`0 0 ${canvasW} ${canvasH}`}
                      className="absolute inset-0 h-full w-full"
                      preserveAspectRatio="xMidYMid slice"
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
                    <span className="absolute bottom-0 left-0 right-0 truncate bg-black/50 px-1.5 py-1 text-[9px] text-white">
                      {t.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Center: canvas */}
          <main className="flex min-h-0 flex-col overflow-hidden bg-secondary/30">
            <div className="flex flex-wrap items-center justify-between gap-y-2 gap-x-3 border-b border-border bg-card/40 px-4 py-3">
              <div className="flex items-center gap-2">
                <select
                  value={format.id}
                  onChange={(e) => {
                    const f = CANVAS_FORMATS.find((x) => x.id === e.target.value);
                    if (f) setFormat(f);
                  }}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                >
                  {CANVAS_FORMATS.map((f) => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
                </select>
                {format.id === "custom" && (
                  <>
                    <Input
                      type="number"
                      value={customW}
                      onChange={(e) => setCustomW(Number(e.target.value) || 1200)}
                      className="h-8 w-20 text-xs"
                    />
                    <span className="text-xs text-muted-foreground">×</span>
                    <Input
                      type="number"
                      value={customH}
                      onChange={(e) => setCustomH(Number(e.target.value) || 800)}
                      className="h-8 w-20 text-xs"
                    />
                  </>
                )}
                <Button size="sm" variant="outline" onClick={addTextLayer}>
                  <Plus className="h-3.5 w-3.5" /> Text
                </Button>
                <ShapesMenu onPick={addShape} />
                {persistKey && (
                  <span className="ml-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Check className="h-3 w-3 text-[hsl(var(--accent-2))]" /> Autosaved
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={downloadSvg}>
                  <Download className="h-3.5 w-3.5" /> SVG
                </Button>
                <Button size="sm" variant="outline" onClick={downloadPng} disabled={downloading}>
                  <Download className="h-3.5 w-3.5" /> {downloading ? "Exporting…" : "PNG"}
                </Button>
                <Button size="sm" variant="outline" onClick={exportJson} title="Save current state as JSON">
                  <FileJson className="h-3.5 w-3.5" /> Save
                </Button>
                <Button size="sm" variant="outline" onClick={() => importInputRef.current?.click()} title="Load a previously saved state">
                  <Upload className="h-3.5 w-3.5" /> Load
                </Button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) importJson(f);
                    e.target.value = "";
                  }}
                />
                {onPublish && (
                  <Button size="sm" onClick={publish} disabled={publishing}>
                    {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    {publishing ? "Publishing…" : "Publish"}
                  </Button>
                )}
              </div>
            </div>
            <div className="relative flex flex-1 items-center justify-center overflow-hidden p-6">
              <div
                ref={stageRef}
                onClick={() => setSelectedLayer(null)}
                className="relative overflow-hidden rounded-lg shadow-2xl"
                style={{
                  aspectRatio: `${canvasW} / ${canvasH}`,
                  // Pick the smaller of width-available and height-available so
                  // the stage never overflows in either axis.
                  width: "min(100%, calc((100vh - 220px) * " + canvasW / canvasH + "))",
                  maxHeight: "calc(100vh - 220px)",
                }}
              >
                    <svg
                      viewBox={`0 0 ${canvasW} ${canvasH}`}
                      className="absolute inset-0 h-full w-full"
                      preserveAspectRatio="xMidYMid slice"
                      dangerouslySetInnerHTML={{ __html: template.render(colors) }}
                    />

                    {/* Snap guides (visible only while dragging) */}
                    {guides.x !== undefined && (
                      <div
                        className="pointer-events-none absolute inset-y-0 w-px bg-[hsl(var(--primary-soft))]"
                        style={{ left: `${guides.x * 100}%` }}
                      />
                    )}
                    {guides.y !== undefined && (
                      <div
                        className="pointer-events-none absolute inset-x-0 h-px bg-[hsl(var(--primary-soft))]"
                        style={{ top: `${guides.y * 100}%` }}
                      />
                    )}

                    {/* Overlay layers (HTML for text, SVG for shapes). The export rebuilds them in SVG. */}
                    {layers.filter((l) => !l.hidden).map((l) => {
                      const isSelected = selectedLayer === l.id;
                      const scale = stageWidth > 0 ? stageWidth / canvasW : 1;
                      const commonStyle: React.CSSProperties = {
                        left: `${l.x * 100}%`,
                        top: `${l.y * 100}%`,
                        opacity: l.opacity,
                        transform: l.rotation ? `rotate(${l.rotation}deg)` : undefined,
                        transformOrigin: "top left",
                      };
                      const outlineCls = cn(
                        "absolute select-none",
                        l.locked ? "cursor-default" : "cursor-move",
                        isSelected && "outline outline-2 outline-[hsl(var(--primary-soft))] outline-offset-2",
                      );

                      if (l.kind === "text") {
                        return (
                          <div
                            key={l.id}
                            onMouseDown={(e) => !l.locked && handleDrag(l, e)}
                            className={outlineCls}
                            style={{
                              ...commonStyle,
                              width: `${l.w * 100}%`,
                              color: l.color,
                              fontFamily: familyCss(l.font),
                              fontSize: `${l.fontSize * scale}px`,
                              fontWeight: l.bold ? 700 : 400,
                              fontStyle: l.italic ? "italic" : "normal",
                              textAlign: l.align,
                              lineHeight: 1.15,
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                            }}
                          >
                            {l.text}
                          </div>
                        );
                      }
                      // shape
                      const shapeSvg = renderShapePreview(l);
                      return (
                        <div
                          key={l.id}
                          onMouseDown={(e) => !l.locked && handleDrag(l, e)}
                          className={outlineCls}
                          style={{
                            ...commonStyle,
                            width: `${l.w * 100}%`,
                            height: `${l.h * 100}%`,
                          }}
                          dangerouslySetInnerHTML={{ __html: shapeSvg }}
                        />
                      );
                    })}
              </div>
            </div>
          </main>

          {/* Right rail: inspector */}
          <aside className="flex min-h-0 flex-col overflow-y-auto border-l border-border bg-card/40 p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Palette className="mr-1 inline h-3 w-3" /> Colors
            </h3>
            <div className="mb-5 space-y-2">
              <ColorRow label="Color 1" value={colors.c1} onChange={(v) => setColors({ ...colors, c1: v })} />
              <ColorRow label="Color 2" value={colors.c2} onChange={(v) => setColors({ ...colors, c2: v })} />
              <ColorRow label="Color 3" value={colors.c3 ?? "#ffffff"} onChange={(v) => setColors({ ...colors, c3: v })} />
              <ColorRow label="Color 4" value={colors.c4 ?? "#000000"} onChange={(v) => setColors({ ...colors, c4: v })} />
            </div>

            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Layers className="mr-1 inline h-3 w-3" /> Layers
            </h3>
            <ul className="mb-4 space-y-1">
              {[...layers].reverse().map((l, idx) => {
                const realIdx = layers.length - 1 - idx;
                const label = l.kind === "text" ? l.text || "Empty" : `Shape · ${l.shape}`;
                return (
                  <li
                    key={l.id}
                    onClick={() => setSelectedLayer(l.id)}
                    className={cn(
                      "group flex cursor-pointer items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs",
                      selectedLayer === l.id ? "border-[hsl(var(--primary-soft))] bg-[hsl(var(--primary-soft)/0.1)]" : "border-border",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Type className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">{label}</span>
                    </span>
                    <span className="flex items-center gap-0.5 opacity-50 group-hover:opacity-100">
                      <button onClick={(e) => { e.stopPropagation(); moveLayer(l.id, "up"); }} title="Bring forward" disabled={realIdx === layers.length - 1}>
                        <ChevronUp className="h-3 w-3" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); moveLayer(l.id, "down"); }} title="Send back" disabled={realIdx === 0}>
                        <ChevronDown className="h-3 w-3" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); updateLayer(l.id, { hidden: !l.hidden } as Partial<Layer>); }} title="Visibility">
                        {l.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); updateLayer(l.id, { locked: !l.locked } as Partial<Layer>); }} title="Lock">
                        {l.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); duplicateLayer(l.id); }} title="Duplicate">
                        <CopyIcon className="h-3 w-3" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); removeLayer(l.id); }} title="Delete">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  </li>
                );
              })}
              {layers.length === 0 && (
                <p className="rounded-md border border-dashed border-border p-2 text-center text-[11px] text-muted-foreground">
                  No layers yet. Add text or a shape from the toolbar.
                </p>
              )}
            </ul>

            {selectedLayerObj && selectedLayerObj.kind === "text" && (
              <div className="space-y-3 border-t border-border pt-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Type className="mr-1 inline h-3 w-3" /> Selected text
                </h3>
                <textarea
                  value={selectedLayerObj.text}
                  onChange={(e) => updateLayer(selectedLayerObj.id, { text: e.target.value })}
                  rows={3}
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                />
                <div className="space-y-2 text-xs">
                  <label className="block space-y-1">
                    <span className="text-muted-foreground">Font family</span>
                    <FontPicker
                      value={selectedLayerObj.font}
                      onChange={(family) => updateLayer(selectedLayerObj.id, { font: family })}
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="text-muted-foreground">Size</span>
                      <Input
                        type="number"
                        value={selectedLayerObj.fontSize}
                        onChange={(e) => updateLayer(selectedLayerObj.id, { fontSize: Number(e.target.value) || 24 })}
                        className="h-7 text-xs"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-muted-foreground">Color</span>
                      <input
                        type="color"
                        value={selectedLayerObj.color}
                        onChange={(e) => updateLayer(selectedLayerObj.id, { color: e.target.value })}
                        className="h-7 w-full rounded border border-input"
                      />
                    </label>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <ToggleBtn active={selectedLayerObj.bold} onClick={() => updateLayer(selectedLayerObj.id, { bold: !selectedLayerObj.bold })}>
                    <Bold className="h-3 w-3" />
                  </ToggleBtn>
                  <ToggleBtn active={selectedLayerObj.italic} onClick={() => updateLayer(selectedLayerObj.id, { italic: !selectedLayerObj.italic })}>
                    <Italic className="h-3 w-3" />
                  </ToggleBtn>
                  <span className="mx-1 h-4 w-px bg-border" />
                  <ToggleBtn active={selectedLayerObj.align === "left"} onClick={() => updateLayer(selectedLayerObj.id, { align: "left" })}>
                    <AlignLeft className="h-3 w-3" />
                  </ToggleBtn>
                  <ToggleBtn active={selectedLayerObj.align === "center"} onClick={() => updateLayer(selectedLayerObj.id, { align: "center" })}>
                    <AlignCenter className="h-3 w-3" />
                  </ToggleBtn>
                  <ToggleBtn active={selectedLayerObj.align === "right"} onClick={() => updateLayer(selectedLayerObj.id, { align: "right" })}>
                    <AlignRight className="h-3 w-3" />
                  </ToggleBtn>
                </div>
                <CommonTransform layer={selectedLayerObj} updateLayer={updateLayer} />
              </div>
            )}

            {selectedLayerObj && selectedLayerObj.kind === "shape" && (
              <div className="space-y-3 border-t border-border pt-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Selected shape — {selectedLayerObj.shape}
                </h3>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <label className="space-y-1">
                    <span className="text-muted-foreground">Fill</span>
                    <input type="color" value={selectedLayerObj.fill} onChange={(e) => updateLayer(selectedLayerObj.id, { fill: e.target.value } as Partial<Layer>)} className="h-7 w-full rounded border border-input" />
                  </label>
                  <label className="space-y-1">
                    <span className="text-muted-foreground">Stroke</span>
                    <input type="color" value={selectedLayerObj.stroke} onChange={(e) => updateLayer(selectedLayerObj.id, { stroke: e.target.value } as Partial<Layer>)} className="h-7 w-full rounded border border-input" />
                  </label>
                  <label className="space-y-1 col-span-2">
                    <span className="text-muted-foreground">Stroke width: {selectedLayerObj.strokeWidth}</span>
                    <Input type="range" min={0} max={20} step={1} value={selectedLayerObj.strokeWidth} onChange={(e) => updateLayer(selectedLayerObj.id, { strokeWidth: Number(e.target.value) } as Partial<Layer>)} />
                  </label>
                  {selectedLayerObj.shape === "rect" && (
                    <label className="space-y-1 col-span-2">
                      <span className="text-muted-foreground">Corner radius: {selectedLayerObj.radius ?? 0}</span>
                      <Input type="range" min={0} max={100} step={2} value={selectedLayerObj.radius ?? 0} onChange={(e) => updateLayer(selectedLayerObj.id, { radius: Number(e.target.value) } as Partial<Layer>)} />
                    </label>
                  )}
                </div>
                <CommonTransform layer={selectedLayerObj} updateLayer={updateLayer} />
              </div>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ====== Shape rendering helpers ====== */

function shapeToSvgEls(l: ShapeLayer, w: number, h: number): string {
  const sw = l.strokeWidth;
  const stroke = sw > 0 ? `stroke="${l.stroke}" stroke-width="${sw}"` : "";
  switch (l.shape) {
    case "rect":
      return `<rect x="0" y="0" width="${w}" height="${h}" rx="${l.radius ?? 0}" fill="${l.fill}" ${stroke}/>`;
    case "circle": {
      const r = Math.min(w, h) / 2;
      return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${l.fill}" ${stroke}/>` +
        (sw > 0 ? "" : `<!-- r=${r} -->`);
    }
    case "line":
      return `<line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="${l.fill}" stroke-width="${Math.max(2, sw)}" stroke-linecap="round"/>`;
    case "arrow": {
      const head = Math.min(h * 0.6, w * 0.18);
      return `<line x1="0" y1="${h / 2}" x2="${w - head}" y2="${h / 2}" stroke="${l.fill}" stroke-width="${Math.max(3, sw)}" stroke-linecap="round"/>
              <polygon points="${w - head},${h / 2 - head / 2} ${w},${h / 2} ${w - head},${h / 2 + head / 2}" fill="${l.fill}"/>`;
    }
    case "star": {
      const cx = w / 2, cy = h / 2;
      const R = Math.min(w, h) / 2;
      const r = R * 0.45;
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const ang = (Math.PI / 5) * i - Math.PI / 2;
        const rad = i % 2 === 0 ? R : r;
        pts.push(`${cx + Math.cos(ang) * rad},${cy + Math.sin(ang) * rad}`);
      }
      return `<polygon points="${pts.join(" ")}" fill="${l.fill}" ${stroke}/>`;
    }
    case "badge":
      return `<rect x="0" y="0" width="${w}" height="${h}" rx="${h / 2}" fill="${l.fill}" ${stroke}/>`;
  }
}

function renderShapePreview(l: ShapeLayer): string {
  // Internal viewBox 100x100, scaled to layer w/h by the parent div.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:100%;display:block">${shapeToSvgEls(l, 100, 100)}</svg>`;
}

function renderShapeSvg(l: ShapeLayer, canvasW: number, canvasH: number): string {
  const w = l.w * canvasW;
  const h = l.h * canvasH;
  const x = l.x * canvasW;
  const y = l.y * canvasH;
  const transform = l.rotation ? `transform="rotate(${l.rotation} ${x + w / 2} ${y + h / 2})"` : "";
  return `<g ${transform} opacity="${l.opacity}"><g transform="translate(${x} ${y})">${shapeToSvgEls(l, w, h)}</g></g>`;
}

function renderTextSvg(
  l: TextLayer,
  canvasW: number,
  canvasH: number,
  safeText: (s: string) => string,
): string {
  const anchor = l.align === "center" ? "middle" : l.align === "right" ? "end" : "start";
  const xAbs = (l.x + (l.align === "center" ? l.w / 2 : l.align === "right" ? l.w : 0)) * canvasW;
  const yAbs = l.y * canvasH;
  const weight = l.bold ? 700 : 400;
  const style = l.italic ? "italic" : "normal";
  const widthPx = l.w * canvasW;
  const approxCharsPerLine = Math.max(8, Math.floor(widthPx / (l.fontSize * 0.55)));
  const words = l.text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > approxCharsPerLine) {
      if (line) lines.push(line);
      line = w;
    } else {
      line = line ? line + " " + w : w;
    }
  }
  if (line) lines.push(line);
  const lineHeight = l.fontSize * 1.15;
  const tspans = lines
    .map((ln, i) => `<tspan x="${xAbs}" dy="${i === 0 ? 0 : lineHeight}">${safeText(ln)}</tspan>`)
    .join("");
  const rotation = l.rotation ? `transform="rotate(${l.rotation} ${xAbs} ${yAbs})"` : "";
  return `<text x="${xAbs}" y="${yAbs}" fill="${l.color}" font-family='${l.font}, sans-serif' font-size="${l.fontSize}" font-weight="${weight}" font-style="${style}" text-anchor="${anchor}" dominant-baseline="hanging" opacity="${l.opacity}" ${rotation}>${tspans}</text>`;
}

function CommonTransform({ layer, updateLayer }: { layer: Layer; updateLayer: (id: string, patch: Partial<Layer>) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <label className="space-y-1">
        <span className="text-muted-foreground">X</span>
        <Input type="range" min={0} max={1} step={0.01} value={layer.x} onChange={(e) => updateLayer(layer.id, { x: Number(e.target.value) })} />
      </label>
      <label className="space-y-1">
        <span className="text-muted-foreground">Y</span>
        <Input type="range" min={0} max={1} step={0.01} value={layer.y} onChange={(e) => updateLayer(layer.id, { y: Number(e.target.value) })} />
      </label>
      <label className="space-y-1">
        <span className="text-muted-foreground">Width</span>
        <Input type="range" min={0.05} max={1} step={0.01} value={layer.w} onChange={(e) => updateLayer(layer.id, { w: Number(e.target.value) })} />
      </label>
      {"h" in layer && (
        <label className="space-y-1">
          <span className="text-muted-foreground">Height</span>
          <Input type="range" min={0.05} max={1} step={0.01} value={(layer as ShapeLayer).h} onChange={(e) => updateLayer(layer.id, { h: Number(e.target.value) } as Partial<Layer>)} />
        </label>
      )}
      <label className="space-y-1">
        <span className="text-muted-foreground">Opacity</span>
        <Input type="range" min={0} max={1} step={0.05} value={layer.opacity} onChange={(e) => updateLayer(layer.id, { opacity: Number(e.target.value) })} />
      </label>
      <label className="space-y-1">
        <span className="text-muted-foreground">Rotate</span>
        <Input type="range" min={-180} max={180} step={1} value={layer.rotation} onChange={(e) => updateLayer(layer.id, { rotation: Number(e.target.value) })} />
      </label>
    </div>
  );
}

function ShapesMenu({ onPick }: { onPick: (s: ShapeKind) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const shapes: { kind: ShapeKind; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { kind: "rect", label: "Rectangle", icon: Square },
    { kind: "circle", label: "Ellipse", icon: CircleIcon },
    { kind: "badge", label: "Pill / badge", icon: Square },
    { kind: "line", label: "Line", icon: Minus },
    { kind: "arrow", label: "Arrow", icon: Minus },
    { kind: "star", label: "Star", icon: Star },
  ];

  return (
    <div ref={ref} className="relative">
      <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
        <Shapes className="h-3.5 w-3.5" /> Shape
        <ChevronDown className="h-3 w-3 opacity-60" />
      </Button>
      {open && (
        <div className="absolute left-0 top-9 z-50 min-w-[160px] overflow-hidden rounded-md border border-border bg-popover shadow-2xl">
          {shapes.map((s) => {
            const I = s.icon;
            return (
              <button
                key={s.kind}
                type="button"
                onClick={() => {
                  onPick(s.kind);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-secondary"
              >
                <I className="h-3.5 w-3.5 text-muted-foreground" />
                {s.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CatPill({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] capitalize transition",
        active ? "border-[hsl(var(--primary-soft))] bg-[hsl(var(--primary-soft)/0.12)] text-[hsl(var(--primary-soft))]" : "border-border text-muted-foreground hover:bg-secondary",
      )}
    >
      {children}
    </button>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-6 w-6 cursor-pointer rounded border border-input" />
        <span className="font-mono text-[10px]">{value}</span>
      </span>
    </label>
  );
}

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded border transition",
        active ? "border-[hsl(var(--primary-soft))] bg-[hsl(var(--primary-soft)/0.12)] text-[hsl(var(--primary-soft))]" : "border-border text-muted-foreground hover:bg-secondary",
      )}
    >
      {children}
    </button>
  );
}

