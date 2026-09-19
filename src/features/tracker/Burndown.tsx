import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCategorical, useContextGreys } from "@/features/crm/overview/vizPalette";
import { fetchBurndown, type PjCycle } from "./model";

/**
 * Le burndown d'un cycle : ce qui reste ouvert, jour après jour.
 *
 * Deux courbes seulement — le restant réel, et la ligne idéale. Ajouter le
 * cumulé terminé dirait la même chose à l'envers, et trois traits sur une carte
 * de cycle demandent une légende que personne ne lit.
 *
 * La ligne idéale n'est pas une prédiction : c'est la droite entre le total du
 * départ et zéro à la date de fin. Elle sert de repère visuel pour dire « en
 * avance / en retard » sans avoir à lire les valeurs.
 */
export function Burndown({ cycle }: { cycle: PjCycle }) {
  const { data: points } = useQuery({
    queryKey: ["pj_burndown", cycle.id],
    queryFn: () => fetchBurndown(cycle.id),
    enabled: Boolean(cycle.start_date && cycle.end_date),
  });

  const palette = useCategorical();
  const greys = useContextGreys();

  const chart = useMemo(() => {
    if (!points?.length) return null;
    const width = 100;
    const height = 40;
    const max = Math.max(1, ...points.map((p) => p.remaining + p.completed));
    const step = points.length > 1 ? width / (points.length - 1) : 0;

    const line = points
      .map((p, i) => `${i * step},${height - (p.remaining / max) * height}`)
      .join(" ");

    const start = points[0].remaining + points[0].completed;
    const ideal = `0,${height - (start / max) * height} ${width},${height}`;

    return { line, ideal, max, last: points[points.length - 1] };
  }, [points]);

  if (!cycle.start_date || !cycle.end_date) {
    return (
      <p className="py-3 text-11 text-muted-foreground">
        Le burndown demande une date de début et une date de fin.
      </p>
    );
  }

  if (!chart) {
    return <p className="py-3 text-11 text-muted-foreground">Pas encore de données.</p>;
  }

  return (
    <div className="pt-3">
      <div className="flex items-baseline justify-between pb-1.5 text-11">
        <span className="text-muted-foreground">Burndown</span>
        {/* La valeur est écrite, pas seulement tracée : une courbe de 40 pixels
            de haut ne se lit pas au chiffre près. */}
        <span className="tabular-nums">
          {chart.last.remaining} restants · {chart.last.completed} terminés
        </span>
      </div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-16 w-full" role="img"
           aria-label={`Burndown : ${chart.last.remaining} work items restants`}>
        <polyline
          points={chart.ideal} fill="none" strokeWidth="0.7"
          strokeDasharray="2 2" stroke={greys.context} vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={chart.line} fill="none" strokeWidth="1.5"
          stroke={palette[0]} vectorEffect="non-scaling-stroke"
          strokeLinejoin="round" strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
