import type { ReactNode } from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

/**
 * Un article de documentation.
 *
 * Le corps est une FONCTION et non un nœud déjà construit : la table des
 * matières charge quarante titres, elle n'a pas à construire quarante arbres de
 * React pour les afficher. Seul l'article ouvert est rendu.
 */
export interface DocArticle {
  slug: string;
  title: string;
  /** La phrase de la table des matières et de la recherche. */
  summary: string;
  /** Les mots qu'on taperait pour trouver cet article sans en connaître le titre. */
  keywords?: string[];
  body: () => ReactNode;
}

export interface DocSection {
  key: string;
  label: string;
  icon: PhosphorIcon;
  articles: DocArticle[];
}
