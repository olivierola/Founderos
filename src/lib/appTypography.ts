/** Ce qu'on lit du routeur : l'adresse courante, et ses changements. */
interface RouterLike {
  state: { location: { pathname: string } };
  subscribe: (fn: (state: { location: { pathname: string } }) => void) => unknown;
}

/**
 * La typographie de l'application (19/11/2026), reprise de la planche
 * « Asphalt » : Inter (taille optique comprise), deux graisses seulement,
 * 400 pour le texte et 500 pour les titres et les chiffres, des étiquettes de
 * section en petites capitales espacées, des statuts en chasse fixe.
 *
 * Elle vaut de la sélection des organisations jusqu'aux tableaux de service ;
 * le site public et les pages de connexion gardent la leur. D'où un attribut
 * sur <html>, posé selon l'adresse, plutôt qu'un changement de la police par
 * défaut : les règles vivent dans globals.css sous `[data-typo="app"]`.
 */
const APP_PATHS = /^\/(orgs|app|companion|setup|sso-setup)(\/|$)/;

function apply(pathname: string) {
  const root = document.documentElement;
  if (APP_PATHS.test(pathname)) root.dataset.typo = "app";
  else delete root.dataset.typo;
}

export function bindAppTypography(router: RouterLike): void {
  apply(router.state.location.pathname);
  router.subscribe((state) => apply(state.location.pathname));
}
