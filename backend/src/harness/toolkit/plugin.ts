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

import path from "node:path";
import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import {
  LOTS, MEMORY_KINDS, buildKitTools, uncovered,
  type KitTool, type LegacyToolset, type LotId,
} from "./catalogue.ts";
import {
  availableContextTypes, buildContext, contextPage, newContextState, pinnedBlock,
  type SessionContextState,
} from "./context.ts";
import { activeSpecialists, specialistSystem, type ActiveSpecialist, type KitSkill } from "./specialists.ts";

type SetupContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

/** Ce que l'outillage reçoit de l'ancien moteur pour un agent. */
export interface Kit {
  agentName: string;
  isOrchestrator: boolean;
  legacy: LegacyToolset;
  skills: KitSkill[];
}

/** L'état d'une session : son lot ouvert et son contexte. */
export interface KitSession {
  lot: LotId | null;
  context: SessionContextState;
}

export type KitSessions = Map<string, KitSession>;

/** Les outils natifs d'OpenCode qu'un lot ou le noyau garde ; tous les autres sont retirés. */
const NATIVE_CORE = ["todowrite", "question", "subagent", "skill"];
const NATIVE_FILES = ["read", "write", "edit", "glob", "grep"];
const KIT_CORE = ["open_lot", "build_context", "context_page", "remember"];
const SPECIALIST_CORE = ["build_context", "context_page", "todowrite", "skill"];

/** Le schéma d'entrée déclaré à OpenCode : souple ; le vrai schéma JSON est posé par le hook. */
const LooseInput = Schema.Record(Schema.String, Schema.Unknown);

const text = (content: string) => ({ content });

export interface InstalledKit {
  /** Le texte « Tes outils » du prompt de l'agent. */
  guidance: string;
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

export function kitGuidance(tools: KitTool[], specialists: ActiveSpecialist[], contextTypes: string[]): string {
  const lots = lotsOf(tools);
  return [
    "Toujours disponibles :",
    `- build_context : aller chercher du contexte (types : ${contextTypes.join(", ")}). Rend un index par type ; lis les morceaux avec context_page.`,
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
        "Aller chercher du contexte, de un ou plusieurs types à la fois. Rend un index rangé par type dans des balises " +
        "(<memory>, <documents>…), ou directement le texte s'il est court.\n" +
        availableContextTypes(kit.legacy).map((t) => `- ${t.id} : ${t.description}`).join("\n"),
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "Des mots-clés, un nom, une question." },
          types: { type: "array", items: { type: "string", enum: contextTypes }, minItems: 1, description: "Les types de contexte à lire." },
          limit: { type: "number", description: "Résultats par type (défaut 6, max 20)." },
          filter: { type: "object", description: "Précisions propres à un type : table → { table, columns, filters, order_by } ; documents → { collection_id } ; facts → { kind }." },
        },
        required: ["types"], additionalProperties: false,
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
    for (const t of all) {
      editor.add({
        name: t.name,
        options: { codemode: false },
        description: t.description,
        input: LooseInput,
        execute: async (input: Record<string, unknown>, c) => {
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
          if (t.name === "build_context") {
            const types = Array.isArray(args.types) ? args.types.map(String) : [];
            if (spec) {
              const refused = types.filter((x) => !spec.contextTypes.includes(x));
              if (refused.length) return text(`ERROR: types hors du métier de ${spec.id} : ${refused.join(", ")}. Permis : ${spec.contextTypes.join(", ")}.`);
            }
            return text(await buildContext(kit.legacy, s.context, { ...args, types } as never, c.signal));
          }
          if (t.name === "context_page") return text(contextPage(s.context, args as never));
          return text(await t.run(args, c.signal));
        },
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
          { action: "skill", resource: "*", effect: "deny" },
          ...s.skills.map((slug) => ({ action: "skill", resource: slug, effect: "allow" })),
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
    guidance: kitGuidance(tools, specialists, contextTypes),
    tools: all,
    specialists,
    uncovered: uncovered(kit.legacy),
  };
}
