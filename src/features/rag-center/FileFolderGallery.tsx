import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Image as ImageIcon, FileText, FileSpreadsheet, Presentation, Globe,
  Database, File as FileIcon, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── File kind → icon + gradient ──────────────────────────────────────────────
export type FileKind = "image" | "pdf" | "word" | "excel" | "powerpoint" | "text" | "url" | "data" | "other";

const KIND_META: Record<FileKind, { icon: LucideIcon; grad: string; label: string }> = {
  image: { icon: ImageIcon, grad: "from-violet-500 to-fuchsia-600", label: "Image" },
  pdf: { icon: FileText, grad: "from-red-500 to-rose-600", label: "PDF" },
  word: { icon: FileText, grad: "from-blue-500 to-indigo-600", label: "Word" },
  excel: { icon: FileSpreadsheet, grad: "from-emerald-500 to-green-600", label: "Excel" },
  powerpoint: { icon: Presentation, grad: "from-orange-500 to-amber-600", label: "Slides" },
  text: { icon: FileText, grad: "from-slate-500 to-slate-700", label: "Texte" },
  url: { icon: Globe, grad: "from-cyan-500 to-sky-600", label: "URL" },
  data: { icon: Database, grad: "from-amber-500 to-yellow-600", label: "Données" },
  other: { icon: FileIcon, grad: "from-zinc-500 to-zinc-700", label: "Fichier" },
};

const EXT_KIND: Record<string, FileKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", bmp: "image", heic: "image",
  pdf: "pdf",
  doc: "word", docx: "word", rtf: "word", odt: "word",
  xls: "excel", xlsx: "excel", csv: "excel", ods: "excel",
  ppt: "powerpoint", pptx: "powerpoint", key: "powerpoint",
  txt: "text", md: "text", markdown: "text",
  json: "data", xml: "data", yaml: "data", yml: "data",
};

