// Les spécialistes : des sous-agents qui se lancent pour UNE tâche précise et ne
// voient que ce qu'il leur faut (docs/harness-opencode/03).
//
// L'agent principal reste le seul à parler à la personne, à décider et à garder
// la mémoire. Quand une tâche est bien délimitée (une recherche, un rapport, une
// analyse de données, une suite d'appels à une application), il la confie à un
// spécialiste via l'outil `subagent` d'OpenCode. Le spécialiste reçoit :
//   - SES instructions (pas le prompt de l'agent, pas sa personnalité) ;
//   - les données que l'agent lui passe dans la consigne, et les types de
//     contexte de son métier (build_context restreint) ;
//   - les outils de son métier, et rien d'autre ;
//   - les skills de son métier, et rien d'autre.
// Il ne délègue pas, ne pose pas de question à la personne et n'écrit pas en
// mémoire : il rend un compte rendu à l'agent qui l'a lancé.

import type { KitTool } from "./catalogue.ts";

/** Un skill FounderOS, tel que l'agent l'a activé. */
export interface KitSkill {
  slug: string;
  name: string;
  description?: string | null;
  category?: string | null;
  instructions?: string | null;
  /** Les natures d'outils que le skill attend (required_tools). */
  tools?: string[] | null;
}

export interface SpecialistSpec {
  id: string;
  /** Ce que l'agent lit pour choisir (description de l'agent OpenCode). */
  description: string;
  instructions: string;
  /** Les outils du catalogue qu'il voit ; il existe si au moins un est là. */
  tools: string[];
  /** Les types de contexte qu'il peut lire avec build_context. */
  contextTypes: string[];
  /** Les skills de son métier : catégorie, slug ou nom. */
  skillMatch: RegExp;
}

const REPORT_BACK =
  "Tu travailles pour un agent FounderOS qui t'a confié UNE tâche. Tu ne parles pas à l'utilisateur. " +
  "Fais la tâche avec tes outils, sans t'en écarter. Termine par un compte rendu court et factuel : " +
  "le résultat, les sources ou identifiants utiles, et ce qui manque ou reste incertain. Réponds en français.";

export const SPECIALISTS: SpecialistSpec[] = [
  {
    id: "chercheur",
    description: "Recherche sur le web et synthèse sourcée. Donne-lui la question précise, ce que tu sais déjà et le format attendu.",
    instructions:
      "Tu es un chercheur. Tu trouves des informations fiables et récentes, tu croises les sources, tu cites chaque affirmation " +
      "(URL), tu distingues les faits des estimations. Tu t'arrêtes dès que la question a sa réponse.",
    tools: ["web", "browser"],
    contextTypes: ["documents", "facts", "findings"],
    skillMatch: /research|recherche|veille|web|search|seo|market|marché/i,
  },
  {
    id: "redacteur",
    description: "Rédaction d'un livrable : document, rapport, PDF, image. Donne-lui le sujet, la matière brute, le public et le format.",
    instructions:
      "Tu es un rédacteur. À partir de la matière fournie, tu produis UN livrable propre, structuré et exact, au ton demandé. " +
      "Tu n'inventes rien qui ne soit dans la matière ou dans le contexte que tu lis. Tu publies le livrable puis tu donnes son lien ou son identifiant.",
    tools: ["document", "report", "generate"],
    contextTypes: ["documents", "past_work", "artifacts"],
    skillMatch: /writ|rédac|redac|report|rapport|doc|content|contenu|pdf|design|brand/i,
  },
  {
    id: "analyste",
    description: "Analyse de données : tables du projet, chiffres, calculs, graphiques. Donne-lui la question et les données ou les tables à lire.",
    instructions:
      "Tu es un analyste de données. Tu lis les données, tu calcules (en Python quand c'est utile), tu vérifies tes chiffres " +
      "et tu rends des conclusions chiffrées avec leur méthode. Tu signales les données manquantes ou douteuses.",
    tools: ["run_code", "remote_files"],
    contextTypes: ["table", "company", "documents"],
    skillMatch: /data|donn|analy|stat|finance|kpi|sql|excel|spreadsheet/i,
  },
  {
    id: "integrateur",
    description: "Opérations dans les applications connectées (CRM, e-mail, Slack, MCP, automatisations). Donne-lui l'opération voulue et ses données.",
    instructions:
      "Tu es un intégrateur. Tu trouves l'application, tu lis le schéma de l'opération (apps describe) avant de l'appeler, " +
      "tu fais l'opération demandée et seulement elle, et tu rends ce que l'application a répondu. Une application non connectée : tu le dis, tu ne réessaies pas.",
    tools: ["apps"],
    contextTypes: ["resources"],
    skillMatch: /integr|crm|mail|slack|connect|automation|automatis|api/i,
  },
  {
    id: "operateur",
    description: "Travail technique sur une machine distante : code, commandes, fichiers, processus. Donne-lui l'objectif et le critère de réussite.",
    instructions:
      "Tu es un opérateur technique. Tu travailles sur la machine distante avec ses outils, par petites étapes vérifiées, " +
      "tu lis les erreurs et tu corriges. Tu rends ce qui a été fait, ce qui marche (preuve à l'appui) et ce qui reste.",
    tools: ["run_code", "remote_files", "process", "machine"],
    contextTypes: ["conversation", "documents"],
    skillMatch: /code|dev|devops|deploy|infra|linux|python|node|test|debug|kubernetes|docker/i,
  },
];

export interface ActiveSpecialist extends SpecialistSpec {
  /** Les outils présents chez cet agent. */
  available: string[];
  /** Les skills de l'agent qui lui reviennent. */
  skills: string[];
}

/** Les spécialistes qu'un agent peut lancer : ceux dont il a au moins un outil. */
export function activeSpecialists(tools: KitTool[], skills: KitSkill[]): ActiveSpecialist[] {
  const names = new Set(tools.map((t) => t.name));
  return SPECIALISTS
    .map((s) => ({
      ...s,
      available: s.tools.filter((t) => names.has(t)),
      skills: skills
        .filter((k) => s.skillMatch.test(`${k.category ?? ""} ${k.slug} ${k.name}`))
        .map((k) => k.slug),
    }))
    .filter((s) => s.available.length > 0);
}

/** Le prompt système d'un spécialiste : ses instructions, et rien de l'agent. */
export const specialistSystem = (s: ActiveSpecialist, agentName: string) =>
  `${s.instructions}\n\n${REPORT_BACK}\n\nL'agent qui t'a confié la tâche : ${agentName}.`;
