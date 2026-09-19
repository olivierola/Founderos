import { type ReactNode } from "react";
import { motion } from "framer-motion";
import { InfoIcon as Info } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { TrendBadge } from "@/features/dashboard/hq/primitives";
import { useContextGreys } from "@/features/crm/overview/vizPalette";

// Briques communes aux pages Performance et Audience.
//
// Règle tenue partout ici : la couleur est dans la marque, jamais dans le
// texte — un chiffre reste en encre de texte, une pastille colorée à côté porte
// l'identité. Et toute barre segmentée est doublée d'une ligne de libellés
// chiffrés : plusieurs des teintes utilisées passent sous 3:1 sur fond clair,
// et le libellé direct est la compensation exigée par la validation.

export function InfoLabel({ children, hint }: { children: ReactNode; hint: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {children}
      <Info className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden />
      <span className="sr-only">{hint}</span>
    </span>
  );
}

/**
 * Le grand taux d'une page : un titre, la phrase qui dit d'où sort le chiffre,
 * la valeur, son écart en points, et une barre part/total.
 *
 * La phrase n'est pas décorative : « 55 % » ne veut rien dire sans son
 * numérateur et son dénominateur, et c'est exactement là que les tableaux de
 * bord d'agents deviennent malhonnêtes.
 */
export function RateCard({
  title, hint, sentence, value, delta, part, total, color, right, footer, className,
}: {
  title: string;
  hint: string;
  sentence: ReactNode;
  value: number | null;
  delta?: number | null;
  part: number;
  total: number;
  color: string;
  right?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const greys = useContextGreys();
  const width = total > 0 ? Math.min(100, (part / total) * 100) : 0;
  return (
    <Card className={cn("flex flex-col gap-3 rounded-2xl border-border/70 bg-card p-5 shadow-sm", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold" title={hint}>
            <InfoLabel hint={hint}>{title}</InfoLabel>
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{sentence}</p>
        </div>
        {right}
      </div>

      <div className="flex items-baseline gap-2">
        <span className="font-stat-number text-3xl font-semibold tabular-nums">
          {value == null ? "—" : `${value}%`}
        </span>
        {delta !== undefined && <TrendBadge value={delta ?? null} good="up" suffix=" pts" />}
      </div>

      {/* Barre part/total : la part porte la couleur, le reste est le gris de
          contexte du système — jamais une seconde teinte, qui ferait croire à
          une seconde catégorie. */}
      <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: greys.empty }}>
        <motion.div
          className="h-full rounded-full"
          style={{ background: color }}
          initial={{ width: 0 }}
          animate={{ width: `${width}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
      </div>
      {footer}
    </Card>
  );
}

export interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
  hint?: string;
}

/**
 * Barre de distribution + libellés directs.
 *
 * Les segments sont séparés par 2 px de surface (jamais un trait) et les bouts
 * de la barre sont arrondis : c'est la spec de marque du système, et c'est ce
 * qui rend deux segments voisins lisibles même quand leurs teintes sont
 * proches.
 */
export function SegmentedBar({
  segments, total, height = 10, columns = 2, showZero = false, emptyLabel = "Aucune donnée sur la période.",
}: {
  segments: Segment[];
  total?: number;
  height?: number;
  columns?: 1 | 2 | 3;
  showZero?: boolean;
  emptyLabel?: string;
}) {
  const sum = total ?? segments.reduce((s, x) => s + x.value, 0);
  const shown = segments.filter((s) => showZero || s.value > 0);
  if (!sum || shown.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center rounded-xl border border-dashed border-border px-4 text-center text-xs text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div>
      <div className="flex w-full items-stretch gap-[2px] overflow-hidden rounded-full" style={{ height }}>
        {shown.map((s) => (
          <motion.span
            key={s.key}
            className="first:rounded-l-full last:rounded-r-full"
            style={{ background: s.color, flexGrow: s.value, flexBasis: 0, minWidth: 3 }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }}
            title={`${s.label} : ${s.value}`}
          />
        ))}
      </div>
      <ul className={cn(
        "mt-3 grid gap-x-4 gap-y-1.5 text-[11px]",
        columns === 1 ? "grid-cols-1" : columns === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-2",
      )}>
        {shown.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5" title={s.hint}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.label}</span>
            <span className="shrink-0 font-medium tabular-nums text-foreground">{s.value}</span>
            <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">
              {Math.round((s.value / sum) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Bandeau d'avertissement quand une partie du volume n'est pas mesurée. */
export function CoverageNote({ measuredCount, total }: { measuredCount: number; total: number }) {
  const missing = total - measuredCount;
  if (missing <= 0) return null;
  return (
    <p className="rounded-xl bg-muted/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
      {missing.toLocaleString("fr-FR")} conversation{missing > 1 ? "s" : ""} sur {total.toLocaleString("fr-FR")} sont
      antérieures à la mise en place des compteurs d'issue : elles sont exclues des taux ci-dessus plutôt que comptées
      comme des échecs.
    </p>
  );
}
