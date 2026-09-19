import { AGENTS_SECTION } from "./contentAgents";
import { RESOURCES_SECTION } from "./contentResources";
import { SPACE_SECTION } from "./contentSpace";
import { START_SECTION } from "./contentStart";
import { WORK_SECTION } from "./contentWork";
import type { DocArticle, DocSection } from "./types";

/**
 * L'ordre des sections est celui dans lequel on découvre le produit : ce que
 * c'est, où l'on travaille, ce qui dépasse le projet, ce que les machines y
 * font, et enfin ce qui se règle. Un sommaire rangé par ordre alphabétique
 * ferait commencer le lecteur par « Agents » et finir par « Workgraph » — deux
 * écrans qu'on n'ouvre qu'une fois le reste compris.
 */
export const DOC_SECTIONS: DocSection[] = [
  START_SECTION,
  WORK_SECTION,
  SPACE_SECTION,
  AGENTS_SECTION,
  RESOURCES_SECTION,
];

export const ALL_ARTICLES: DocArticle[] = DOC_SECTIONS.flatMap((s) => s.articles);

/**
 * Deux articles ne peuvent pas porter le même slug.
 *
 * Ce n'est pas une précaution théorique : « overview » a servi deux fois — pour
 * l'introduction et pour la page Overview d'un projet — et la seconde était
 * SILENCIEUSEMENT inatteignable, `findArticle` renvoyant toujours la première.
 * Rien ne cassait, le sommaire menait simplement au mauvais texte.
 *
 * L'alerte est en développement seulement : en production, un doublon vaut
 * mieux qu'un écran blanc.
 */
if (import.meta.env?.DEV) {
  const seen = new Set<string>();
  for (const a of ALL_ARTICLES) {
    if (seen.has(a.slug)) {
      console.error(`[docs] slug en double : « ${a.slug} ». Le second article est inatteignable.`);
    }
    seen.add(a.slug);
  }
}

export function findArticle(slug: string | null | undefined): DocArticle | null {
  if (!slug) return null;
  return ALL_ARTICLES.find((a) => a.slug === slug) ?? null;
}

/**
 * La recherche du sommaire.
 *
 * Elle porte sur le titre, le résumé ET les mots-clés — pas sur le corps. Un
 * article se trouve par ce qu'il traite, pas par un mot qui y apparaît une
 * fois ; chercher dans le corps ferait remonter dix articles pour « projet »
 * et n'aiderait personne.
 */
export function searchArticles(query: string): DocArticle[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return ALL_ARTICLES.filter((a) =>
    a.title.toLowerCase().includes(q)
    || a.summary.toLowerCase().includes(q)
    || (a.keywords ?? []).some((k) => k.includes(q)));
}

/** L'article précédent et le suivant, pour la lecture au fil. */
export function neighbours(slug: string): { prev: DocArticle | null; next: DocArticle | null } {
  const i = ALL_ARTICLES.findIndex((a) => a.slug === slug);
  if (i < 0) return { prev: null, next: null };
  return {
    prev: i > 0 ? ALL_ARTICLES[i - 1] : null,
    next: i < ALL_ARTICLES.length - 1 ? ALL_ARTICLES[i + 1] : null,
  };
}
