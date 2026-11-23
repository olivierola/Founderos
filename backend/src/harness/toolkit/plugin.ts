// L'outillage d'un agent FounderOS dans son instance OpenCode
// (docs/harness-opencode/03) : appelé par agent-plugin.ts une fois le profil lu.
//
//   - enregistre le noyau (open_lot, build_context, context_page, remember) et
//     les outils regroupés du catalogue, servis par l'ancien moteur ;
//   - à chaque requête (hook `context`), ne laisse au modèle que le noyau et les
//     outils du lot ouvert — un outil retiré ne peut pas non plus être exécuté —,
//     pose les vrais schémas JSON, et ajoute le contexte épinglé ;
//   - déclare les spécialistes (sous-agents) et les skills de l'agent, chacun
//     limité par des permissions.

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import {
  LOTS, MEMORY_KINDS, buildKitTools, legacyAliases, uncovered,
  type KitTool, type LegacyToolset, type LotId,
} from "./catalogue.ts";
import {
  availableContextTypes, buildContext, contextPage, newContextState, pinnedBlock,
  type SessionContextState,
} from "./context.ts";
import { GREP_TYPE_DOC, grep, grepTypesFor, type GrepType, type SearchIndex } from "./grep.ts";
import { activeSpecialists, specialistSystem, type ActiveSpecialist, type KitSkill } from "./specialists.ts";

type SetupContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

/** Ce que l'outillage reçoit de l'ancien moteur pour un agent. */
export interface Kit {
  agentName: string;
  isOrchestrator: boolean;
  legacy: LegacyToolset;
  skills: KitSkill[];
  /** L'index de recherche de l'agent (0308) : absent, pas de grep. */
  search?: SearchIndex;
}

/** L'état d'une session : son lot ouvert et son contexte. */
export interface KitSession {
  lot: LotId | null;
  context: SessionContextState;
}

export type KitSessions = Map<string, KitSession>;

/**
 * La session d'où part l'appel d'outil en cours. Les outils de l'ancien moteur
 * en ont besoin pour connaître LEUR run (approbations, timeline, conversation,
 * personne qui pilote le tour) : l'outillage est installé une fois par agent,
 * mais chaque appel s'exécute dans cette portée.
 */
export const toolCallScope = new AsyncLocalStorage<{ sessionID: string; agent: string }>();

/** Les outils natifs d'OpenCode qu'un lot ou le noyau garde ; tous les autres sont retirés. */
const NATIVE_CORE = ["todowrite", "question", "subagent", "skill"];
// Le grep natif d'OpenCode (fichiers du dossier) laisse son nom au grep de la base.
const NATIVE_FILES = ["read", "write", "edit", "glob"];
const KIT_CORE = ["grep", "open_lot", "build_context", "context_page", "remember"];
const SPECIALIST_CORE = ["grep", "build_context", "context_page", "todowrite", "skill"];

/** Le schéma d'entrée déclaré à OpenCode : souple ; le vrai schéma JSON est posé par le hook. */
const LooseInput = Schema.Record(Schema.String, Schema.Unknown);

const text = (content: string) => ({ content });

/**
 * Les règles qui ferment ce qu'OpenCode apporte et qu'un agent FounderOS n'a pas
 * à voir, à ajouter APRÈS ses autres permissions (la dernière règle qui
 * correspond l'emporte) :
 *   - `execute` refusé : pas de Code Mode, donc pas de catalogue de ses outils
 *     internes (worktrees, modèles, sessions…) dans le prompt ;
 *   - `skill` refusé, sauf pour les skills donnés : les skills livrés avec
 *     OpenCode (opencode, report) disparaissent de la liste.
 */
export const kitPermissions = (skills: string[]) => [
  { action: "execute", resource: "*", effect: "deny" },
  { action: "skill", resource: "*", effect: "deny" },
  ...skills.map((slug) => ({ action: "skill", resource: slug, effect: "allow" })),
];

