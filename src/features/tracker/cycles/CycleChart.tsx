import { useMemo } from "react";
import { useCategorical, useContextGreys } from "@/features/crm/overview/vizPalette";
import { cn } from "@/lib/utils";

/**
 * La courbe d'un cycle, dans ses deux lectures.
 *
 * `build-up` monte : ce qui est TERMINÉ s'accumule jusqu'au périmètre.
 * `burn-down` descend : ce qui RESTE s'épuise jusqu'à zéro.
 *
 * Les deux disent la même chose et ne se lisent pas pareil. Le build-up rassure
 * — on voit ce qu'on a produit ; le burn-down inquiète utilement — on voit ce
 * qui manque encore et à quelle vitesse il diminue. Une équipe qui suit son
 * reste-à-faire s'aperçoit d'un dérapage plus tôt, d'où le choix laissé à
 * l'utilisateur plutôt qu'imposé.
 *
 * La ligne idéale n'est PAS une prédiction : c'est la droite entre le départ et
 * l'arrivée. Elle sert de repère pour dire « en avance / en retard » d'un coup
 * d'œil, sans lire les valeurs.
 */

export type ChartMode = "build-up" | "burn-down";

export interface CyclePoint {
  /** Le jour, au format ISO court. */
  day: string;
  /** Cumul terminé à cette date. */
  done: number;
}

export function CycleChart({
  points, scope, mode, startDate, endDate, className,
}: {
  points: CyclePoint[];
  scope: number;
  mode: ChartMode;
  startDate: string;
  endDate: string;
  className?: string;
}) {
  const palette = useCategorical();
  const greys = useContextGreys();

  const geometry = useMemo(() => {
    if (!points.length || scope <= 0) return null;

    const width = 100;
    const height = 100;
    const max = Math.max(1, scope);
    const step = points.length > 1 ? width / (points.length - 1) : 0;

    const valueOf = (p: CyclePoint) => (mode === "build-up" ? p.done : scope - p.done);
    const y = (v: number) => height - (v / max) * height;

    // La courbe s'arrête AUJOURD'HUI et ne file pas jusqu'à la fin du cycle :
    // prolonger à plat suggérerait que rien n'avance, alors qu'il ne s'est
    // simplement rien passé encore.
    const today = new Date().toISOString().slice(0, 10);
    const upto = points.filter((p) => p.day <= today);
    const drawn = upto.length ? upto : [points[0]];

    const line = drawn.map((p, i) => `${i * step},${y(valueOf(p))}`).join(" ");
    const lastX = (drawn.length - 1) * step;
    const area = `0,${height} ${line} ${lastX},${height}`;

    const ideal = mode === "build-up"
      ? `0,${height} ${width},${y(scope)}`
      : `0,${y(scope)} ${width},${height}`;

    return { line, area, ideal, last: drawn[drawn.length - 1], progress: lastX };
  }, [points, scope, mode]);

  if (!geometry) {
    return (
      <div className={cn("flex h-56 items-center justify-center", className)}>
        <p className="text-12 text-muted-foreground">Pas encore de données à tracer.</p>
      </div>
    );
  }

  const ticks = axisTicks(points);

  return (
    <div className={className}>
      <div className="flex gap-3">
        {/* L'axe vertical est écrit à part et non dans le SVG : le viewBox est
            étiré horizontalement (preserveAspectRatio none), ce qui déformerait
            tout texte placé dedans. */}
        <div className="flex w-6 shrink-0 flex-col justify-between py-0.5 text-right text-10 tabular-nums text-muted-foreground">
          {[scope, Math.round(scope * 0.75), Math.round(scope / 2), Math.round(scope * 0.25), 0]
            .map((v, i) => <span key={i}>{v}</span>)}
        </div>

        <div className="min-w-0 flex-1">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="h-56 w-full"
            role="img"
            aria-label={
              mode === "build-up"
                ? `${geometry.last.done} work items terminés sur ${scope}`
                : `${scope - geometry.last.done} work items restants sur ${scope}`
            }
          >
            {[0, 25, 50, 75, 100].map((v) => (
              <line
                key={v} x1="0" x2="100" y1={v} y2={v}
                stroke={greys.context} strokeWidth="0.5"
                vectorEffect="non-scaling-stroke" opacity="0.35"
              />
            ))}

            <polyline
              points={geometry.ideal} fill="none" strokeWidth="1"
              strokeDasharray="3 3" stroke={greys.context}
              vectorEffect="non-scaling-stroke"
            />

            <polygon points={geometry.area} fill={palette[0]} opacity="0.14" />
            <polyline
              points={geometry.line} fill="none" strokeWidth="2"
              stroke={palette[0]} vectorEffect="non-scaling-stroke"
              strokeLinejoin="round" strokeLinecap="round"
            />
          </svg>

          <div className="flex justify-between pt-1.5 text-10 text-muted-foreground">
            {ticks.map((t) => (
              <span key={t.day} className={cn(t.edge && "font-medium text-foreground")}>
                {t.label}
                {t.edge && (
                  <span className="block text-9 font-normal text-muted-foreground">
                    {t.day === startDate ? "Début" : "Fin"}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Cinq graduations au plus : au-delà, les dates se chevauchent sur un cycle
 *  court et deviennent illisibles. Les extrémités sont toujours présentes —
 *  ce sont elles qui bornent la lecture. */
function axisTicks(points: CyclePoint[]): { day: string; label: string; edge: boolean }[] {
  if (!points.length) return [];
  const wanted = Math.min(5, points.length);
  const stride = Math.max(1, Math.floor((points.length - 1) / (wanted - 1 || 1)));

  const picked: CyclePoint[] = [];
  for (let i = 0; i < points.length; i += stride) picked.push(points[i]);
  const last = points[points.length - 1];
  if (picked[picked.length - 1]?.day !== last.day) picked.push(last);

  return picked.map((p, i) => ({
    day: p.day,
    label: new Date(`${p.day}T00:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }),
    edge: i === 0 || i === picked.length - 1,
  }));
}
