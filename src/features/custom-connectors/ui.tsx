// Petites briques partagées par les écrans des outils internes.
import type { ReactNode } from "react";
import { XIcon as X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export function Drawer({ title, subtitle, onClose, children, footer, width = "max-w-2xl", actions }: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  actions?: ReactNode;
}) {
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/30" onClick={onClose} />
      <aside className={cn("fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-card shadow-2xl", width)}>
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{title}</h3>
            {subtitle && <div className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Fermer">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <footer className="border-t border-border px-5 py-3">{footer}</footer>}
      </aside>
    </>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block space-y-1.5", className)}>
      <span className="block text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] leading-snug text-muted-foreground">{hint}</span>}
    </label>
  );
}

const TONES = {
  green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  red: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  blue: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  violet: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  muted: "border-border bg-muted text-muted-foreground",
} as const;
export type Tone = keyof typeof TONES;

export function Pill({ tone = "muted", children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = "md" }: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode; hint?: string }>;
  size?: "sm" | "md";
}) {
  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-full border border-border bg-muted/40 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-full transition-colors",
            size === "sm" ? "px-2.5 py-0.5 text-[11px]" : "px-3.5 py-1 text-xs",
            value === o.value ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-secondary/40 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className={cn("mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors", checked ? "bg-primary" : "bg-muted-foreground/30")}>
        <span className={cn("h-3 w-3 rounded-full bg-white shadow transition-transform", checked && "translate-x-3")} />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{hint}</span>}
      </span>
    </button>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</h4>
      {aside}
    </div>
  );
}

export const RISK_META: Record<string, { label: string; tone: Tone; hint: string }> = {
  read: { label: "Lecture", tone: "green", hint: "S'exécute directement." },
  write: { label: "Écriture", tone: "amber", hint: "Peut demander une approbation selon l'autonomie du collaborateur." },
  destructive: { label: "Irréversible", tone: "red", hint: "Attend toujours une approbation humaine." },
};

export const DECISION_META: Record<string, { label: string; tone: Tone }> = {
  allowed: { label: "Autorisé", tone: "green" },
  approved: { label: "Approuvé", tone: "blue" },
  blocked: { label: "Refusé", tone: "amber" },
  error: { label: "Erreur", tone: "red" },
};

export const inputCls =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
export const selectCls = `${inputCls} pr-8`;
export const textareaCls =
  "flex min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
