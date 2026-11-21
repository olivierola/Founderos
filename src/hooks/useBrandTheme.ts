import { useEffect } from "react";

/**
 * La DA de l'app (violet de marque adouci, gris charbon en sombre — voir
 * `.sd-brand` dans globals.css), le temps qu'une coque d'application est
 * montée : le tableau de service comme l'AI Workforce.
 *
 * Posée sur <html> et pas sur la coque : menus et dialogues sont rendus en
 * portail, hors de son sous-arbre, et garderaient sinon l'accent par défaut.
 * Passer d'une coque à l'autre ne fait pas clignoter la couleur : React
 * démonte l'ancienne (qui retire la classe) avant de monter la nouvelle (qui la
 * repose), dans le même commit.
 */
export function useBrandTheme(): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("sd-brand");
    return () => root.classList.remove("sd-brand");
  }, []);
}
