import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Form controls for the agent configuration surfaces: soft, rounded, flush.
 *
 * Deliberately NOT the shared shadcn Input/Textarea/Select — those wear a hard
 * 1px border and the OS's own <select>, which reads as a database form. These
 * sit on a tinted surface with no border until they are focused, and the select
 * is a real popover so the option list is ours (rounded, checked, themed) in
 * every browser.
 *
 * A label is the only text a field gets. Anything that would be a paragraph of
 * explanation under a control belongs in the docs, not next to a text box.
 */

/** The shared field surface: tinted, borderless at rest, ringed on focus. */
const FIELD = "w-full rounded-xl bg-muted/50 px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:bg-background focus:ring-2 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50";

export function SoftField({ label, htmlFor, children, className }: {
  label?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {label && <label htmlFor={htmlFor} className="block text-xs font-medium text-muted-foreground">{label}</label>}
      {children}
    </div>
  );
}

export function SoftInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(FIELD, className)} />;
}

export function SoftTextarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(FIELD, "resize-y leading-relaxed", className)} />;
}

export interface SoftOption<T extends string> { value: T; label: string; hint?: string }

/** Popover select — our own list, not the browser's. */
export function SoftSelect<T extends string>({
  value, options, onChange, disabled, placeholder = "Choisir…", className, align = "start",
}: {
  value: T | "";
  options: SoftOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={box} className={cn("relative", className)}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(FIELD, "flex items-center gap-2 text-left", open && "bg-background ring-2 ring-primary/30")}
      >
        <span className={cn("min-w-0 flex-1 truncate", !current && "text-muted-foreground/60")}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="listbox"
          className={cn(
            "absolute z-50 mt-1.5 max-h-72 w-full min-w-[12rem] overflow-y-auto rounded-2xl border border-border/70 bg-popover p-1.5 shadow-xl",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {options.map((o) => {
            const on = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => { onChange(o.value); setOpen(false); }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors",
                  on ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {o.hint && <span className="block truncate text-[11px] text-muted-foreground">{o.hint}</span>}
                </span>
                {on && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Pill switch. `label` is the whole row; no description line by design. */
export function SoftToggle({ label, icon: Icon, checked, onChange, disabled }: {
  label: string;
  icon?: any;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-2.5 rounded-xl bg-muted/50 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-primary" : "bg-border")}>
        <span className={cn(
          "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
          checked && "translate-x-4",
        )} />
      </span>
    </button>
  );
}

/** Range with a rounded track and a soft thumb — the native widget, unrecognisable. */
export function SoftRange({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="range" {...props} className={cn("soft-range w-full", className)} />;
}

/** Tag input: chips + a borderless entry, on the same soft surface. */
export function SoftTags({ values, onChange, placeholder = "Ajouter…", disabled }: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-muted/50 px-2.5 py-2 focus-within:bg-background focus-within:ring-2 focus-within:ring-primary/30">
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-full bg-background px-2.5 py-1 text-xs shadow-sm">
          {v}
          {!disabled && (
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} className="text-muted-foreground transition-colors hover:text-foreground">×</button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const v = draft.trim().toLowerCase();
            if (v && !values.includes(v)) onChange([...values, v]);
            setDraft("");
          }}
          placeholder={placeholder}
          className="min-w-[90px] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground/60"
        />
      )}
    </div>
  );
}

/** Selectable card — the option-as-a-tile pattern (runtime, preset…). */
export function SoftCardOption({ active, icon: Icon, title, hint, onClick, disabled }: {
  active: boolean;
  icon?: any;
  title: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-2xl p-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        active ? "bg-primary/10 ring-2 ring-primary/40" : "bg-muted/50 hover:bg-muted",
      )}
    >
      <div className="flex items-center gap-2">
        {Icon && <Icon className={cn("h-4 w-4", active ? "text-primary" : "text-muted-foreground")} />}
        <span className="text-sm font-medium">{title}</span>
      </div>
      {hint && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </button>
  );
}

/**
 * Colour field — a swatch that opens the picker plus an editable hex.
 *
 * The native <input type="color"> is a raw OS widget: a different shape and a
 * different chrome on every platform, and it cannot be typed into. Here the
 * native input is kept for the picker it opens but made invisible and stretched
 * under the swatch, so the control we show is entirely ours.
 */
export function SoftColor({ value, onChange, disabled, className }: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const safe = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-xl bg-muted/50 px-3 py-2 transition-colors",
        "focus-within:bg-background focus-within:ring-2 focus-within:ring-primary/30",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <span className="relative h-5 w-5 shrink-0 overflow-hidden rounded-full ring-1 ring-inset ring-border">
        <span className="absolute inset-0" style={{ background: safe }} />
        <input
          type="color"
          value={safe}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Choisir une couleur"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </span>
      <input
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="w-full bg-transparent font-mono text-sm uppercase outline-none disabled:cursor-not-allowed"
      />
    </div>
  );
}

/**
 * Number field with a unit suffix and our own steppers — the native spin
 * buttons only appear on hover, sit outside the rounded surface, and are
 * unusable on touch.
 */
export function SoftNumber({ value, onChange, unit, min, max, step = 1, disabled, className }: {
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
}) {
  const clamp = (n: number) => Math.min(Math.max(n, min ?? -Infinity), max ?? Infinity);
  const bump = (d: number) => onChange(clamp((Number(value) || 0) + d * step));
  return (
    <div
      className={cn(
        "flex items-center rounded-xl bg-muted/50 pr-1.5 transition-colors",
        "focus-within:bg-background focus-within:ring-2 focus-within:ring-primary/30",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className="w-full bg-transparent px-3.5 py-2.5 text-sm outline-none [appearance:textfield] disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      {unit && <span className="shrink-0 pr-1.5 text-xs text-muted-foreground">{unit}</span>}
      <span className="flex shrink-0 flex-col">
        {([1, -1] as const).map((d) => (
          <button
            key={d}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onClick={() => bump(d)}
            aria-label={d > 0 ? "Augmenter" : "Diminuer"}
            className="flex h-[15px] w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed"
          >
            <ChevronDown className={cn("h-3 w-3", d > 0 && "rotate-180")} />
          </button>
        ))}
      </span>
    </div>
  );
}

/**
 * Checkbox — a real button with role="checkbox" rather than the OS control,
 * whose only styling hook is `accent-color`.
 */
export function SoftCheckbox({ checked, onChange, label, hint, disabled, className }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl px-1 py-0.5 text-left transition-colors",
        "hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted/60",
        )}
      >
        {checked && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      {(label || hint) && (
        <span className="min-w-0 flex-1">
          {label && <span className="block text-sm leading-tight">{label}</span>}
          {hint && <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{hint}</span>}
        </span>
      )}
    </button>
  );
}

/**
 * Chat composer input — the rounded pill used inside agent chat panels. Same
 * family as the fields above, but fully round and flush against a send button.
 */
export function SoftComposerInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "h-9 w-full min-w-0 rounded-full bg-muted/60 px-4 text-sm text-foreground outline-none transition-colors",
        "placeholder:text-muted-foreground/60 focus:bg-background focus:ring-2 focus:ring-primary/30",
        className,
      )}
    />
  );
}
