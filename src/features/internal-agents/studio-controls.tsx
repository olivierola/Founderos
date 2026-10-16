import { useEffect, useState } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { SoftColor, SoftRange } from "@/components/ui/soft-form";
import type { NumberSpec } from "@/lib/bot-avatar-look";
import { AgentIdentity } from "@/components/AgentIdentity";

// The small controls the avatar studio is made of — shared by its robot and
// its human halves (AvatarPicker.tsx, HumanAvatarControls.tsx).

export const HEX6 = /^#[0-9a-f]{6}$/i;
export const sameColour = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

export function Section({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      {children}
      {hint && <p className="mt-1.5 text-[11px] text-muted-foreground">{hint}</p>}
    </section>
  );
}

export function Chips<T extends string | number>({ options, value, onChange, size = "md" }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className={cn("flex flex-wrap", size === "sm" ? "justify-center gap-1" : "gap-1.5")}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-full transition-colors",
            size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-[11px]",
            o.value === value
              ? "bg-foreground font-medium text-background"
              : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Swatch({ colour, active, onClick, title }: { colour: string; active: boolean; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      title={title ?? colour}
      aria-label={title ?? colour}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-6 w-6 shrink-0 rounded-full ring-1 ring-inset ring-black/10 transition-transform hover:scale-110",
        active && "outline outline-2 outline-offset-2 outline-primary",
      )}
      style={{ background: colour }}
    />
  );
}

const RAINBOW = "conic-gradient(from 0deg, #ff5c5c, #ffc94d, #2fcb7a, #41c4ff, #9a62ff, #ff5c8a, #ff5c5c)";

/**
 * A row of colours: the automatic one first (marked « A »), the palette, and a
 * last, rainbow swatch that opens the system picker for any other colour — it
 * then wears the colour picked.
 */
export function SwatchRow({ auto, value, palette, onChange, autoTitle = "Auto — d'après le nom" }: {
  /** The colour the automatic swatch shows. */
  auto: string;
  /** The chosen colour; undefined is the automatic one. */
  value: string | undefined;
  palette: (string | { value: string; label: string })[];
  onChange: (colour: string | undefined) => void;
  autoTitle?: string;
}) {
  const entries = palette.map((p) => (typeof p === "string" ? { value: p, label: p } : p));
  const custom = value && !entries.some((e) => sameColour(value, e.value)) ? value : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        title={autoTitle}
        aria-label={autoTitle}
        aria-pressed={!value}
        onClick={() => onChange(undefined)}
        className={cn(
          "relative h-7 w-7 shrink-0 rounded-full ring-1 ring-inset ring-black/10 transition-transform hover:scale-110",
          !value && "outline outline-2 outline-offset-2 outline-primary",
        )}
        style={{ background: auto }}
      >
        <span className="absolute -bottom-1 -right-1 rounded-full bg-foreground px-1 text-[8px] font-bold leading-[12px] text-background">A</span>
      </button>
      <span className="mx-0.5 h-5 w-px bg-border" />
      {entries.map((e) => (
        <Swatch key={e.value} colour={e.value} title={e.label} active={sameColour(value, e.value)} onClick={() => onChange(e.value)} />
      ))}
      <label
        title="Autre couleur"
        className={cn(
          "relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-full ring-1 ring-inset ring-black/10 transition-transform hover:scale-110",
          custom && "outline outline-2 outline-offset-2 outline-primary",
        )}
        style={{ background: custom ?? RAINBOW }}
      >
        <input
          type="color"
          value={HEX6.test(value ?? "") ? value : HEX6.test(auto) ? auto : "#000000"}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          aria-label="Autre couleur"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

/** One choice of a tile grid: what it is called and the avatar that shows it. */
export interface TileOption<T extends string> {
  value: T;
  label: string;
  /** The avatar value drawn on the tile — the current look with this choice. */
  url: string;
  title?: string;
}

/**
 * Choices shown rather than named: each tile draws the avatar wearing it.
 * Tiles are paused and not interactive, so a grid of them is drawn once per
 * change, not animated.
 */
export function OptionTiles<T extends string>({ options, value, onChange, seed, size = 48, framing }: {
  options: TileOption<T>[];
  value: T;
  onChange: (v: T) => void;
  /** The agent's name, so the tiles show this agent. */
  seed: string;
  size?: number;
  framing?: "head" | "bust";
}) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size + 18}px, 1fr))` }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            title={o.title ?? o.label}
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex min-w-0 flex-col items-center gap-1 rounded-xl border px-1 pb-1.5 pt-2 transition-colors",
              active ? "border-primary bg-primary/5 ring-2 ring-primary/40" : "border-border hover:border-primary/50 hover:bg-muted/40",
            )}
          >
            <AgentIdentity url={o.url} seed={seed} size={size} interactive={false} paused framing={framing} />
            <span className={cn("line-clamp-2 min-h-[2.2em] w-full text-center text-[10px] leading-tight", active ? "font-medium text-foreground" : "text-muted-foreground")}>
              {o.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A hex field that lets a half-typed value sit until it is a colour. */
export function ColourField({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <SoftColor
      value={draft}
      onChange={(v) => {
        setDraft(v);
        if (HEX6.test(v)) onChange(v.toLowerCase());
      }}
      className="mt-2 max-w-[220px]"
    />
  );
}

/** What a slider needs to know of its setting — a NumberSpec fits. */
export type SliderSpec = Pick<NumberSpec, "label" | "min" | "max" | "step" | "unit" | "zero">;

export function LookSlider({ spec, value, def, onChange }: {
  spec: SliderSpec;
  value: number | undefined;
  /** What the library draws when unset; null when it decides by itself. */
  def: number | null;
  onChange: (v: number | undefined) => void;
}) {
  const at = value ?? def ?? (spec.min + spec.max) / 2;
  const fmt = (n: number) => (spec.step >= 1 ? String(Math.round(n)) : n.toFixed(2));
  const reading = value === undefined && def === null ? "auto" : at === 0 && spec.zero ? spec.zero : `${fmt(at)}${spec.unit ?? ""}`;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-muted-foreground">{spec.label}</span>
        <span className="flex shrink-0 items-center gap-1 tabular-nums">
          <span className={value === undefined ? "text-muted-foreground/70" : "font-medium"}>{reading}</span>
          {value !== undefined && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              title="Revenir à la valeur par défaut"
              className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowCounterClockwise className="h-3 w-3" />
            </button>
          )}
        </span>
      </div>
      <SoftRange
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={at}
        aria-label={spec.label}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
    </div>
  );
}
