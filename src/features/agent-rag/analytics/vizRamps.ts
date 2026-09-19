import { useThemeMode } from "@/lib/theme-context";
import { useCategorical, useContextGreys } from "@/features/crm/overview/vizPalette";

/**
 * Rampes ORDONNÉES des pages stat d'un agent public.
 *
 * Les slots catégoriels de `vizPalette` répondent à « quelle série » ; ici on a
 * besoin des deux autres métiers de couleur, qu'ils ne savent pas faire :
 *
 *  · SEQUENTIEL / ORDINAL — une magnitude (visiteurs par pays) ou un ordre de
 *    scène (les étages de l'entonnoir). Une seule teinte, pas de saut de hue,
 *    et un pas de clarté assez large pour se voir.
 *  · DIVERGENT — une polarité (notes 5→1 autour d'un 3 neutre). Deux teintes
 *    opposées, un gris au milieu, autant de pas par bras.
 *
 * Toutes ces valeurs sortent du validateur de la skill dataviz, contre les
 * surfaces réelles de l'app (clair #fcfcfb, sombre #1e1d1c) :
 *
 *   rampe séquentielle clair  #8ab0e6→#123a6e   ALL CHECKS PASS
 *   rampe séquentielle sombre #37639e→#b3d1f4   ALL CHECKS PASS
 *   bras positif  clair #5f8fd8→#20539b · sombre #3c6aa8→#7fadea   PASS
 *   bras négatif  clair #e08a80→#b33227 · sombre #b33e33→#e5948a   PASS
 *
 * Le bras négatif clair (#e08a80) passe à 2,52:1 : sous la barre des 3:1 des
 * marques. La compensation exigée est le libellé direct — d'où les lignes
 * chiffrées sous chaque barre de distribution. Ne pas les retirer.
 */

const SEQ_LIGHT = ["#8ab0e6", "#5f8fd8", "#3a70c4", "#20539b", "#123a6e"];
const SEQ_DARK = ["#37639e", "#4a80c6", "#6499de", "#8ab6ea", "#b3d1f4"];

/** Rampe de magnitude, du plus faible au plus fort. */
export function useSequential(): string[] {
  return useThemeMode() === "dark" ? SEQ_DARK : SEQ_LIGHT;
}

/** Échelle divergente des notes : [1, 2, 3, 4, 5]. Le 3 est le gris neutre —
 *  « ni content ni mécontent » ne doit pas porter de teinte. */
export function useRatingScale(): string[] {
  const dark = useThemeMode() === "dark";
  const greys = useContextGreys();
  return dark
    ? ["#b33e33", "#e5948a", greys.context, "#3c6aa8", "#7fadea"]
    : ["#b33227", "#e08a80", greys.context, "#5f8fd8", "#20539b"];
}

/** Couleurs d'issue de conversation. Un entonnoir est ORDINAL (résolu / non
 *  résolu / escaladé ne sont pas des identités interchangeables), mais les
 *  trois branches se lisent côte à côte : on garde donc la même logique que les
 *  notes — une teinte par polarité, du gris pour l'indéterminé. */
export function useOutcomeColors() {
  const dark = useThemeMode() === "dark";
  const greys = useContextGreys();
  const cat = useCategorical();
  return {
    resolved: dark ? "#3c6aa8" : "#20539b",
    escalated: cat[3],                       // jaune : parti chez un humain
    unresolved: dark ? "#b33e33" : "#b33227",
    abandoned: dark ? "#e5948a" : "#e08a80",
    unknown: greys.context,
  };
}

/** Interpole une valeur 0..1 sur la rampe séquentielle (bornes incluses). */
export function rampAt(ramp: string[], t: number): string {
  if (!Number.isFinite(t)) return ramp[0];
  const i = Math.round(Math.min(1, Math.max(0, t)) * (ramp.length - 1));
  return ramp[i];
}
