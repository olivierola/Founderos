import type { ReactNode } from "react";
import {
  ArrowRightIcon, CheckIcon, CircleNotchIcon as Loader2, type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Le kit visuel des onglets d'un agent public.
 *
 * Il reprend la grammaire du tableau de bord d'un collaborateur interne
 * (AgentHome) : des cartes plates `rounded-2xl border bg-card`, un en-tête de
 * carte à 17 px, des indicateurs à gros chiffre, des pastilles d'icône rondes.
 * Une seule teinte pour les grandeurs (le violet de l'app) ; le vert, l'ambre
 * et le rouge ne disent que l'état.
 */

/** Le conteneur d'un onglet : la même largeur et les mêmes marges partout. */
export function PaPage({ children, className, width = "wide" }: {
  children: ReactNode; className?: string; width?: "wide" | "narrow" | "full";
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full space-y-5 pb-6",
        width === "wide" && "max-w-[1480px]",
        width === "narrow" && "max-w-[920px]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Le titre d'un onglet, à gauche ; ses actions à droite. */
export function PaHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-1 text-[13px] text-muted-foreground">{sub}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Une carte de réglages ou de données, avec son en-tête. */
export function PaCard({ title, sub, icon: Icon, actions, children, className, bodyClassName, live }: {
  title?: string;
  sub?: ReactNode;
  icon?: PhosphorIcon;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  live?: boolean;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col rounded-2xl border border-border bg-card", className)}>
      {(title || actions) && (
        <div className="flex items-start gap-3 px-5 pt-5">
          {Icon && (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
              <Icon className="h-4 w-4" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>}
            {sub && (
              <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />}
                {sub}
              </div>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("min-w-0 flex-1 px-5 pb-5", title || actions ? "pt-4" : "pt-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Un indicateur : l'icône ronde, le libellé, le gros chiffre, un sous-texte et une jauge. */
export function PaKpi({ icon: Icon, label, value, sub, meter, action }: {
  icon: PhosphorIcon;
  label: string;
  value: string;
  sub?: string;
  meter?: { label: string; pct: number; tone?: "accent" | "warn" | "ok" };
  action?: { label: string; onClick: () => void };
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <span className="truncate text-[13px] text-muted-foreground">{label}</span>
      </div>
      <div className="mt-4 whitespace-nowrap text-[30px] font-semibold leading-none tracking-tight">{value}</div>
      {sub && <div className="mt-1.5 truncate text-[12px] text-muted-foreground">{sub}</div>}
      {(meter || action) && (
        <div className="mt-auto pt-4">
          {meter ? (
            <>
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <span className="min-w-0 truncate font-medium">{meter.label}</span>
                <span className="shrink-0 font-medium tabular-nums">{meter.pct} %</span>
              </div>
              <div className={cn(
                "mt-1.5 h-2 overflow-hidden rounded-full",
                meter.tone === "warn" ? "bg-amber-500/15" : meter.tone === "ok" ? "bg-emerald-500/15" : "bg-primary/15",
              )}>
                <div
                  className={cn("h-full rounded-full", meter.tone === "warn" ? "bg-amber-500" : meter.tone === "ok" ? "bg-emerald-500" : "bg-primary")}
                  style={{ width: `${Math.max(meter.pct > 0 ? 3 : 0, Math.min(100, meter.pct))}%` }}
                />
              </div>
            </>
          ) : action ? (
            <button onClick={action.onClick} className="flex items-center gap-1 text-[12px] font-medium text-primary hover:underline">
              {action.label} <ArrowRightIcon className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** La grille des indicateurs : autant de colonnes que la largeur en permet. */
export function PaKpiGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))]">{children}</div>;
}

/** Un sélecteur à pastilles, la forme des onglets de tâches d'AgentHome. */
export function PaSegmented<T extends string>({ value, options, onChange, className }: {
  value: T; options: { value: T; label: string; icon?: PhosphorIcon }[]; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div className={cn("inline-flex flex-wrap gap-1 rounded-full bg-muted/70 p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] transition-colors",
            value === o.value ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.icon && <o.icon className="h-3.5 w-3.5" />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Une ligne « libellé à gauche, contrôle à droite » dans une carte de réglages. */
export function PaRow({ label, hint, children, stacked }: {
  label: string; hint?: string; children: ReactNode; stacked?: boolean;
}) {
  return (
    <div className={cn("grid items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0", stacked ? "grid-cols-1" : "sm:grid-cols-[180px_minmax(0,1fr)]")}>
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Les lignes d'une carte, séparées par un filet. */
export function PaRows({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border/60">{children}</div>;
}

/**
 * La barre d'enregistrement : une pastille collée en bas de la colonne, qui
 * n'apparaît que lorsqu'il y a quelque chose à enregistrer.
 */
export function PaSaveBar({ dirty, saving, saved, onSave, onReset, savedLabel = "Enregistré" }: {
  dirty: boolean; saving: boolean; saved: boolean;
  onSave: () => void; onReset?: () => void; savedLabel?: string;
}) {
  const shown = dirty || saving || saved;
  return (
    <div className="pointer-events-none sticky bottom-4 z-20 mt-6 flex justify-center">
      <div
        className={cn(
          "flex items-center gap-2 rounded-full border border-border bg-card py-1.5 pl-4 pr-1.5 shadow-lg transition-all duration-300",
          shown ? "pointer-events-auto translate-y-0 opacity-100" : "translate-y-3 opacity-0",
        )}
        aria-hidden={!shown}
      >
        {dirty || saving ? (
          <>
            <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Modifications non enregistrées
            </span>
            {onReset && (
              <Button variant="ghost" size="sm" className="rounded-full" onClick={onReset} disabled={saving}>
                Annuler
              </Button>
            )}
            <Button size="sm" onClick={onSave} disabled={saving} className="rounded-full">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckIcon className="h-4 w-4" />}
              Enregistrer
            </Button>
          </>
        ) : (
          <span className="flex items-center gap-2 py-1.5 pr-3 text-[12px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckIcon className="h-3.5 w-3.5" weight="bold" /> {savedLabel}
          </span>
        )}
      </div>
    </div>
  );
}

/** Un encart d'information ou d'alerte, plat. */
export function PaNotice({ tone = "info", title, children }: { tone?: "info" | "warn" | "error"; title?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-4 text-[13px] leading-relaxed",
        tone === "info" && "border-border bg-muted/40 text-muted-foreground",
        tone === "warn" && "border-amber-500/30 bg-amber-500/[0.07]",
        tone === "error" && "border-red-500/30 bg-red-500/[0.07] text-red-700 dark:text-red-400",
      )}
    >
      {title && <div className={cn("mb-1 font-medium", tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-foreground")}>{title}</div>}
      <div className={tone === "warn" ? "text-muted-foreground" : undefined}>{children}</div>
    </div>
  );
}

/** Une pastille d'état en capitales mono, comme les statuts de runs. */
export function PaStatus({ tone, children }: { tone: "ok" | "warn" | "error" | "idle" | "live"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "status-mono inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide",
        tone === "ok" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        tone === "live" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        tone === "error" && "bg-red-500/10 text-red-700 dark:text-red-400",
        tone === "idle" && "bg-muted text-muted-foreground",
      )}
    >
      {tone === "live" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function fmtBytes(n: number) {
  if (!n) return "0 o";
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(".", ",")} Ko`;
  return `${(n / 1024 / 1024).toFixed(2).replace(".", ",")} Mo`;
}

export const nf = (n: number) => n.toLocaleString("fr-FR");