/** Derive a file kind from a rag_source (type + filename/ref extension). */
export function fileKindOf(source: { type: string; title: string; source_ref?: string | null }): FileKind {
  if (source.type === "url") return "url";
  if (source.type === "saas_structure") return "data";
  const name = (source.source_ref || source.title || "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return EXT_KIND[ext] ?? (source.type === "text" ? "text" : "other");
}

export interface GalleryFile {
  id: string;
  title: string;
  kind: FileKind;
  status?: string;
}

interface FileFolderGalleryProps {
  files: GalleryFile[];
  folderName: string;
  /** Animate straight into the open (fanned-out) state on mount. */
  autoOpen?: boolean;
  onClose?: () => void;
  className?: string;
}

/**
 * A folder that opens to fan out its files — adapted from the InteractiveFolder
 * gallery, rendering typed file cards (pdf/docx/xlsx/image/…) instead of photos.
 * Drag any card down to close.
 */
export function FileFolderGallery({ files, folderName, autoOpen = false, onClose, className }: FileFolderGalleryProps) {
  const [isFolderOpen, setIsFolderOpen] = useState(false);
  const [hoverFolder, setHoverFolder] = useState(false);

  // Auto-open a beat after mount so the fan-out animates in an overlay.
  useEffect(() => {
    if (!autoOpen) return;
    const t = setTimeout(() => setIsFolderOpen(true), 120);
    return () => clearTimeout(t);
  }, [autoOpen]);

  const shown = files.slice(0, 5);
  const mid = (shown.length - 1) / 2;

  function close() {
    setIsFolderOpen(false);
    setHoverFolder(false);
    onClose?.();
  }

  return (
    <div className={cn("relative w-full", className)}>
      <div className="relative flex min-h-[460px] w-full flex-col items-center justify-center">
        <div className="pointer-events-none relative z-0 flex h-[460px] w-[400px] justify-center">

          {/* Folder back pocket */}
          <motion.div
            className="absolute bottom-6 h-52 w-80 drop-shadow-2xl"
            animate={{ opacity: isFolderOpen ? 0 : 1, scale: isFolderOpen ? 0.9 : 1 }}
          >
            <div className="absolute left-0 top-0 h-10 w-32 rounded-t-xl border-l border-r border-t border-white/10 bg-gradient-to-t from-[#1e1e1e] to-[#2a2a2a]" />
            <div className="absolute bottom-0 left-0 right-0 top-8 rounded-b-xl rounded-tr-xl border border-white/10 bg-gradient-to-b from-[#1e1e1e] to-[#0a0a0a] shadow-[inset_0_0_40px_rgba(0,0,0,0.8)]" />
            <div className="pointer-events-none absolute bottom-2 left-2 right-2 top-10 rounded-lg bg-black shadow-inner" />
          </motion.div>

          {/* File cards */}
          {shown.length > 0 && (
            <div className="absolute bottom-10 z-10 flex justify-center">
              {shown.map((f, i) => {
                const offset = i - mid;
                const stackY = hoverFolder ? offset * -10 - 40 : offset * -5;
                const stackX = hoverFolder ? offset * 30 : offset * 3;
                const stackRotate = hoverFolder ? offset * 8 : offset * 3;
                const stackScale = 1 - Math.abs(offset) * 0.03;
                const openX = offset * 130;
                return (
                  <motion.div
                    key={f.id}
                    drag={isFolderOpen}
                    dragSnapToOrigin
                    onDragEnd={(_e, info) => { if (info.offset.y > 100 && isFolderOpen) close(); }}
                    className={cn(
                      "absolute bottom-0 h-72 w-56 origin-bottom overflow-hidden rounded-xl border border-white/20 shadow-[0_20px_40px_rgba(0,0,0,0.5)]",
                      isFolderOpen ? "pointer-events-auto cursor-grab active:cursor-grabbing" : "pointer-events-none",
                    )}
                    animate={!isFolderOpen
                      ? { y: stackY, x: stackX, rotate: stackRotate, scale: stackScale, zIndex: i + 10 }
                      : { y: -130, x: openX, rotate: 0, scale: 1.05, zIndex: 50 }}
                    whileHover={isFolderOpen ? { scale: 1.1, zIndex: 100 } : {}}
                    whileDrag={isFolderOpen ? { scale: 1.15, rotate: 5, zIndex: 150 } : {}}
                    transition={{ type: "spring", stiffness: 350, damping: 30 }}
                  >
                    <FileCardFace file={f} />
                  </motion.div>
                );
              })}
            </div>
          )}

          {/* Folder front flap — click to open */}
          <motion.div
            className="pointer-events-auto absolute bottom-0 z-20 h-44 w-[340px] cursor-pointer drop-shadow-[0_-20px_40px_rgba(0,0,0,0.8)]"
            style={{ transformOrigin: "bottom" }}
            animate={{
              opacity: isFolderOpen ? 0 : 1,
              rotateX: hoverFolder ? -25 : 0,
              y: hoverFolder ? 10 : 0,
              pointerEvents: isFolderOpen ? "none" : "auto",
            }}
            onMouseEnter={() => setHoverFolder(true)}
            onMouseLeave={() => setHoverFolder(false)}
            onClick={() => setIsFolderOpen(true)}
          >
            <div className="relative flex h-full w-full items-end justify-center overflow-hidden rounded-2xl border border-white/20 bg-gradient-to-b from-[#2a2a2a] to-[#111] pb-8 shadow-[inset_0_2px_10px_rgba(255,255,255,0.1)]">
              <div className="absolute left-0 right-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
              <div className="flex items-center justify-center gap-2 rounded-lg border border-black/80 bg-black px-5 py-2.5 shadow-inner backdrop-blur-md">
                <span className="max-w-[220px] truncate text-sm font-medium tracking-wide text-white/90">{folderName}</span>
                <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-white/70">{files.length}</span>
              </div>
            </div>
          </motion.div>
        </div>

        {/* Drag hint */}
        <motion.div
          animate={{ opacity: isFolderOpen ? 1 : 0, y: isFolderOpen ? 0 : 50 }}
          className="pointer-events-none absolute bottom-6 rounded-full border border-white/10 bg-white/5 px-6 py-3 text-sm font-medium uppercase tracking-widest text-white/50 backdrop-blur-md"
        >
          Glissez un fichier vers le bas pour fermer
        </motion.div>
      </div>
    </div>
  );
}

function FileCardFace({ file }: { file: GalleryFile }) {
  const meta = KIND_META[file.kind];
  const Icon = meta.icon;
  return (
    <div className="flex h-full w-full flex-col bg-card">
      <div className={cn("flex flex-1 items-center justify-center bg-gradient-to-br", meta.grad)}>
        <Icon className="h-16 w-16 text-white/90 drop-shadow" strokeWidth={1.25} />
      </div>
      <div className="space-y-0.5 border-t border-white/10 p-3">
        <div className="truncate text-sm font-medium text-foreground" title={file.title}>{file.title}</div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{meta.label}</span>
          {file.status && file.status !== "ready" && (
            <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] uppercase text-amber-600 dark:text-amber-400">{file.status}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact, closed folder for the collection grid — a real folder with the file
 * cards fanned out of the top and the collection name on the front flap.
 * Matches the InteractiveFolder resting look; hover fans the cards wider.
 */
export function CollectionFolderCard({ folderName, count, kinds, onOpen }: {
  folderName: string; count: number; kinds: FileKind[]; onOpen: () => void;
}) {
  const [hover, setHover] = useState(false);
  const peek = kinds.slice(0, 5);
  const mid = (peek.length - 1) / 2;

  return (
    <button
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="group relative flex h-72 w-full items-end justify-center rounded-2xl bg-transparent p-4 transition-transform hover:scale-[1.02]"
      title={folderName}
    >
      <div className="relative flex h-[240px] w-[220px] justify-center">

        {/* Folder back pocket */}
        <div className="absolute bottom-4 h-32 w-48 drop-shadow-2xl">
          <div className="absolute left-0 top-0 h-6 w-20 rounded-t-lg border-l border-r border-t border-white/10 bg-gradient-to-t from-[#1e1e1e] to-[#2a2a2a]" />
          <div className="absolute bottom-0 left-0 right-0 top-4 rounded-b-xl rounded-tr-xl border border-white/10 bg-gradient-to-b from-[#1e1e1e] to-[#0a0a0a] shadow-[inset_0_0_30px_rgba(0,0,0,0.8)]" />
        </div>

        {/* Fanned file cards peeking out of the top */}
        <div className="absolute bottom-6 flex justify-center">
          {peek.map((k, i) => {
            const offset = i - mid;
            const Icon = KIND_META[k].icon;
            return (
              <motion.div
                key={i}
                className={cn(
                  "absolute bottom-0 h-44 w-32 origin-bottom overflow-hidden rounded-xl border border-white/20 bg-gradient-to-br shadow-[0_16px_30px_rgba(0,0,0,0.5)]",
                  KIND_META[k].grad,
                )}
                style={{ zIndex: 10 - Math.abs(offset) }}
                animate={{
                  x: offset * (hover ? 30 : 20),
                  y: hover ? -20 : -6,
                  rotate: offset * (hover ? 8 : 5),
                  scale: 1 - Math.abs(offset) * 0.04,
                }}
                transition={{ type: "spring", stiffness: 300, damping: 26 }}
              >
                <div className="flex h-full w-full items-start justify-center pt-5">
                  <Icon className="h-9 w-9 text-white/90 drop-shadow" strokeWidth={1.25} />
                </div>
              </motion.div>
            );
          })}
          {peek.length === 0 && (
            <div className="absolute bottom-0 h-44 w-32 rounded-xl border border-dashed border-white/15" style={{ transform: "translateY(-6px)" }} />
          )}
        </div>

        {/* Folder front flap + name pill */}
        <div className="absolute bottom-0 z-20 flex h-28 w-52 items-center justify-center overflow-hidden rounded-2xl border border-white/20 bg-gradient-to-b from-[#2a2a2a] to-[#111] shadow-[inset_0_2px_10px_rgba(255,255,255,0.1)]">
          <div className="absolute left-0 right-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
          <div className="flex max-w-[85%] items-center gap-2 rounded-lg border border-black/80 bg-black px-3.5 py-2 shadow-inner">
            <span className="truncate text-[13px] font-medium tracking-wide text-white/90">{folderName}</span>
            <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] tabular-nums text-white/70">{count}</span>
          </div>
        </div>
      </div>
    </button>
  );
}
