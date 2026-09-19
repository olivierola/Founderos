import { useEffect } from "react";

/**
 * Empêche le DOCUMENT de défiler tant qu'une coque applicative est montée.
 *
 * Une coque d'application (AppShell, tableau de service) occupe exactement la
 * hauteur de la fenêtre et fait défiler SA zone de contenu. Le document, lui,
 * ne devrait jamais défiler. Mais il suffit d'un élément qui déborde hors de la
 * coque — un portail mal positionné, un reste d'animation, une mesure arrondie
 * au pixel près — pour que `body` gagne quelques centaines de pixels. Le
 * navigateur ajoute alors une SECONDE barre de défilement, qui fait glisser
 * toute l'application vers le haut : la barre de navigation disparaît, et un
 * bandeau vide apparaît sous l'app.
 *
 * Plutôt que de traquer chaque débordement possible — il en reviendra toujours
 * un —, on retire au document la possibilité même de défiler, le temps que la
 * coque est à l'écran. C'est ce que font les applications de ce type.
 *
 * Posé par une CLASSE sur <html> et non en dur dans la feuille globale : le
 * site marketing, lui, défile par le document, et un verrou global l'aurait
 * figé.
 */
export function useLockDocumentScroll() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("app-shell-lock");
    return () => root.classList.remove("app-shell-lock");
  }, []);
}
