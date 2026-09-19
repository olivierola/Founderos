import { WrenchIcon, LightningIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { BrandLogo } from "@/components/BrandLogo";
import type { ToolNeed } from "./useToolkits";
import { cn } from "@/lib/utils";

/**
 * Catalogue card — the shape used for both the agent roster and the template
 * gallery: a large centred glyph on its own plate, a rule, then the name, two
 * count metrics, capability pills and a right-aligned mono meta string.
 */
export interface CatalogBadge {
  label: string;
  /** "auth" = indigo pill, "key" = emerald pill (the two tints of the design). */
  tone?: "auth" | "key";
  title?: string;
}

export function CatalogCard({
  glyph, name, tools, extras, badges, shield, meta, overlay, action, tools_needed, onClick, disabled, className,
}: {
  glyph: React.ReactNode;
  name: string;
  /** Wrench count — tools. `null` renders the em dash of the design. */
  tools: number | null;
  /** Bolt count — skills / triggers. */
  extras: number | null;
  badges?: CatalogBadge[];
  /** Small shield after the pills (approval required). */
  shield?: boolean;
  /** Mono text on the right of the pill row. */
  meta?: string;
  /** Revealed over the glyph plate on hover (e.g. an "Add agent" affordance). */
  overlay?: React.ReactNode;
  /** Apps this agent/template depends on, connected or not. */
  tools_needed?: ToolNeed[];
  /** Corner control (menu, …). Rendered OUTSIDE the button — nesting one
   *  interactive element inside another is invalid and breaks click handling. */
  action?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    // h-full + a stretched grid item: every card in a row matches the tallest,
    // and the pill row is pinned to the bottom, so an optional logo strip can
    // no longer make one card shorter than its neighbours.
    <div className={cn("group relative h-full", className)}>
      {action && (
        <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {action}
        </div>
      )}
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-xl border border-border/70 bg-card/30 text-left transition-colors",
        "hover:border-border hover:bg-card/60 disabled:opacity-60",
      )}
    >
      <div className="relative flex h-[112px] shrink-0 items-center justify-center bg-[hsl(var(--catalog-stage))]">
        {glyph}
        {overlay && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 backdrop-blur-[1px] transition-opacity group-hover:opacity-100">
            {overlay}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col border-t border-border/70 px-3.5 py-3">
        <div className="truncate text-[15px] font-semibold">{name}</div>

        <div className="mt-1.5 flex items-center gap-3.5 text-[12px] text-muted-foreground">
          <span className="flex items-center gap-1" title="Outils">
            <WrenchIcon className="h-3 w-3" /> {tools === null || tools === 0 ? "–" : tools}
          </span>
          <span className="flex items-center gap-1" title="Skills">
            <LightningIcon className="h-3 w-3" /> {extras === null || extras === 0 ? "–" : extras}
          </span>
        </div>

        {/* Apps the agent runs on. A dimmed logo with a dashed ring means the
            toolkit still has to be connected for the agent to work. */}
        {tools_needed && tools_needed.length > 0 && (
          <div className="mt-2.5 flex items-center gap-1">
            {tools_needed.slice(0, 5).map((t) => (
              <span
                key={t.slug}
                title={t.connected ? `${t.name} · connecté` : `${t.name} · à connecter`}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-md border",
                  t.connected ? "border-transparent bg-muted" : "border-dashed border-muted-foreground/40 opacity-50",
                )}
              >
                {t.logo
                  ? <img src={t.logo} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" loading="lazy" />
                  : <BrandLogo slug={t.slug} className="h-3.5 w-3.5" />}
              </span>
            ))}
            {tools_needed.length > 5 && (
              <span className="text-[11px] text-muted-foreground">+{tools_needed.length - 5}</span>
            )}
          </div>
        )}

        <div className="mt-auto flex items-center gap-1.5 pt-2.5">
          {(badges ?? []).map((b) => (
            <span
              key={b.label} title={b.title ?? b.label}
              className={cn(
                "max-w-[92px] truncate rounded-md px-1.5 py-0.5 font-mono text-[11px]",
                b.tone === "key"
                  ? "bg-emerald-500/12 text-emerald-500"
                  : "bg-indigo-500/12 text-indigo-400",
              )}
            >
              {b.label}
            </span>
          ))}
          {shield && <ShieldCheckIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          {meta && <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/70">{meta}</span>}
        </div>
      </div>
    </button>
    </div>
  );
}
