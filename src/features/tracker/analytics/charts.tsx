import { useMemo } from "react";
import { useContextGreys } from "@/features/crm/overview/vizPalette";
import { cn } from "@/lib/utils";

/**
 * Les deux graphes des onglets d'analytics.
 *
 * Ils partagent une grille et des axes nommés, et diffèrent par ce qu'ils
 * mesurent :
 *   · `BarChart`      — un DÉNOMBREMENT par catégorie (combien de projets par
 *                       statut). La barre part de zéro, ce qui rend les
 *                       hauteurs comparables entre elles.
 *   · `LollipopChart` — une VALEUR par entité nommée (l'avancement de chaque
 *                       cycle). La tige et le point remplacent la barre parce
 *                       qu'ici la surface ne veut rien dire : on lit une
 *                       position sur l'axe, pas une quantité, et une barre
 *                       pleine suggérerait à tort qu'on peut additionner.
 */

const AXIS_LABEL = "text-10 uppercase tracking-wide text-muted-foreground";

export interface BarDatum {
  label: string;
  value: number;
  color: string;
}

export function BarChart({
  data, yLabel, xLabel, height = 280,
}: { data: BarDatum[]; yLabel: string; xLabel: string; height?: number }) {
  const greys = useContextGreys();

  const { max, ticks } = useMemo(() => {
    const peak = Math.max(1, ...data.map((d) => d.value));
    // On arrondit le plafond au cran supérieur pour que la graduation tombe sur
    // des entiers : un axe qui affiche « 3,5 projets » n'a pas de sens.
    const ceiling = Math.max(1, Math.ceil(peak));
    const count = Math.min(6, ceiling + 1);
    return {
      max: ceiling,
      ticks: Array.from({ length: count }, (_, i) =>
        Math.round((ceiling / (count - 1 || 1)) * (count - 1 - i))),
    };
  }, [data]);

  return (
    <div className="flex gap-3" style={{ height }}>
      <span className={cn(AXIS_LABEL, "flex w-4 shrink-0 items-center justify-center")}>
        <span className="vertical-text">{yLabel}</span>
      </span>

      <div className="flex w-8 shrink-0 flex-col justify-between pb-8 text-right text-10 tabular-nums text-muted-foreground">
        {ticks.map((t, i) => <span key={i}>{t}</span>)}
      </div>

      <div className="relative min-w-0 flex-1">
        <div className="absolute inset-x-0 bottom-8 top-0">
          {ticks.map((_, i) => (
            <span
              key={i}
              className="absolute inset-x-0 border-t"
              style={{
                top: `${(i / (ticks.length - 1 || 1)) * 100}%`,
                borderColor: greys.context,
                opacity: 0.3,
              }}
            />
          ))}
        </div>

        <div className="absolute inset-x-0 bottom-8 top-0 flex items-stretch justify-around gap-4 px-2">
          {data.map((d) => (
            <div key={d.label} className="flex min-w-0 flex-1 flex-col items-center justify-end">
              <span
                title={`${d.label} : ${d.value}`}
                className="w-full max-w-[52px] rounded-t-sm transition-all"
                style={{
                  height: `${(d.value / max) * 100}%`,
                  background: d.color,
                  // Un minimum visible : une barre à zéro doit rester une barre
                  // repérable, sinon la catégorie disparaît du graphe.
                  minHeight: d.value > 0 ? 4 : 2,
                  opacity: d.value > 0 ? 1 : 0.3,
                }}
              />
            </div>
          ))}
        </div>

        <div className="absolute inset-x-0 bottom-0 flex h-8 items-start justify-around gap-4 px-2">
          {data.map((d) => (
            <span key={d.label} className="min-w-0 flex-1 truncate text-center text-10 text-muted-foreground">
              {d.label}
            </span>
          ))}
        </div>
      </div>

      <span className={cn(AXIS_LABEL, "sr-only")}>{xLabel}</span>
    </div>
  );
}

export interface LollipopDatum {
  label: string;
  /** En pourcentage, 0 à 100. */
  value: number;
  color: string;
}

export function LollipopChart({
  data, yLabel, height = 300,
}: { data: LollipopDatum[]; yLabel: string; height?: number }) {
  const greys = useContextGreys();
  const ticks = [100, 75, 60, 45, 30, 15, 0];

  return (
    <div className="flex gap-3" style={{ height }}>
      <span className={cn(AXIS_LABEL, "flex w-4 shrink-0 items-center justify-center")}>
        <span className="vertical-text">{yLabel}</span>
      </span>

      <div className="flex w-8 shrink-0 flex-col justify-between pb-10 text-right text-10 tabular-nums text-muted-foreground">
        {ticks.map((t) => <span key={t}>{t}</span>)}
      </div>

      <div className="relative min-w-0 flex-1">
        <div className="absolute inset-x-0 bottom-10 top-0">
          {ticks.map((t, i) => (
            <span
              key={t}
              className="absolute inset-x-0 border-t"
              style={{
                top: `${(i / (ticks.length - 1)) * 100}%`,
                borderColor: greys.context,
                opacity: 0.3,
              }}
            />
          ))}
        </div>

        <div className="absolute inset-x-0 bottom-10 top-0 flex items-stretch justify-around gap-6 px-4">
          {data.map((d) => (
            <div key={d.label} className="relative flex min-w-0 flex-1 justify-center">
              {/* La tige part de la base et porte le point à sa valeur : c'est
                  la POSITION du point qui se lit, la tige ne fait que la relier
                  visuellement à l'axe. */}
              <span
                className="absolute bottom-0 w-0.5 rounded-full"
                style={{ height: `${d.value}%`, background: d.color, opacity: 0.6 }}
              />
              <span
                className="absolute h-3 w-3 rounded-full ring-2 ring-background"
                style={{ bottom: `calc(${d.value}% - 6px)`, background: d.color }}
                title={`${d.label} : ${d.value}%`}
              />
            </div>
          ))}
        </div>

        <div className="absolute inset-x-0 bottom-0 flex h-10 items-start justify-around gap-6 px-4">
          {data.map((d) => (
            <span
              key={d.label}
              className="line-clamp-2 min-w-0 flex-1 text-center text-10 text-muted-foreground"
            >
              {d.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** La légende partagée des deux graphes : pastille + libellé, jamais la
 *  couleur seule — sur six statuts dont trois gris, elle ne suffirait pas. */
export function ChartLegend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-3">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5 text-11 text-muted-foreground">
          <span className="h-2 w-2 rounded-full" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
