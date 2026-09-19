import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckIcon as Check,
  CaretDownIcon as ChevronDown,
  MinusIcon as Minus,
  PlusIcon as Plus,
  MagnifyingGlassIcon as Search,
} from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// The inspector's own field kit.
//
// Every control here used to be a bare `<select>` / `<textarea>`. Native form
// controls are the one part of an interface you cannot design: the select
// paints an OS menu that ignores the theme entirely, its options can carry no
// description, and a textarea with a fixed `rows` either wastes half the panel
// or hides the end of what is being written. In a panel whose whole job is to
// make a procedure readable, that is not a detail.
//
// So: a small, deliberately plain set of controls that all share the same
// shell, run on theme tokens, and pick their SHAPE from the decision being made
// — a segmented control for three options you want to compare at a glance, a
// searchable dropdown for thirty agents, a switch for a yes/no. Choosing the
// right shape is most of what makes a config panel feel considered.

// ── Shell ────────────────────────────────────────────────────────────────────

export function Field({ label, hint, action, children }: {
  label: string;
  hint?: ReactNode;
  /** Small control on the label line — a "clear", a counter, an "add". */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex min-h-[18px] items-center justify-between gap-2">
        <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</label>
        {action}
      </div>
      {children}
      {hint && <p className="text-[10.5px] leading-snug text-muted-foreground/75">{hint}</p>}
    </div>
  );
}

/** The one surface every control stands on, so a panel of six different
 *  controls still reads as one form. */
const SHELL =
  "rounded-lg border border-border/70 bg-muted/30 transition-colors focus-within:border-primary/50 focus-within:bg-background hover:border-border";

// ── Text ─────────────────────────────────────────────────────────────────────

export function TextField({ value, onChange, placeholder, mono, autoFocus }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className={SHELL}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        className={cn(
          "h-9 w-full bg-transparent px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/50",
          mono && "font-mono text-xs",
        )}
      />
    </div>
  );
}

/**
 * A textarea that grows with what is written, between a floor and a ceiling.
 *
 * Fixed `rows` is the quiet cost of a form-shaped inspector: three lines for a
 * constraint someone wrote in five, ten lines of emptiness for one they wrote
 * in one. Growing costs nothing and removes the scrollbar-inside-a-scrollbar
 * that made long steps unreadable.
 */
