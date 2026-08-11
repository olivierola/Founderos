/**
 * The editing runtime — Editor.js itself.
 *
 * Loaded only when a human edits (the read path uses BlockRenderer and never
 * pulls this in). Two things matter here:
 *
 *  1. THE CUSTOM BLOCKS MUST SURVIVE. Editor.js silently DROPS any block whose
 *     `type` has no registered tool. An agent's chart, KPI row or matrix would
 *     be destroyed the first time someone opened the document to fix a typo.
 *     Every custom type is therefore registered as a passthrough tool: it shows
 *     a labelled card, refuses inline editing, and hands its data back to
 *     `save()` byte-identical. The human edits the prose around it; the agent's
 *     structure is untouched.
 *  2. Saving is debounced and never fires on the initial render — mounting an
 *     editor is not a modification.
 */
import { useEffect, useRef } from "react";
import EditorJS, { type BlockToolConstructable, type OutputData } from "@editorjs/editorjs";
import Header from "@editorjs/header";
import List from "@editorjs/list";
import ImageTool from "@editorjs/image";
import Table from "@editorjs/table";
import Quote from "@editorjs/quote";
import Code from "@editorjs/code";
import Delimiter from "@editorjs/delimiter";
import Checklist from "@editorjs/checklist";
import { type ArtifactDocument } from "./blocks";

/** Types the agent produces that Editor.js has no tool for. */
const PASSTHROUGH: Array<{ type: string; label: string }> = [
  { type: "kpi", label: "Indicateurs clés" },
  { type: "chart", label: "Graphique" },
  { type: "banner", label: "Bandeau" },
  { type: "comparison", label: "Grille comparative" },
  { type: "matrix", label: "Matrice de positionnement" },
  { type: "callout", label: "Encadré" },
  { type: "slide", label: "Nouvelle slide" },
];

/**
 * A tool that renders a placard and preserves its data.
 *
 * This is the whole reason agent-authored structure survives human editing.
 * `save()` returns the data it was constructed with — no parsing, no rewriting,
 * no chance of mangling a chart into a paragraph.
 */
function passthroughTool(type: string, label: string): BlockToolConstructable {
  return class {
    private data: Record<string, unknown>;
    static get isReadOnlySupported() { return true; }
    static get toolbox() { return { title: label, icon: "▦" }; }
    constructor({ data }: { data: Record<string, unknown> }) { this.data = data ?? {}; }
    render() {
      const el = document.createElement("div");
      el.className = "rounded-xl border border-dashed border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground";
      const title = (this.data as { title?: string }).title;
      el.textContent = title ? `${label} — ${title}` : `${label} (généré par l'agent, non modifiable ici)`;
      el.contentEditable = "false";
      return el;
    }
    save() { return this.data; }
  } as unknown as BlockToolConstructable;
}

export function ArtifactEditor({ doc, onChange, readOnly, className }: {
  doc: ArtifactDocument;
  onChange?: (doc: ArtifactDocument) => void;
  readOnly?: boolean;
  className?: string;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorJS | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mounting fires onChange in some versions; ignore anything before ready.
  const ready = useRef(false);

  useEffect(() => {
    if (!holder.current) return;
    ready.current = false;

    const tools: Record<string, unknown> = {
      header: { class: Header, inlineToolbar: true, config: { levels: [1, 2, 3, 4], defaultLevel: 2 } },
      list: { class: List, inlineToolbar: true },
      checklist: { class: Checklist, inlineToolbar: true },
      table: { class: Table, inlineToolbar: true },
      quote: { class: Quote, inlineToolbar: true },
      code: Code,
      delimiter: Delimiter,
      // Uploads are not wired: agents reference images by URL, and a paste-by-url
      // field is the honest affordance until a storage endpoint exists here.
      image: { class: ImageTool, config: { uploader: { uploadByUrl: (url: string) => Promise.resolve({ success: 1, file: { url } }) } } },
    };
    for (const { type, label } of PASSTHROUGH) tools[type] = passthroughTool(type, label);

    // Drop any tool whose import did not resolve to a constructor. Editor.js
    // throws during init on a malformed tool and leaves the holder empty, so a
    // single bad interop default looked exactly like "the editor deleted
    // everything". Losing one block type beats losing the whole editor.
    for (const [name, t] of Object.entries(tools)) {
      const cls = (t as { class?: unknown })?.class ?? t;
      if (typeof cls !== "function") {
        console.warn(`[artifact] outil « ${name} » indisponible — bloc rendu en lecture seule`);
        tools[name] = passthroughTool(name, name);
      }
    }

    const instance = new EditorJS({
      holder: holder.current,
      data: { blocks: doc.blocks } as OutputData,
      readOnly,
      minHeight: 120,
      placeholder: "Écrivez, ou tapez / pour un bloc…",
      tools: tools as never,
      onReady: () => { ready.current = true; },
      onChange: async () => {
        if (!onChange || readOnly || !ready.current) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(async () => {
          try {
            const out = await instance.save();
            const next = out.blocks as ArtifactDocument["blocks"];
            // REFUSE to persist an emptied document. Editor.js drops blocks it
            // has no tool for, and a single unregistered type would otherwise
            // turn "open the editor" into "delete the report" — the save runs
            // 600 ms later, with nothing on screen to warn anyone.
            if (doc.blocks.length > 0 && next.length === 0) {
              console.error("[artifact] éditeur vidé au montage — sauvegarde annulée pour ne pas perdre le document");
              return;
            }
            onChange({ time: out.time, version: out.version, blocks: next });
          } catch { /* a save that fails must not break typing */ }
        }, 600);
      },
    });
    editor.current = instance;

    return () => {
      if (timer.current) clearTimeout(timer.current);
      // destroy() is absent on a failed init; guard rather than throw on unmount.
      instance.isReady
        .then(() => instance.destroy?.())
        .catch(() => {});
      editor.current = null;
    };
    // Remounts only on a different document — not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  return <div ref={holder} className={className} />;
}

export default ArtifactEditor;