export interface InstalledKit {
  /** Le texte « Tes outils » du prompt de l'agent. */
  guidance: string;
  /** Les permissions à ajouter à l'agent principal (kitPermissions). */
  permissions: Array<{ action: string; resource: string; effect: string }>;
  tools: KitTool[];
  specialists: ActiveSpecialist[];
  /** Les anciens outils qu'aucun outil ne sert (à signaler). */
  uncovered: string[];
}

/** Les lots qui ont au moins un outil chez cet agent, avec leurs outils. */
function lotsOf(tools: KitTool[]) {
  return LOTS
    .map((l) => ({ ...l, tools: l.id === "fichiers" ? NATIVE_FILES : tools.filter((t) => t.lot === l.id).map((t) => t.name) }))
    .filter((l) => l.tools.length > 0);
}

export function kitGuidance(tools: KitTool[], specialists: ActiveSpecialist[], contextTypes: string[], grepTypes: string[] = []): string {
  const lots = lotsOf(tools);
  const aliases = legacyAliases(tools);
  return [
    ...(grepTypes.length
      ? ["Pour savoir quelque chose, cherche D'ABORD avec grep, comme un développeur dans un dépôt : un ou plusieurs grep avec les mots-clés de la demande et des mots voisins (synonymes, sigles, noms propres, forme courte d'un mot). Chaque source trouvée a un identifiant (g1, g2…), son type et son chemin. Lis ensuite ce qui compte avec build_context(from=[…]). La recherche sémantique (build_context avec query et types) vient en complément, quand grep ne trouve rien."]
      : []),
    "Toujours disponibles :",
    ...(grepTypes.length ? [`- grep : chercher par mots-clés, phrase ou regex dans la base (${grepTypes.join(", ")}).`] : []),
    `- build_context : lire les sources trouvées par grep (from), ou une recherche sémantique (types : ${contextTypes.join(", ")}). Rend un index par type ; lis les morceaux avec context_page.`,
    "- context_page : lire les morceaux trouvés (ids, ou type et page) ; keep les garde pour la suite du travail, drop les retire.",
    "- remember : enregistrer un fait, une préférence, une connaissance d'équipe ou du graphe.",
    "- todowrite : ta liste de tâches, à tenir à jour. question : demander à la personne quand tu ne peux vraiment pas avancer sans elle.",
    "- skill : charger le mode d'emploi d'un de tes skills.",
    ...(specialists.length
      ? [`- subagent : confier UNE tâche délimitée à un spécialiste, qui ne voit que ta consigne et ses outils. Donne-lui toutes les données utiles. Spécialistes : ${specialists.map((s) => `${s.id} (${s.description})`).join(" ; ")}.`]
      : []),
    "- open_lot : ouvrir un lot d'outils. Un seul lot ouvert à la fois : ouvre celui dont tu as besoin, appelle son outil ; si ce n'est pas le bon, ouvre-en un autre.",
    "Lots :",
    ...lots.map((l) => `  - ${l.id} : ${l.summary} (${l.tools.join(", ")})`),
    ...(aliases.length
      ? ["Tes consignes, doctrines et skills citent parfois d'anciens noms d'outils ; voici l'outil à appeler à la place :", aliases.join(" ; ")]
      : []),
  ].join("\n");
}

