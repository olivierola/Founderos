import type { CompanionTab, SelectionAction } from "./bridge";

/**
 * What to propose on the page the person is looking at.
 *
 * Read from the URL alone: no request, no model call, instant on every tab
 * switch. The point is not to guess everything, it is that the first click on
 * a LinkedIn profile offers to qualify it rather than to "summarize the page".
 * Every suggestion sends the page along.
 */

export interface Suggestion {
  id: string;
  label: string;
  prompt: string;
}

const s = (id: string, label: string, prompt: string): Suggestion => ({ id, label, prompt });

export const ANALYZE_PAGE_PROMPT =
  "Analyse cette page : l'essentiel en quelques points, ce qui mérite mon attention, et ce que tu me conseilles d'en faire. "
  + "Surligne dans la page les passages les plus importants.";

export const SELECTION_PROMPTS: Record<Exclude<SelectionAction, "ask">, string> = {
  explain: "Explique-moi ce passage simplement, avec le contexte utile.",
  summarize: "Résume ce passage en quelques points.",
  translate: "Traduis ce passage en français (en anglais s'il est déjà en français), en gardant le ton.",
};

const GENERIC: Suggestion[] = [
  s("summary", "Résumer la page", "Résume cette page en quelques points, puis dis-moi ce qu'il faut en retenir."),
  s("figures", "Chiffres et faits clés", "Relève les chiffres, dates et faits importants de cette page, et surligne-les."),
  s("next", "Que faire de cette page ?", "D'après cette page, que me conseilles-tu de faire maintenant ? Sois concret."),
];

const RULES: Array<{ test: (u: URL) => boolean; items: Suggestion[] }> = [
  {
    test: (u) => /mail\.google\.com|outlook\.(live|office|office365)\.com/.test(u.hostname),
    items: [
      s("mail-sum", "Résumer ce fil", "Résume ce fil d'e-mails : qui veut quoi, ce qui est décidé, ce qui reste en suspens."),
      s("mail-reply", "Préparer une réponse", "Rédige une réponse à ce message, dans mon ton, courte et claire. Propose-la moi sans l'envoyer."),
      s("mail-todo", "Actions à faire", "Liste les actions que ce message attend de moi, avec les échéances s'il y en a."),
    ],
  },
  {
    test: (u) => /linkedin\.com$/.test(u.hostname) && u.pathname.startsWith("/in/"),
    items: [
      s("li-profile", "Résumer ce profil", "Résume ce profil : parcours, poste actuel, ce qui le rend pertinent pour nous."),
      s("li-qualify", "Qualifier ce prospect", "Ce profil est-il un bon prospect pour nous ? Donne ton avis argumenté et les signaux que tu as repérés."),
      s("li-message", "Message d'approche", "Rédige un premier message d'approche personnalisé à partir de ce profil, court et sans formule creuse."),
    ],
  },
  {
    test: (u) => /linkedin\.com$/.test(u.hostname) && u.pathname.startsWith("/company/"),
    items: [s("li-company", "Fiche entreprise", "Fais-moi une fiche de cette entreprise : activité, taille, signaux récents, angle pour l'aborder.")],
  },
  {
    test: (u) => u.hostname === "github.com" && /\/pull\/\d+/.test(u.pathname),
    items: [
      s("gh-review", "Relire cette PR", "Relis cette pull request : risques, oublis, questions à poser à l'auteur. Surligne ce qui t'inquiète."),
      s("gh-sum", "Résumer les changements", "Résume ce que change cette pull request, pour quelqu'un qui ne connaît pas le code."),
    ],
  },
  {
    test: (u) => u.hostname === "github.com" && /\/issues\/\d+/.test(u.pathname),
    items: [s("gh-issue", "Analyser ce ticket", "Résume ce ticket, sa cause probable et une piste de solution.")],
  },
  {
    test: (u) => /atlassian\.net$|linear\.app$|app\.asana\.com$|trello\.com$/.test(u.hostname),
    items: [
      s("ticket-sum", "Résumer ce ticket", "Résume ce ticket : le besoin, l'état, les blocages et la prochaine étape."),
      s("ticket-plan", "Découper le travail", "Propose un découpage de ce travail en étapes concrètes."),
    ],
  },
  {
    test: (u) => u.hostname === "docs.google.com" && u.pathname.startsWith("/spreadsheets"),
    items: [s("sheet", "Analyser ce tableau", "Analyse les données visibles de ce tableau : tendances, anomalies, ce qu'il faut regarder de près.")],
  },
  {
    test: (u) => (u.hostname === "docs.google.com" && u.pathname.startsWith("/document")) || /notion\.(so|site)$/.test(u.hostname) || /\.sharepoint\.com$/.test(u.hostname),
    items: [
      s("doc-sum", "Résumer ce document", "Résume ce document et ses décisions clés."),
      s("doc-review", "Relire et corriger", "Relis ce document : clarté, erreurs, incohérences. Surligne les passages à revoir et propose une correction pour chacun."),
    ],
  },
  {
    test: (u) => /(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === "/watch",
    items: [s("yt", "Résumer la vidéo", "D'après la description et les commentaires visibles, de quoi parle cette vidéo et vaut-elle le coup ?")],
  },
  {
    test: (u) => /\.(stripe|hubspot|salesforce|pipedrive)\.com$|^dashboard\.stripe\.com$/.test(u.hostname),
    items: [s("crm", "Lire cet écran", "Explique ce que montre cet écran et ce qui demande une action de ma part.")],
  },
  {
    test: (u) => /amazon\.|cdiscount\.|fnac\.|ebay\./.test(u.hostname),
    items: [s("product", "Évaluer ce produit", "Évalue ce produit : points forts, points faibles d'après les avis, et si le prix est cohérent.")],
  },
];

export function suggestionsFor(tab: CompanionTab | null): Suggestion[] {
  if (!tab?.injectable) return [];
  let url: URL;
  try { url = new URL(tab.url); } catch { return GENERIC; }
  const specific = RULES.find((r) => r.test(url))?.items ?? [];
  // Les suggestions propres au site d'abord, complétées par les génériques.
  return [...specific, ...GENERIC].slice(0, 4);
}
