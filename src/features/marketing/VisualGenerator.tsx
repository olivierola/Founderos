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
} from "lucide-react";
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
  FONT_OPTIONS,
  TEMPLATE_CATEGORIES,
  VISUAL_TEMPLATES,
  type CanvasFormat,
  type TemplateColors,
  type TemplateDef,
} from "./visualTemplates";

interface TextLayer {
  id: string;
  text: string;
  /** 0..1 of the canvas width */
  x: number;
  /** 0..1 of the canvas height */
  y: number;
  /** Width in 0..1 — height adjusts to content */
  w: number;
  /** font-size in px (sized in canvas units, scaled by display) */
  fontSize: number;
  color: string;
  font: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
}

interface VisualGeneratorProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Default content seeded from the post (title / body / handle). */
  initialContent?: { title?: string; body?: string; handle?: string };
}

export function VisualGenerator({ open, onOpenChange, initialContent }: VisualGeneratorProps) {
  const [format, setFormat] = useState<CanvasFormat>(CANVAS_FORMATS[0]);
  const [customW, setCustomW] = useState(1200);
  const [customH, setCustomH] = useState(800);
  const [template, setTemplate] = useState<TemplateDef>(VISUAL_TEMPLATES[0]);
  const [colors, setColors] = useState<TemplateColors>(VISUAL_TEMPLATES[0].defaultColors);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [layers, setLayers] = useState<TextLayer[]>([]);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const toast = useToast();
  const stageRef = useRef<HTMLDivElement>(null);

  const canvasW = format.id === "custom" ? customW : format.width;
  const canvasH = format.id === "custom" ? customH : format.height;

  // Seed text layers from the initial post content the first time the dialog
  // opens. Re-seed when the dialog is reopened with new content.
  useEffect(() => {
    if (!open) return;
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

    const seeds: TextLayer[] = [];
    if (titleText) {
      // Auto-size based on title length: short -> larger, long -> smaller.
      const titleLen = titleText.length;
      const titleSize = titleLen < 30 ? canvasW / 12 : titleLen < 60 ? canvasW / 16 : canvasW / 22;
      seeds.push({
        id: "l-title",
        text: titleText,
        x: 0.06,
        y: 0.22,
        w: 0.88,
        fontSize: Math.round(titleSize),
        color: "#ffffff",
        font: FONT_OPTIONS[0].value,
        bold: true,
        italic: false,
        align: "left",
      });
    }
    if (bodyText) {
      seeds.push({
        id: "l-body",
        text: bodyText.slice(0, 180),
        x: 0.06,
        y: 0.52,
        w: 0.82,
        fontSize: Math.round(canvasW / 38),
        color: "#e5e7eb",
        font: FONT_OPTIONS[0].value,
        bold: false,
        italic: false,
        align: "left",
      });
    }
    if (initialContent?.handle) {
      seeds.push({
        id: "l-handle",
        text: initialContent.handle,
        x: 0.06,
        y: 0.9,
        w: 0.5,
        fontSize: Math.round(canvasW / 56),
        color: "#cbd5e1",
        font: FONT_OPTIONS[0].value,
        bold: false,
        italic: false,
        align: "left",
      });
    }
    if (seeds.length === 0) {
      seeds.push({
        id: "l-title",
        text: "Your headline goes here.",
        x: 0.06,
        y: 0.4,
        w: 0.88,
        fontSize: Math.round(canvasW / 14),
        color: "#ffffff",
        font: FONT_OPTIONS[0].value,
        bold: true,
        italic: false,
        align: "left",
      });
    }
    setLayers(seeds);
    setSelectedLayer(seeds[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialContent?.title, initialContent?.body]);

  // Reset state when closing.
  useEffect(() => {
    if (!open) {
      setLayers([]);
      setSelectedLayer(null);
    }
  }, [open]);

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

  function updateLayer(id: string, patch: Partial<TextLayer>) {
    setLayers((arr) => arr.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  function addLayer() {
    const id = "l-" + Math.random().toString(36).slice(2, 7);
    const newLayer: TextLayer = {
      id,
      text: "New text",
      x: 0.1,
      y: 0.5,
      w: 0.6,
      fontSize: Math.round(canvasW / 20),
      color: "#ffffff",
      font: FONT_OPTIONS[0].value,
      bold: false,
      italic: false,
      align: "left",
    };
    setLayers((arr) => [...arr, newLayer]);
    setSelectedLayer(id);
  }

  function removeLayer(id: string) {
    setLayers((arr) => arr.filter((l) => l.id !== id));
    if (selectedLayer === id) setSelectedLayer(null);
  }

  /* Build the SVG markup that combines the template background and the text
   * layers. Used both for live preview (innerHTML) and for export. */
  function buildSvg(): string {
    const bg = template.render(colors);
    const safeText = (t: string) =>
      t
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const layerSvgs = layers
      .map((l) => {
        const anchor = l.align === "center" ? "middle" : l.align === "right" ? "end" : "start";
        const xAbs = (l.x + (l.align === "center" ? l.w / 2 : l.align === "right" ? l.w : 0)) * canvasW;
        const yAbs = l.y * canvasH;
        const weight = l.bold ? 700 : 400;
        const style = l.italic ? "italic" : "normal";
        // Wrap by char width approximation
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
          .map(
            (ln, i) =>
              `<tspan x="${xAbs}" dy="${i === 0 ? 0 : lineHeight}">${safeText(ln)}</tspan>`,
          )
          .join("");
        return `<text x="${xAbs}" y="${yAbs}" fill="${l.color}" font-family="${l.font}" font-size="${l.fontSize}" font-weight="${weight}" font-style="${style}" text-anchor="${anchor}" dominant-baseline="hanging">${tspans}</text>`;
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

  /* Snap guides shown while dragging. */
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});

  /* Drag / resize handlers for text layers with snap to center and edges. */
  function handleDrag(layer: TextLayer, e: React.MouseEvent) {
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

        <div className="grid flex-1 grid-cols-[260px_1fr_300px] overflow-hidden">
          {/* Left rail: templates */}
          <aside className="flex flex-col border-r border-border bg-card/40">
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
          <main className="flex flex-col overflow-hidden bg-secondary/30">
            <div className="flex items-center justify-between gap-2 border-b border-border bg-card/40 px-4 py-3">
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
                <Button size="sm" variant="outline" onClick={addLayer}>
                  <Plus className="h-3.5 w-3.5" /> Text
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={downloadSvg}>
                  <Download className="h-3.5 w-3.5" /> SVG
                </Button>
                <Button size="sm" onClick={downloadPng} disabled={downloading}>
                  <Download className="h-3.5 w-3.5" /> {downloading ? "Exporting…" : "PNG"}
                </Button>
              </div>
            </div>
            <div className="relative flex-1 overflow-hidden">
              <StageWrapper canvasW={canvasW} canvasH={canvasH}>
                {(displayW) => (
                  <div
                    ref={stageRef}
                    onClick={() => setSelectedLayer(null)}
                    className="relative overflow-hidden rounded-lg shadow-2xl"
                    style={{
                      width: displayW,
                      height: (displayW * canvasH) / canvasW,
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

                    {/* Overlay text layers (HTML, interactive). The export rebuilds them as <text> in SVG. */}
                    {layers.map((l) => {
                      const isSelected = selectedLayer === l.id;
                      const scale = displayW / canvasW;
                      return (
                        <div
                          key={l.id}
                          onMouseDown={(e) => handleDrag(l, e)}
                          className={cn(
                            "absolute cursor-move select-none",
                            isSelected && "outline outline-2 outline-[hsl(var(--primary-soft))] outline-offset-2",
                          )}
                          style={{
                            left: `${l.x * 100}%`,
                            top: `${l.y * 100}%`,
                            width: `${l.w * 100}%`,
                            color: l.color,
                            fontFamily: l.font,
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
                    })}
                  </div>
                )}
              </StageWrapper>
            </div>
          </main>

          {/* Right rail: inspector */}
          <aside className="flex flex-col overflow-y-auto border-l border-border bg-card/40 p-4">
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
              {layers.map((l) => (
                <li
                  key={l.id}
                  onClick={() => setSelectedLayer(l.id)}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs",
                    selectedLayer === l.id ? "border-[hsl(var(--primary-soft))] bg-[hsl(var(--primary-soft)/0.1)]" : "border-border",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Type className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{l.text || "Empty"}</span>
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeLayer(l.id);
                    }}
                    className="opacity-50 hover:opacity-100"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
              {layers.length === 0 && (
                <p className="rounded-md border border-dashed border-border p-2 text-center text-[11px] text-muted-foreground">
                  No text. Click "Text" to add one.
                </p>
              )}
            </ul>

            {selectedLayerObj && (
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
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <label className="space-y-1">
                    <span className="text-muted-foreground">Font</span>
                    <select
                      value={selectedLayerObj.font}
                      onChange={(e) => updateLayer(selectedLayerObj.id, { font: e.target.value })}
                      className="h-7 w-full rounded border border-input bg-background px-1"
                    >
                      {FONT_OPTIONS.map((f) => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-muted-foreground">Size</span>
                    <Input
                      type="number"
                      value={selectedLayerObj.fontSize}
                      onChange={(e) => updateLayer(selectedLayerObj.id, { fontSize: Number(e.target.value) || 24 })}
                      className="h-7 text-xs"
                    />
                  </label>
                  <label className="space-y-1 col-span-2">
                    <span className="text-muted-foreground">Color</span>
                    <input
                      type="color"
                      value={selectedLayerObj.color}
                      onChange={(e) => updateLayer(selectedLayerObj.id, { color: e.target.value })}
                      className="h-7 w-full rounded border border-input"
                    />
                  </label>
                </div>
                <div className="flex items-center gap-1">
                  <ToggleBtn
                    active={selectedLayerObj.bold}
                    onClick={() => updateLayer(selectedLayerObj.id, { bold: !selectedLayerObj.bold })}
                  >
                    <Bold className="h-3 w-3" />
                  </ToggleBtn>
                  <ToggleBtn
                    active={selectedLayerObj.italic}
                    onClick={() => updateLayer(selectedLayerObj.id, { italic: !selectedLayerObj.italic })}
                  >
                    <Italic className="h-3 w-3" />
                  </ToggleBtn>
                  <span className="mx-1 h-4 w-px bg-border" />
                  <ToggleBtn
                    active={selectedLayerObj.align === "left"}
                    onClick={() => updateLayer(selectedLayerObj.id, { align: "left" })}
                  >
                    <AlignLeft className="h-3 w-3" />
                  </ToggleBtn>
                  <ToggleBtn
                    active={selectedLayerObj.align === "center"}
                    onClick={() => updateLayer(selectedLayerObj.id, { align: "center" })}
                  >
                    <AlignCenter className="h-3 w-3" />
                  </ToggleBtn>
                  <ToggleBtn
                    active={selectedLayerObj.align === "right"}
                    onClick={() => updateLayer(selectedLayerObj.id, { align: "right" })}
                  >
                    <AlignRight className="h-3 w-3" />
                  </ToggleBtn>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <label className="space-y-1">
                    <span className="text-muted-foreground">X position</span>
                    <Input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={selectedLayerObj.x}
                      onChange={(e) => updateLayer(selectedLayerObj.id, { x: Number(e.target.value) })}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-muted-foreground">Y position</span>
                    <Input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={selectedLayerObj.y}
                      onChange={(e) => updateLayer(selectedLayerObj.id, { y: Number(e.target.value) })}
                    />
                  </label>
                  <label className="space-y-1 col-span-2">
                    <span className="text-muted-foreground">Width</span>
                    <Input
                      type="range"
                      min={0.1}
                      max={1}
                      step={0.01}
                      value={selectedLayerObj.w}
                      onChange={(e) => updateLayer(selectedLayerObj.id, { w: Number(e.target.value) })}
                    />
                  </label>
                </div>
              </div>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
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

/* Sizing wrapper that measures its available box and fits the stage so it
 * never overflows in width or height — both dimensions respect the canvas
 * aspect ratio. */
function StageWrapper({
  canvasW,
  canvasH,
  children,
}: {
  canvasW: number;
  canvasH: number;
  children: (displayW: number) => React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const update = () => {
      if (!ref.current) return;
      const r = ref.current.getBoundingClientRect();
      setBox({ w: r.width, h: r.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  // Fit the canvas aspect ratio inside the available (width, height) box.
  // displayW = min(box.w, box.h * aspect) — guarantees no overflow in either
  // axis even when the editor is resized live.
  const aspect = canvasW / canvasH;
  const displayW = box ? Math.max(0, Math.min(box.w, box.h * aspect)) : 0;

  return (
    <div ref={ref} className="absolute inset-6 flex items-center justify-center">
      {displayW > 0 && children(displayW)}
    </div>
  );
}
