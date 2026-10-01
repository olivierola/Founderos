/**
 * Render a PdfSpec to PDF bytes, in a worker (see pdf.worker.ts).
 *
 * The worker — and the 4 MB of WebAssembly behind it — is created on the first
 * export, not at load. It is then kept: the wasm is compiled once, and every
 * later export is tens of milliseconds.
 */
import type { PdfRenderOptions, PdfSpec } from "@/lib/pdf/types";
import { pdfFileName } from "@/lib/pdf/text";
import type { PdfWorkerRequest, PdfWorkerResponse } from "./pdf.worker";

export interface RenderedPdf { blob: Blob; ms: number; warnings: string[] }

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: RenderedPdf) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./pdf.worker.ts", import.meta.url), { type: "module", name: "pdf-renderer" });
  worker.onmessage = (event: MessageEvent<PdfWorkerResponse>) => {
    const res = event.data;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) p.resolve({ blob: new Blob([res.bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), ms: res.ms, warnings: res.warnings });
    else p.reject(new Error(res.error));
  };
  worker.onerror = (event) => {
    // A worker that failed to boot (wasm blocked, bundle error) fails every
    // waiting export rather than leaving spinners forever, and is rebuilt next time.
    const err = new Error(event.message || "Le moteur PDF n'a pas pu démarrer.");
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function renderPdf(spec: PdfSpec, options?: PdfRenderOptions): Promise<RenderedPdf> {
  const id = ++seq;
  return new Promise<RenderedPdf>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, spec, options } satisfies PdfWorkerRequest);
  });
}

export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function specTitle(spec: PdfSpec): string {
  return spec.kind === "document" ? spec.doc.title : `Facture ${spec.invoice.number}`;
}

/** Render and save in one go, for callers that need no preview. */
export async function downloadPdf(spec: PdfSpec, options?: PdfRenderOptions): Promise<RenderedPdf> {
  const out = await renderPdf(spec, options);
  saveBlob(out.blob, pdfFileName(specTitle(spec)));
  return out;
}
