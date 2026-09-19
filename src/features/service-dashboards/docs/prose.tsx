import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Les briques de texte de la documentation.
 *
 * Elles existent pour que quarante articles écrits à la suite gardent la même
 * mesure. Sans elles, chaque article règle ses propres marges et ses propres
 * tailles, et l'ensemble se lit comme quarante documents empruntés à quarante
 * endroits — exactement le défaut que le module de suivi avait avec ses huit
 * modales.
 *
 * La largeur de ligne est bornée à 68 caractères environ. C'est une contrainte
 * de lecture, pas d'esthétique : au-delà, l'œil rate le retour à la ligne
 * suivante et relit deux fois la même phrase.
 */

export function P({ children }: { children: ReactNode }) {
  return (
    <p className="my-3 text-14 leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
      {children}
    </p>
  );
}

/** Le chapeau d'un article : une phrase qui dit à quoi sert l'écran. */
export function Lede({ children }: { children: ReactNode }) {
  return (
    <p className="mb-5 text-16 leading-relaxed text-foreground/85">{children}</p>
  );
}

export function H({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3 id={id} className="mb-2 mt-8 scroll-mt-6 text-16 font-medium first:mt-0">
      {children}
    </h3>
  );
}

export function UL({ children }: { children: ReactNode }) {
  return <ul className="my-3 space-y-1.5">{children}</ul>;
}

export function LI({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2 text-14 leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
      <span aria-hidden className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-foreground/30" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/**
 * Un tableau de correspondance (un terme, ce qu'il veut dire).
 *
 * Deux colonnes et pas trois : dès qu'une troisième apparaît, le tableau
 * devient une grille de spécifications qu'on ne lit plus, et l'information
 * qu'il portait aurait mieux tenu en phrases.
 */
export function Defs({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="my-4 overflow-hidden rounded-lg border border-border">
      {rows.map(([term, def], i) => (
        <div
          key={i}
          className={cn(
            "flex flex-col gap-0.5 px-3 py-2.5 sm:flex-row sm:gap-4",
            i > 0 && "border-t border-border/60",
          )}
        >
          <dt className="shrink-0 text-13 font-medium sm:w-44">{term}</dt>
          <dd className="min-w-0 text-13 leading-relaxed text-muted-foreground">{def}</dd>
        </div>
      ))}
    </dl>
  );
}
