/**
 * Dev-only shim, imported FIRST by pdf.worker.ts.
 *
 * In `vite dev`, @vitejs/plugin-react adds React Refresh to every .tsx module.
 * Inside a worker that code breaks twice: its runtime (/@react-refresh) assigns
 * `window.__registerBeforePerformReactRefresh` at load — a worker has no
 * `window` — and each component module then calls `$RefreshReg$` / `$RefreshSig$`,
 * which only the page's preamble defines. The first pdfcn component the worker
 * imported threw, and no PDF ever rendered in dev.
 *
 * Hot reload means nothing in a worker, so the registrations are no-ops here.
 * Production builds carry no Refresh code; nothing is touched there.
 */
type RefreshGlobals = {
  window?: unknown;
  $RefreshReg$?: (type: unknown, id: string) => void;
  $RefreshSig$?: () => (type: unknown) => unknown;
};

if (import.meta.env.DEV) {
  const g = globalThis as RefreshGlobals;
  if (typeof g.window === "undefined") g.window = globalThis;
  g.$RefreshReg$ ??= () => {};
  g.$RefreshSig$ ??= () => (type) => type;
}

export {};