export async function installToolkit(
  ctx: SetupContext,
  kit: Kit,
  sessions: KitSessions,
  opts: { mainAgent: string; skillsDir: string },
): Promise<InstalledKit> {
  const tools = buildKitTools(kit.legacy, { isOrchestrator: kit.isOrchestrator });
  const specialists = activeSpecialists(tools, kit.skills);
  const contextTypes = availableContextTypes(kit.legacy).map((t) => t.id);
  const lots = lotsOf(tools);
  const session = (id: string): KitSession => {
    let s = sessions.get(id);
    if (!s) sessions.set(id, (s = { lot: null, context: newContextState() }));
    return s;
  };
  const specialistOf = (agent: string) => specialists.find((s) => s.id === agent);

  // ── Le noyau ──
  const core: KitTool[] = [
    {
      name: "open_lot", lot: null,
      description: `Ouvre un lot d'outils : ses outils deviennent appelables, ceux de l'autre lot se ferment.\n${lots.map((l) => `- ${l.id} : ${l.summary}`).join("\n")}`,
      input: {
        type: "object",
        properties: { lot: { type: "string", enum: lots.map((l) => l.id) } },
        required: ["lot"], additionalProperties: false,
      },
      run: async () => "", // servi plus bas : il a besoin de la session
    },
    {
      name: "build_context", lot: null,
      description:
        "Construire le contexte, de deux façons :\n" +
        "- from : relire les sources trouvées par grep (g1, g2…), dont tu connais le type et le chemin ; whole=true relit le document, la conversation ou l'entité entière. C'est le chemin principal.\n" +
        "- query et types : une recherche sémantique, en complément quand grep ne trouve rien.\n" +
        "Le résultat est rangé par type dans des balises (<documents>, <memory>…) : le texte s'il est court, un index sinon. Types sémantiques :\n" +
        availableContextTypes(kit.legacy).map((t) => `- ${t.id} : ${t.description}`).join("\n"),
      input: {
        type: "object",
        properties: {
          from: { type: "array", items: { type: "string" }, description: "Les sources rendues par grep (g1, g2…)." },
          whole: { type: "boolean", description: "Avec from : relire tout le document, la conversation ou l'entité." },
          query: { type: "string", description: "Recherche sémantique : des mots-clés, un nom, une question." },
          types: { type: "array", items: { type: "string", enum: contextTypes }, description: "Recherche sémantique : les types à lire." },
          limit: { type: "number", description: "Résultats par type (défaut 6, max 20)." },
          filter: { type: "object", description: "Précisions propres à un type : table → { table, columns, filters, order_by } ; documents → { collection_id } ; facts → { kind }." },
        },
        additionalProperties: false,
      },
      run: async () => "",
    },
    {
      name: "context_page", lot: null,
      description:
        "Lire progressivement le contexte trouvé par build_context : des morceaux par identifiant, ou un type page par page. " +
        "keep garde des morceaux pour toute la suite du travail (ils reviennent à chaque étape dans <working_context>) ; drop les retire.",
      input: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Les morceaux à lire (c1, c2…)." },
          type: { type: "string", description: "Lire tous les morceaux d'un type, page par page." },
          page: { type: "number", description: "La page (avec type), à partir de 1." },
          keep: { type: "array", items: { type: "string" }, description: "Les morceaux à garder." },
          drop: { type: "array", items: { type: "string" }, description: "Les morceaux à ne plus garder." },
        },
        additionalProperties: false,
      },
      run: async () => "",
    },
  ];
  // Seulement les types que l'agent pouvait déjà lire avec l'ancien moteur.
  const grepTypes: GrepType[] = kit.search ? grepTypesFor(kit.legacy.defs.map((d) => d.name)) : [];
  if (kit.search && grepTypes.length) {
    core.unshift({
      name: "grep", lot: null,
      description:
        "Chercher dans la base de connaissances par mots-clés, comme un grep dans un dépôt. Commence toujours par là. " +
        "Lance-en plusieurs si besoin : les mots de la demande, puis des mots voisins (synonymes, sigles, noms propres, forme courte : « factur » trouve facture et facturation). " +
        "Rend les lignes qui correspondent, avec leur source (g1, g2…), son type et son chemin ; lis-les ensuite avec build_context(from=[…]).\n" +
        grepTypes.map((t) => `- ${t} : ${GREP_TYPE_DOC[t]}`).join("\n"),
      input: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Les mots-clés séparés par des espaces, une phrase, ou une expression régulière." },
          mode: { type: "string", enum: ["any", "all", "phrase", "regex"], description: "any (défaut) : un des mots au moins, les sources qui en ont le plus d'abord. all : tous les mots. phrase : la suite exacte. regex : expression régulière, en minuscules et sans accents." },
          types: { type: "array", items: { type: "string", enum: [...grepTypes] }, description: "Où chercher (défaut : partout)." },
          path: { type: "string", description: "Limiter à un chemin, à la manière d'un glob : documents/contrats/*, facts/customer/**." },
          output: { type: "string", enum: ["content", "sources", "count"], description: "content (défaut) : les lignes trouvées. sources : une ligne par source. count : combien, par type et par chemin." },
          context: { type: "number", description: "Lignes autour de chaque ligne trouvée (défaut 1, max 5)." },
          limit: { type: "number", description: "Sources rendues (défaut 15, max 50)." },
          offset: { type: "number", description: "Pour la suite des résultats." },
        },
        required: ["pattern"], additionalProperties: false,
      },
      run: async () => "",
    });
  }
  const kinds = Object.entries(MEMORY_KINDS).filter(([, k]) => kit.legacy.defs.some((d) => d.name === k.legacy));
  if (kinds.length) {
    core.push({
      name: "remember", lot: null,
      description: `Enregistrer quelque chose de durable. Une seule chose par appel, une phrase autoportante.\n${kinds.map(([id, k]) => `- ${id} : ${k.description}`).join("\n")}`,
      input: {
        type: "object",
        properties: {
          kind: { type: "string", enum: kinds.map(([id]) => id) },
          content: { type: "string", description: "Ce qu'il faut retenir (fact, preference, team)." },
          importance: { type: "number", description: "fact : 1 à 5." },
          topic: { type: "string", description: "preference : le sujet (langue, ton, format…)." },
          replaces: { type: "string", description: "preference : le texte exact d'une préférence qu'elle remplace." },
          remove: { type: "boolean", description: "preference : retirer la préférence donnée dans content." },
          entities: { type: "array", items: { type: "object" }, description: "knowledge : [{ name, kind, summary, facts: [{ statement }] }]." },
          relations: { type: "array", items: { type: "object" }, description: "knowledge : les liens entre entités." },
        },
        required: ["kind"], additionalProperties: false,
      },
      run: async (args, signal) => {
        const k = MEMORY_KINDS[String(args.kind)];
        if (!k) return `ERROR: kind = ${kinds.map(([id]) => id).join(" | ")}.`;
        const a = k.args(args);
        return typeof a === "string" ? `ERROR: ${a}` : kit.legacy.run(k.legacy, a, signal);
      },
    });
  }
  const all = [...core, ...tools];
  const byName = new Map(all.map((t) => [t.name, t]));

  await ctx.tool.transform((editor) => {
    // Le grep des fichiers d'OpenCode cède sa place au grep de la base. Les
    // autres outils livrés avec OpenCode sont coupés par les permissions
    // (kitPermissions) et retirés de chaque requête par le hook context.
    if (kit.search) editor.remove("grep");
    for (const t of all) {
      editor.add({
        name: t.name,
        options: { codemode: false },
        description: t.description,
        input: LooseInput,
        execute: (input: Record<string, unknown>, c) => toolCallScope.run({ sessionID: c.sessionID, agent: c.agent }, async () => {
          const args = (input ?? {}) as Record<string, unknown>;
          const s = session(c.sessionID);
          const spec = specialistOf(c.agent);
          // Un outil hors de la vue de cette session n'est pas exécuté (le hook
          // l'a déjà retiré : c'est une seconde barrière).
          if (spec && !SPECIALIST_CORE.includes(t.name) && !spec.available.includes(t.name)) {
            return text(`ERROR: ${t.name} n'est pas un outil du spécialiste ${spec.id}.`);
          }
          if (t.name === "open_lot") {
            const lot = lots.find((l) => l.id === args.lot);
            if (!lot) return text(`ERROR: lot inconnu. Lots : ${lots.map((l) => l.id).join(", ")}.`);
            s.lot = lot.id;
            const lines = lot.tools.map((n) => {
              const kt = byName.get(n);
              return `- ${n}${kt ? ` : ${kt.description.split("\n")[0]}` : ""}`;
            });
            return text(`Lot ${lot.id} ouvert. Appelables maintenant :\n${lines.join("\n")}`);
          }
          if (t.name === "grep") {
            const allowed = spec ? grepTypes.filter((x) => spec.contextTypes.includes(x)) : grepTypes;
            if (!allowed.length) return text(`ERROR: le spécialiste ${spec?.id} ne cherche pas dans la base.`);
            return text(await grep(kit.search!, s.context, args as never, allowed));
          }
          if (t.name === "build_context") {
            const types = Array.isArray(args.types) ? args.types.map(String) : [];
            const from = Array.isArray(args.from) ? args.from.map(String) : [];
            if (spec) {
              const refused = types.filter((x) => !spec.contextTypes.includes(x));
              if (refused.length) return text(`ERROR: types hors du métier de ${spec.id} : ${refused.join(", ")}. Permis : ${spec.contextTypes.join(", ")}.`);
              const foreign = from.filter((h) => { const hit = s.context.hits.get(h); return hit && !spec.contextTypes.includes(hit.type); });
              if (foreign.length) return text(`ERROR: sources hors du métier de ${spec.id} : ${foreign.join(", ")}.`);
            }
            return text(await buildContext(kit.legacy, s.context, { ...args, types, from } as never, c.signal, kit.search));
          }
          if (t.name === "context_page") return text(contextPage(s.context, args as never));
          return text(await t.run(args, c.signal));
        }),
      });
    }
  });

  // ── Les skills de l'agent, et les spécialistes ──
  if (kit.skills.length) {
    await ctx.skill.transform((editor) => {
      for (const k of kit.skills) {
        if (!k.instructions) continue;
        editor.add({
          id: k.slug, name: k.name, description: k.description ?? k.name,
          path: path.join(opts.skillsDir, k.slug, "SKILL.md"),
          content: k.instructions,
        } as never);
      }
    });
  }
  await ctx.agent.transform((editor) => {
    // Les sous-agents livrés avec OpenCode (general, explore…) voient tout : ils
    // laissent la place aux spécialistes.
    for (const a of editor.list()) {
      if (a.id !== opts.mainAgent && !specialists.some((s) => s.id === a.id)) editor.remove(a.id);
    }
    for (const s of specialists) {
      editor.update(s.id, (a) => {
        a.name = s.id as typeof a.name;
        a.description = s.description;
        a.mode = "subagent";
        a.hidden = false;
        a.system = specialistSystem(s, kit.agentName);
        a.permissions = [
          { action: "*", resource: "*", effect: "allow" },
          { action: "shell", resource: "*", effect: "deny" },
          { action: "external_directory", resource: "*", effect: "deny" },
          { action: "subagent", resource: "*", effect: "deny" },
          { action: "question", resource: "*", effect: "deny" },
          ...kitPermissions(s.skills),
        ] as typeof a.permissions;
      });
    }
  });

  // ── À chaque requête : la vue de la session ──
  await ctx.session.hook("context", (event) => {
    const spec = specialistOf(event.agent);
    const s = session(event.sessionID);
    const visible = new Set(spec
      ? [...SPECIALIST_CORE, ...spec.available]
      : [...NATIVE_CORE, ...KIT_CORE, ...(lots.find((l) => l.id === s.lot)?.tools ?? [])]);
    for (const name of Object.keys(event.tools)) {
      if (!visible.has(name)) delete event.tools[name];
    }
    for (const [name, t] of byName) {
      if (event.tools[name]) event.tools[name] = { description: t.description, input: t.input as never };
    }
    const pinned = pinnedBlock(s.context);
    if (pinned) event.system.push({ type: "text", text: pinned });
  });

  return {
    guidance: kitGuidance(tools, specialists, contextTypes, grepTypes),
    permissions: kitPermissions(kit.skills.filter((k) => k.instructions).map((k) => k.slug)),
    tools: all,
    specialists,
    uncovered: uncovered(kit.legacy),
  };
}
