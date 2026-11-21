// La forme des réponses : une règle de typographie posée sur TOUS les appels
// de chat (adaptChatBody), et la doctrine d'affichage des surfaces de chat
// (assistant, agents) qui rendent tableaux et composants.
//
// Le propriétaire ne veut pas de tirets longs (« — », « – »), la marque d'un
// texte écrit par une IA. Les modèles imitent le style de leur prompt : en plus
// de la règle, les tirets des messages système sont remplacés avant l'envoi.

export const NO_LONG_DASH_RULE =
  // Les caractères sont nommés, pas écrits : stripLongDashes ne doit pas
  // abîmer la règle quand un corps repasse par withHouseStyle.
  "TYPOGRAPHIE, règle absolue : n'écris JAMAIS de tiret long (tiret cadratin, U+2014) ni de tiret moyen (tiret demi-cadratin, U+2013), " +
  "ni dans le texte, ni dans les listes, ni dans les titres, ni dans les tableaux. " +
  "Pour relier un libellé et sa description, utilise les deux-points (« **Coût** : 27 $ ») ; " +
  "dans une phrase, une virgule, des parenthèses ou un point. Le trait d'union simple (-) reste permis.";

/** La doctrine d'affichage des surfaces de chat. Le front rend les tableaux
 *  markdown (triables, copiables) et les blocs ```ui (src/components/AgentMarkdown). */
export const RICH_REPLY_DOCTRINE = [
  "MISE EN FORME DES RÉPONSES (l'interface les affiche en vrais composants) :",
  "- Tableaux : dès que tu compares 3 éléments ou plus sur 2 attributs ou plus, écris un tableau markdown (ligne d'en-tête, puis |---|). Une donnée par cellule, l'unité dans l'en-tête (« Coût ($) ») pour que les colonnes se trient, pas d'emoji dans les cellules. L'utilisateur peut trier et copier le tableau.",
  "- Composants interactifs : un bloc de code de langage `ui` contenant UN objet JSON {\"component\": …, \"props\": …}, à l'endroit exact où il doit apparaître :",
  "  · kpi_grid {\"items\":[{\"label\":\"Coût\",\"value\":\"27,47 $\",\"delta\":\"+12 %\",\"tone\":\"red\"}]} : 2 à 8 indicateurs clés (tone : emerald, red, amber, blue) ;",
  "  · chart {\"type\":\"bar\",\"title\":\"…\",\"data\":[{\"x\":\"Lun\",\"y\":12}]} : une tendance ou une répartition (type : bar, line, area, pie) ;",
  "  · options {\"options\":[\"Creuser les échecs\",\"Voir les coûts\"]} : 2 à 6 suites cliquables quand tu proposes la suite ou poses une question fermée (le texte du bouton est envoyé tel quel) ;",
  "  · link_card {\"title\":\"…\",\"description\":\"…\",\"url\":\"…\"} : un lien vers une page de l'app ou du web.",
  "  JSON strict (guillemets doubles, aucun commentaire). Seulement des données réelles, obtenues par tes outils ou visibles à l'écran.",
  "- Structure : titres ### courts, listes à puces « - », paragraphes de deux ou trois phrases, pas de remplissage. Termine par un bloc options quand plusieurs suites sont possibles, plutôt qu'une question ouverte.",
].join("\n");

const LONG_DASH = /\s*[—–]\s*/g;

/** Un texte sans tiret long : « a — b » devient « a, b ». */
export function stripLongDashes(text: string): string {
  return text.replace(LONG_DASH, ", ");
}

type Msg = { role?: unknown; content?: unknown };

/**
 * La règle de typographie sur un chat : les tirets longs des messages système
 * remplacés, et la règle ajoutée au premier (ou en tête, s'il n'y en a pas).
 * Idempotent : un corps déjà traité passe tel quel.
 */
export function withHouseStyle(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  const messages = (body.messages as Msg[]).map((m) => {
    if (m?.role !== "system") return m;
    if (typeof m.content === "string") return { ...m, content: stripLongDashes(m.content) };
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: (m.content as Array<Record<string, unknown>>).map((p) =>
          p && p.type === "text" && typeof p.text === "string" ? { ...p, text: stripLongDashes(p.text) } : p),
      };
    }
    return m;
  });
  const already = messages.some((m) => m?.role === "system" && JSON.stringify(m.content ?? "").includes("TYPOGRAPHIE, règle absolue"));
  if (!already) {
    const i = messages.findIndex((m) => m?.role === "system");
    if (i >= 0 && typeof messages[i].content === "string") {
      messages[i] = { ...messages[i], content: `${messages[i].content}\n\n${NO_LONG_DASH_RULE}` };
    } else if (i >= 0 && Array.isArray(messages[i].content)) {
      messages[i] = { ...messages[i], content: [...(messages[i].content as unknown[]), { type: "text", text: `\n\n${NO_LONG_DASH_RULE}` }] };
    } else {
      messages.unshift({ role: "system", content: NO_LONG_DASH_RULE });
    }
  }
  return { ...body, messages };
}
