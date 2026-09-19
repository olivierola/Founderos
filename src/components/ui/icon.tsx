import { forwardRef } from "react";
import type { Icon as PhosphorIcon, IconWeight } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/**
 * Le système d'icônes, réglé sur les règles de SF Symbols.
 *
 * ── Pourquoi Phosphor et pas SF Symbols ─────────────────────────────────────
 * SF Symbols est sous une licence qui le réserve aux applications tournant sur
 * les plateformes Apple. On ne peut donc pas l'embarquer dans un produit web,
 * et aucune façon détournée ne rendrait cela licite. Phosphor est le plus
 * proche parent disponible : même construction — un trait unique, des
 * terminaisons arrondies, une grille commune — et surtout le même système de
 * GRAISSES, qui est ce qui fait l'essentiel du comportement de SF Symbols.
 *
 * ── Les trois règles reprises ───────────────────────────────────────────────
 *
 * 1. LA GRAISSE SUIT CELLE DU TEXTE VOISIN.
 *    C'est la règle centrale : les neuf graisses de SF Symbols correspondent
 *    aux neuf graisses de San Francisco, pour qu'une icône posée à côté d'un
 *    libellé ait exactement le même poids de trait. Une icône fine à côté d'un
 *    texte gras — ou l'inverse — se voit immédiatement, sans qu'on sache dire
 *    pourquoi la ligne « sonne faux ».
 *
 * 2. L'ÉCHELLE SE MESURE SUR LA HAUTEUR DE CAPITALE, PAS EN PIXELS.
 *    Apple définit small / medium / large relativement à la capitale de la
 *    fonte, ce qui permet d'accentuer une icône sans casser l'accord de
 *    graisse. D'où des tailles en `em` et non en pixels : l'icône grandit avec
 *    son texte, y compris quand quelqu'un grossit la police du navigateur.
 *
 * 3. LE PLEIN MARQUE LA SÉLECTION, LE CONTOUR EST L'ÉTAT NORMAL.
 *    « Outline works well in toolbars, lists, alongside text » ; « fill
 *    variants give visual emphasis; ideal for tab bars ». Le remplissage n'est
 *    donc pas un choix esthétique : c'est ce qui dit « celui-ci est actif ».
 *    En faire un style par défaut lui retire ce sens.
 */

/** Les trois échelles, en multiples de la hauteur de capitale. */
export type IconScale = "small" | "medium" | "large";

const SCALE: Record<IconScale, string> = {
  // Ces coefficients placent l'icône respectivement sous, à, et au-dessus de
  // la hauteur de capitale du texte courant. `1em` vaudrait la hauteur du
  // CADRAT, nettement plus grand qu'une capitale : une icône à 1em paraît
  // toujours trop grosse à côté de son libellé.
  small: "1em",
  medium: "1.14em",
  large: "1.32em",
};

/**
 * Le poids du trait, aligné sur les graisses de texte du produit.
 *
 * Phosphor n'offre pas les neuf graisses de SF Symbols ; il en offre quatre
 * utiles. La table ci-dessous fait correspondre chaque graisse de texte à la
 * plus proche, plutôt que d'inventer un cinquième cran qui n'existe pas.
 */
const WEIGHT: Record<number, IconWeight> = {
  300: "light",
  400: "regular",
  450: "regular",
  500: "regular",
  600: "bold",
  700: "bold",
};

export interface IconProps {
  /** L'icône Phosphor à rendre. */
  as: PhosphorIcon;
  /** Le rang de taille. `medium` par défaut, comme dans SF Symbols. */
  scale?: IconScale;
  /**
   * La graisse du texte à côté duquel l'icône est posée. L'icône s'y accorde.
   * Sans valeur, on prend le regular — le cas de loin le plus fréquent.
   */
  weight?: 300 | 400 | 450 | 500 | 600 | 700;
  /**
   * Actif. C'est ce qui bascule le contour en plein, et rien d'autre : ne pas
   * s'en servir pour « faire joli », sous peine de rendre la sélection
   * illisible partout ailleurs.
   */
  active?: boolean;
  /**
   * Le rang hiérarchique, repris du mode « hierarchical » de SF Symbols : une
   * seule couleur, dont l'opacité descend avec le rang. C'est ce qui permet à
   * une icône secondaire de rester DE LA MÊME COULEUR que le texte tout en
   * passant au second plan, là où un gris choisi à part ferait une troisième
   * couleur dans la ligne.
   */
  rank?: "primary" | "secondary" | "tertiary";
  className?: string;
  /**
   * Décoratif quand un libellé dit déjà la même chose. Les HIG insistent :
   * une icône seule doit porter un texte de remplacement, une icône doublée
   * d'un libellé ne doit PAS être annoncée deux fois.
   */
  label?: string;
}

const RANK: Record<NonNullable<IconProps["rank"]>, string> = {
  primary: "opacity-100",
  secondary: "opacity-60",
  tertiary: "opacity-30",
};

export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { as: Glyph, scale = "medium", weight = 400, active = false, rank = "primary", className, label },
  ref,
) {
  const size = SCALE[scale];

  return (
    <Glyph
      ref={ref}
      // `currentColor` est implicite chez Phosphor ; on n'impose donc aucune
      // couleur ici. C'est ce qui laisse l'icône suivre la vibrance et le mode
      // sombre du texte qui la porte, exactement comme un symbole système.
      weight={active ? "fill" : WEIGHT[weight]}
      style={{ width: size, height: size }}
      className={cn("shrink-0", RANK[rank], className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
});
