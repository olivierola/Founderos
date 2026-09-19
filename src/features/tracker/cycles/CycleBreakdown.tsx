import { ArrowDownRightIcon, ArrowUpRightIcon, InfoIcon } from "@phosphor-icons/react";
import { useCategorical, useContextGreys } from "@/features/crm/overview/vizPalette";
import { cn } from "@/lib/utils";
import { STATE_GROUPS } from "../model";

/**
 * Le panneau de gauche d'un cycle : de quoi son avancement est fait.
 *
 * Il répond à la seule question qui vaille en cours d'itération — « est-ce
 * qu'on tient ? » — et il y répond par un ÉCART, pas par un pourcentage.
 * « 20 % » ne dit rien sans savoir où l'on devrait être ; « en avance d'un work
 * item » le dit d'une phrase.
 *
 * D'où la séparation en deux blocs. En haut, les quatre séries QUI SONT SUR LE
 * GRAPHE — l'idéal du jour, le fait, l'en-cours, le périmètre — parce qu'une
 * légende doit correspondre à ce qu'on voit. En bas, les autres groupes d'état,
 * qui expliquent la composition du reste sans encombrer la courbe.
 */

export interface CycleStats {
  scope: number;
  done: number;
  started: number;
  unstarted: number;
  backlog: number;
  cancelled: number;
  /** Ce qui devrait être terminé aujourd'hui si l'on avançait linéairement. */
  idealDone: number;
}

export function CycleBreakdown({ stats }: { stats: CycleStats }) {
  const palette = useCategorical();
  const greys = useContextGreys();

  const delta = stats.done - stats.idealDone;
  const pending = Math.max(0, stats.scope - stats.done);

  const series = [
    { label: "Idéal du jour", value: stats.idealDone, color: greys.context, dashed: true },
    { label: "Terminés", value: stats.done, color: STATE_GROUPS.find((g) => g.key === "completed")!.color },
    { label: "En cours", value: stats.started, color: STATE_GROUPS.find((g) => g.key === "started")!.color },
    { label: "Périmètre", value: stats.scope, color: palette[0] },
  ];

  const others = [
    { label: "Restants", value: pending },
    { label: "À faire", value: stats.unstarted },
    { label: "Backlog", value: stats.backlog },
  ];

  return (
    <div className="space-y-4">
      <div>
        <p className="text-11 text-muted-foreground">
          Composition des work items de ce cycle
        </p>
        <p className={cn(
          "flex items-center gap-2 pt-1 text-16 font-semibold",
          delta > 0 ? "text-emerald-600" : delta < 0 ? "text-amber-600" : "text-foreground",
        )}>
          {delta > 0 ? <ArrowUpRightIcon className="h-4 w-4" />
            : delta < 0 ? <ArrowDownRightIcon className="h-4 w-4" />
            : null}
          {/* L'écart est nommé, pas seulement chiffré : « en avance de 1 »
              s'interprète sans référentiel, « +1 » demande de savoir par
              rapport à quoi. */}
          {delta === 0
            ? "Pile sur le rythme"
            : `${delta > 0 ? "En avance" : "En retard"} de ${Math.abs(delta)} work item${Math.abs(delta) > 1 ? "s" : ""}`}
        </p>
      </div>

      <div>
        <p className="pb-1.5 text-11 text-muted-foreground">
          Séries affichées sur le graphe
        </p>
        <ul>
          {series.map((s) => (
            <li
              key={s.label}
              className="flex items-center gap-2.5 border-b border-border/40 py-2 last:border-0"
            >
              {/* Le trait reprend EXACTEMENT le tracé du graphe, pointillé
                  compris : une légende dont le marqueur ne ressemble pas à la
                  courbe oblige à deviner la correspondance. */}
              <span
                className="h-0.5 w-4 shrink-0 rounded-full"
                style={{
                  background: s.dashed
                    ? `repeating-linear-gradient(90deg, ${s.color} 0 3px, transparent 3px 6px)`
                    : s.color,
                }}
              />
              <span className="min-w-0 flex-1 truncate text-13">{s.label}</span>
              <Count value={s.value} color={s.dashed ? undefined : s.color} />
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="pb-1.5 text-11 text-muted-foreground">Autres groupes d&apos;état</p>
        <ul>
          {others.map((o) => (
            <li
              key={o.label}
              className="flex items-center gap-2.5 border-b border-border/40 py-2 last:border-0"
            >
              <span className="min-w-0 flex-1 truncate text-13">{o.label}</span>
              <span className="shrink-0 text-13 tabular-nums text-muted-foreground">{o.value}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="flex items-center gap-1.5 border-t border-border/40 pt-3 text-11 text-muted-foreground">
        <InfoIcon className="h-3.5 w-3.5 shrink-0" />
        {stats.cancelled} work item{stats.cancelled > 1 ? "s" : ""} annulé
        {stats.cancelled > 1 ? "s" : ""} exclu{stats.cancelled > 1 ? "s" : ""} du calcul
      </p>
    </div>
  );
}

/** Le compteur d'une série. Coloré quand la série l'est — c'est le rappel qui
 *  permet de relier une valeur à sa courbe sans relire la légende. */
function Count({ value, color }: { value: number; color?: string }) {
  if (!color) {
    return <span className="shrink-0 text-13 tabular-nums text-muted-foreground">{value}</span>;
  }
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center rounded-md px-2 text-11 font-medium tabular-nums"
      style={{ background: `${color}22`, color }}
    >
      {value}
    </span>
  );
}