export function TextArea({ value, onChange, placeholder, minRows = 3, maxRows = 16 }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minRows?: number;
  maxRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const line = 20;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, minRows * line), maxRows * line)}px`;
  }, [value, minRows, maxRows]);
  return (
    <div className={SHELL}>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="block w-full resize-none bg-transparent px-2.5 py-2 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50"
      />
    </div>
  );
}

// ── Choice ───────────────────────────────────────────────────────────────────

export interface Choice {
  value: string;
  label: string;
  /** One line under the label. What actually makes two similar options tell
   *  themselves apart — and exactly what a native `<option>` cannot carry. */
  hint?: string;
  icon?: ReactNode;
}

/**
 * Two to four options, all visible at once.
 *
 * A dropdown hides the alternatives behind a click, which is wrong when the
 * whole decision is a comparison — "manuel / planifié / événement" is read, not
 * searched. Above four options the row stops being scannable and `Picker` takes
 * over.
 */
export function Segmented({ value, onChange, options, columns }: {
  value: string;
  onChange: (v: string) => void;
  options: Choice[];
  /** Force a grid instead of a row — for options whose labels are long. */
  columns?: number;
}) {
  return (
    <div
      className={cn("gap-1 rounded-lg border border-border/70 bg-muted/30 p-1", columns ? "grid" : "flex")}
      style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
      role="radiogroup"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            title={o.hint}
            className={cn(
              "min-w-0 flex-1 rounded-md px-2 py-1.5 text-[12px] font-medium transition-all",
              on
                ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
            )}
          >
            <span className="flex items-center justify-center gap-1.5">
              {o.icon}
              <span className="truncate">{o.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * One choice out of a long list — agents, collections, tools.
 *
 * Searchable past a dozen entries, and every option may carry its hint, which
 * is the whole reason this exists rather than a `<select>`: picking an agent to
 * delegate to without seeing what it does is picking a name.
 */
export function Picker({ value, onChange, options, placeholder = "Choisir…", emptyLabel }: {
  value: string;
  onChange: (v: string) => void;
  options: Choice[];
  placeholder?: string;
  /** Label of the "no choice" row. Omit to make the field mandatory. */
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => { if (!open) setQ(""); }, [open]);

  const searchable = options.length > 10;
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(needle))
    : options;
  const current = options.find((o) => o.value === value);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(SHELL, "flex h-9 w-full items-center gap-2 px-2.5 text-left")}>
          {current?.icon}
          <span className={cn("min-w-0 flex-1 truncate text-[13px]", current ? "text-foreground" : "text-muted-foreground/60")}>
            {current?.label ?? emptyLabel ?? placeholder}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[22rem] w-[var(--radix-dropdown-menu-trigger-width)] min-w-[15rem] overflow-y-auto rounded-xl p-1">
        {searchable && (
          <div className="sticky top-0 z-10 mb-1 flex items-center gap-1.5 rounded-lg bg-popover px-2 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Filtrer…"
              autoFocus
              className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/50"
            />
          </div>
        )}
        {emptyLabel && !needle && (
          <DropdownMenuItem className="rounded-lg" onSelect={() => onChange("")}>
            <span className="min-w-0 flex-1 text-muted-foreground">{emptyLabel}</span>
            {!value && <Check className="ml-2 h-3.5 w-3.5 text-primary" />}
          </DropdownMenuItem>
        )}
        {shown.map((o) => (
          <DropdownMenuItem key={o.value} className="items-start rounded-lg" onSelect={() => onChange(o.value)}>
            {o.icon && <span className="mt-0.5 shrink-0">{o.icon}</span>}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">{o.label}</span>
              {o.hint && <span className="block truncate text-[11px] text-muted-foreground">{o.hint}</span>}
            </span>
            {o.value === value && <Check className="ml-2 mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />}
          </DropdownMenuItem>
        ))}
        {shown.length === 0 && (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">Aucun résultat.</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Booleans and numbers ─────────────────────────────────────────────────────

export function Switch({ checked, onChange, label, hint }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(SHELL, "flex w-full items-center gap-3 px-2.5 py-2 text-left")}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-foreground">{label}</span>
        {hint && <span className="block text-[10.5px] leading-snug text-muted-foreground">{hint}</span>}
      </span>
      <span
        className={cn(
          "relative h-[18px] w-8 shrink-0 rounded-full transition-colors",
          checked ? "bg-primary" : "bg-muted-foreground/30",
        )}
      >
        <span
          className={cn(
            "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-background shadow transition-all",
            checked ? "left-[16px]" : "left-[2px]",
          )}
        />
      </span>
    </button>
  );
}

/** A bounded number. Typing is still allowed — the buttons are for the common
 *  case of nudging a ceiling by one, not a replacement for the keyboard. */
export function Stepper({ value, onChange, min = 1, max = 999, suffix }: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  const clamp = (n: number) => Math.min(Math.max(Number.isFinite(n) ? n : min, min), max);
  return (
    <div className={cn(SHELL, "flex h-9 items-center")}>
      <button
        type="button" onClick={() => onChange(clamp(value - 1))} disabled={value <= min}
        className="flex h-full w-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
      ><Minus className="h-3.5 w-3.5" /></button>
      <span className="flex min-w-0 flex-1 items-baseline justify-center gap-1">
        <input
          value={String(value)}
          onChange={(e) => onChange(clamp(parseInt(e.target.value.replace(/\D/g, ""), 10)))}
          inputMode="numeric"
          className="w-10 bg-transparent text-center text-[13px] tabular-nums outline-none"
        />
        {suffix && <span className="text-[11px] text-muted-foreground">{suffix}</span>}
      </span>
      <button
        type="button" onClick={() => onChange(clamp(value + 1))} disabled={value >= max}
        className="flex h-full w-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
      ><Plus className="h-3.5 w-3.5" /></button>
    </div>
  );
}

// ── Multi-choice ─────────────────────────────────────────────────────────────

/** Several picks, all visible. Used for the agents of a handoff, where the
 *  count and the order are the information. */
export function ChipPicker({ selected, onChange, options, emptyHint }: {
  selected: string[];
  onChange: (v: string[]) => void;
  options: Choice[];
  emptyHint?: string;
}) {
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  if (options.length === 0) {
    return <p className="rounded-lg border border-dashed border-border/70 px-2.5 py-2 text-[11px] text-muted-foreground">{emptyHint ?? "Rien à choisir."}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = selected.includes(o.value);
        const rank = selected.indexOf(o.value) + 1;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => toggle(o.value)}
            title={o.hint}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px] transition-colors",
              on
                ? "border-primary/50 bg-primary/10 text-foreground"
                : "border-border/70 bg-muted/30 text-muted-foreground hover:text-foreground",
            )}
          >
            {on && <span className="text-[10px] font-semibold tabular-nums text-primary">{rank}</span>}
            <span className="max-w-[10rem] truncate">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A titled group inside the panel — what separates "what this block says" from
 *  "how it is wired". */
export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5 border-t border-border/60 pt-3">
      <div>
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/70">{title}</h4>
        {hint && <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground/75">{hint}</p>}
      </div>
      {children}
    </section>
  );
}
