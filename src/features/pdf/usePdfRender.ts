import { useEffect, useRef, useState } from "react";
import type { PdfRenderOptions, PdfSpec } from "@/lib/pdf/types";
import { renderPdf } from "./renderPdf";

export interface PdfRenderState {
  url: string | null;
  blob: Blob | null;
  loading: boolean;
  error: string | null;
  ms: number | null;
  warnings: string[];
}

/**
 * The PDF for a spec, re-rendered whenever the spec or the options change.
 *
 * Keyed on their JSON, so a caller rebuilding an equal spec on every render does
 * not start a new one. The previous PDF stays on screen until the next is ready
 * (switching theme must not flash an empty frame), and a result that arrives
 * after a newer request was made is thrown away.
 */
export function usePdfRender(spec: PdfSpec | null, options: PdfRenderOptions, enabled = true): PdfRenderState {
  const [state, setState] = useState<PdfRenderState>({ url: null, blob: null, loading: false, error: null, ms: null, warnings: [] });
  const current = useRef<string | null>(null);
  const key = spec && enabled ? JSON.stringify([spec, options]) : null;

  useEffect(() => {
    if (!key || !spec) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    renderPdf(spec, options)
      .then((out) => {
        if (!alive) return;
        const url = URL.createObjectURL(out.blob);
        if (current.current) URL.revokeObjectURL(current.current);
        current.current = url;
        setState({ url, blob: out.blob, loading: false, error: null, ms: out.ms, warnings: out.warnings });
      })
      .catch((e: unknown) => {
        if (alive) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      });
    return () => { alive = false; };
    // `key` is the dependency: it is spec + options, serialised.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => () => {
    if (current.current) URL.revokeObjectURL(current.current);
  }, []);

  return state;
}
