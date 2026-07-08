// Full-height right-hand detail panel shared by every AI Ops list/card page.
// Click an element (server, incident, prompt, log, job, model, guardrail…) →
// the sheet slides in with the full record. The left edge is a drag handle so
// the panel can be widened at will (width persists across sessions;
// double-click resets it). Escape or the backdrop closes it.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const W_KEY = "aiops.detail.width";
const W_DEFAULT = 440;
const W_MIN = 360;
const wMax = () => Math.min(980, Math.round(window.innerWidth * 0.9));

export function DetailSheet({ onClose, title, subtitle, icon, actions, children }: {
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  /** Optional header actions (e.g. an "Éditer" button). */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [width, setWidth] = useState<number>(() => {
    try { const v = Number(localStorage.getItem(W_KEY)); if (v >= W_MIN) return v; } catch { /* ignore */ }
    return W_DEFAULT;
  });
  const dragging = useRef(false);

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const persist = (w: number) => { try { localStorage.setItem(W_KEY, String(w)); } catch { /* ignore */ } };

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const w = Math.min(wMax(), Math.max(W_MIN, Math.round(window.innerWidth - e.clientX)));
    setWidth(w);
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    setWidth((w) => { persist(w); return w; });
  }, []);

  // Portal to <body>: escapes any ancestor that creates a containing block
  // (transform/filter/overflow in the app shell), so inset-y-0 really means
  // the full viewport height, topbar included.
  return createPortal(
    <>
      {/* Backdrop */}
      <button
        aria-label="Fermer le panneau"
        onClick={onClose}
        className="fixed inset-0 z-[59] bg-black/35 backdrop-blur-[1px] animate-in fade-in duration-150"
      />
      {/* Panel */}
      <aside
        role="dialog" aria-label={title}
        className="fixed inset-y-0 right-0 z-[60] flex flex-col border-l border-border bg-background shadow-2xl animate-in slide-in-from-right duration-200"
        style={{ width: `min(${width}px, 94vw)` }}
      >
        {/* Drag handle — widen at will; double-click to reset. */}
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={() => { setWidth(W_DEFAULT); persist(W_DEFAULT); }}
          title="Glisser pour élargir · double-clic pour réinitialiser"
          className="group absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none"
        >
          <div className="mx-auto h-full w-px bg-border transition-colors group-hover:w-0.5 group-hover:bg-[hsl(var(--accent-teal))]" />
        </div>

        {/* Header */}
        <div className="flex items-start gap-3 border-b border-border px-5 py-4 pl-6">
          {icon}
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold tracking-tight">{title}</div>
            {subtitle && <div className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</div>}
          </div>
          {actions}
          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={onClose} aria-label="Fermer">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="scrollbar-slim flex-1 overflow-y-auto px-5 py-4 pl-6">
          {children}
        </div>
      </aside>
    </>,
    document.body,
  );
}

// ── Small layout helpers shared by the detail views ──────────────────────────
export function DetailSection({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("mb-5", className)}>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/50 py-2 text-sm last:border-0">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-[13px]">{children}</span>
    </div>
  );
}
