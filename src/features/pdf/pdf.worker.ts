/**
 * The PDF renderer, off the main thread.
 *
 * Takumi is 4 MB of WebAssembly: it is fetched the first time someone exports,
 * never on page load, and a render never freezes the UI while it lays out a
 * forty-page report. Renders are SERIALISED: pdfcn keeps the current theme in a
 * module variable (see components/pdf/theme-provider.tsx), so two documents
 * laid out at once would borrow each other's colours.
 */
// Must stay the first import: see workerEnv.ts.
import "./workerEnv";
import initPdf, { render } from "takumi-pdf/no-init";
import wasmUrl from "takumi-pdf/takumi_pdf_wasm_bg.wasm?url";
import type { PdfRenderOptions, PdfSpec } from "@/lib/pdf/types";
import { buildPdf } from "./documents/pdfRoot";

export type PdfWorkerRequest = { id: number; spec: PdfSpec; options?: PdfRenderOptions };
export type PdfWorkerResponse =
  | { id: number; ok: true; bytes: Uint8Array; ms: number; warnings: string[] }
  | { id: number; ok: false; error: string };

let ready: Promise<unknown> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Takumi does not fetch: every image in the tree is handed over as bytes. An
 *  image that cannot be fetched (CORS, 404) is dropped from the document rather
 *  than failing the whole export — and the caller is told which. */
async function prepareImages(spec: PdfSpec): Promise<{ spec: PdfSpec; sources: Array<{ src: string; data: ArrayBuffer }>; warnings: string[] }> {
  if (spec.kind !== "document") return { spec, sources: [], warnings: [] };
  const srcs = Array.from(new Set(spec.doc.blocks.flatMap((b) => (b.type === "image" ? [b.src] : []))));
  if (srcs.length === 0) return { spec, sources: [], warnings: [] };
  const warnings: string[] = [];
  const sources: Array<{ src: string; data: ArrayBuffer }> = [];
  await Promise.all(srcs.map(async (src) => {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(String(res.status));
      sources.push({ src, data: await res.arrayBuffer() });
    } catch {
      warnings.push(`Image non incluse (inaccessible) : ${src.slice(0, 80)}`);
    }
  }));
  const loaded = new Set(sources.map((s) => s.src));
  const blocks = spec.doc.blocks.flatMap((b) => {
    if (b.type !== "image" || loaded.has(b.src)) return [b];
    // Keep what the image was saying, if anything.
    return b.caption ? [{ type: "paragraph" as const, text: `[Image] ${b.caption}` }] : [];
  });
  return { spec: { kind: "document", doc: { ...spec.doc, blocks } }, sources, warnings };
}

async function handle(req: PdfWorkerRequest): Promise<PdfWorkerResponse> {
  ready ??= initPdf({ module_or_path: wasmUrl });
  await ready;
  const t0 = performance.now();
  const { spec, sources, warnings } = await prepareImages(req.spec);
  const { element, render: options } = buildPdf(spec, req.options);
  const bytes = await render(element, { ...options, images: { sources } } as Parameters<typeof render>[1]);
  return { id: req.id, ok: true, bytes, ms: Math.round(performance.now() - t0), warnings };
}

self.onmessage = (event: MessageEvent<PdfWorkerRequest>) => {
  const req = event.data;
  queue = queue.then(async () => {
    try {
      const res = await handle(req);
      const transfer = res.ok ? [res.bytes.buffer as ArrayBuffer] : [];
      (self as unknown as Worker).postMessage(res, transfer);
    } catch (e) {
      (self as unknown as Worker).postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies PdfWorkerResponse);
    }
  });
};
