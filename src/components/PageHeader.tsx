import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Le gabarit commun des pages : les mêmes marges latérales, le même titre et
 * le même sous-titre partout (référence : l'onglet Machines). Une page qui a
 * besoin d'un en-tête sur mesure reprend ces classes plutôt que les siennes.
 */
export const PAGE_PAD = "w-full px-5 py-7 md:px-6";
/** Les seules marges latérales, pour une barre d'onglets ou un en-tête collé en haut. */
export const PAGE_PAD_X = "px-5 md:px-6";
export const PAGE_TITLE = "text-[22px] font-semibold tracking-tight";
export const PAGE_SUB = "mt-1 text-[13px] text-muted-foreground";

/** Le conteneur d'une page : marges latérales et verticales communes. */
export function PageShell({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(PAGE_PAD, className)}>{children}</div>;
}

interface PageHeaderProps {
  title: ReactNode;
  /** Optional ending set in the serif italic, as on the site ("Agents" + "at work"). */
  accent?: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Avant le titre : un bouton retour, une icône. */
  leading?: ReactNode;
  className?: string;
}

export function PageHeader({ title, accent, description, actions, leading, className }: PageHeaderProps) {
  return (
    <header className={cn("mb-6 flex flex-wrap items-start gap-4", className)}>
      {leading && <div className="flex shrink-0 items-center pt-0.5">{leading}</div>}
      <div className="min-w-0 flex-1">
        <h1 className={PAGE_TITLE}>
          {title}
          {accent && <span className="serif-accent ml-2">{accent}</span>}
        </h1>
        {description && <p className={cn(PAGE_SUB, "max-w-[72ch]")}>{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
