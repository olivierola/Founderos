// build_context et context_page : UN outil pour aller chercher du contexte, UN
// outil pour le lire progressivement (docs/harness-opencode/03).
//
// L'ancien moteur avait six outils de recherche qui se ressemblaient
// (search_context, search_memory, search_knowledge, knowledge_search,
// search_past_work, recall_findings…) : le modèle hésitait, ou choisissait le
// mauvais. Ici, un seul outil, un paramètre `types` dont chaque valeur est
// décrite, et un résultat en deux temps :
//
//   1. build_context rend un INDEX : les morceaux trouvés, rangés par type dans
//      des balises <memory>, <documents>… — un identifiant, un titre, une taille ;
//   2. context_page rend le texte des morceaux choisis (par identifiant, ou par
//      type et par page), toujours dans la balise de leur type ; `keep` les
//      épingle : ils restent dans chaque requête de la session, sous
//      <working_context>, jusqu'à `drop`.
//
// Si tout ce qui a été trouvé est court, build_context rend directement le
// texte : pas de second appel pour rien.

import { CONTEXT_TYPES, type LegacyToolset } from "./catalogue.ts";

export interface ContextPiece {
  id: string;
  type: string;
  /** L'ancien outil qui l'a rendu. */
  source: string;
  title: string;
  text: string;
}

/** Le contexte d'une session : les morceaux trouvés et ceux qu'elle garde. */
export interface SessionContextState {
  pieces: Map<string, ContextPiece>;
  pinned: Set<string>;
  next: number;
}

export const newContextState = (): SessionContextState => ({ pieces: new Map(), pinned: new Set(), next: 0 });

/** Au-delà, build_context rend un index plutôt que le texte. */
export const INLINE_BUDGET = 2_500;
/** Le texte que context_page rend en un appel. */
export const PAGE_BUDGET = 8_000;
/** Le texte épinglé qui accompagne chaque requête. */
export const PINNED_BUDGET = 6_000;
const PIECE_MAX = 1_200;

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Rien trouvé : l'ancien outil le dit en une phrase. */
const isEmptyResult = (s: string) =>
  s.trim().length < 160 && /\b(no |none|nothing|0 (result|match)|aucun|aucune|rien|vide|empty)/i.test(s);

/**
 * Découpe un résultat d'outil en morceaux : une entrée de liste, un bloc entre
 * lignes vides ou un titre commencent un morceau ; les petits se regroupent,
 * les longs se coupent.
 */
export function splitPieces(text: string, max = PIECE_MAX): string[] {
  const entries = text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n|\n(?=\s*(?:\d+[.)]\s|[-•*]\s|\[\d+\]|#{1,4}\s|<(?:entry|result|item)\b))/)
    .map((e) => e.trim())
    .filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const e of entries) {
    if (e.length > max) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < e.length; i += max) out.push(e.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + e.length + 1 > max / 2) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n${e}` : e;
  }
  if (cur) out.push(cur);
  return out;
}

const titleOf = (text: string) => {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const t = line.replace(/^\s*(?:\d+[.)]|[-•*]|\[\d+\]|#{1,4})\s*/, "").trim();
  return t.length > 110 ? `${t.slice(0, 109)}…` : t;
};

const pieceTag = (p: ContextPiece) =>
  `<${p.type} id="${p.id}" source="${p.source}">\n${p.text}\n</${p.type}>`;

export interface BuildContextArgs {
  query?: string;
  types?: string[];
  limit?: number;
  filter?: Record<string, unknown>;
}

/** Les types de contexte que l'agent peut lire : ceux dont l'ancien outil existe. */
export function availableContextTypes(legacy: LegacyToolset) {
  const have = new Set(legacy.defs.map((d) => d.name));
  return CONTEXT_TYPES.filter((t) => t.calls("", { limit: 1 }).some((c) => have.has(c.tool)));
}

/** Ne garde que les arguments que l'ancien outil déclare. */
function fitArgs(legacy: LegacyToolset, tool: string, args: Record<string, unknown>) {
  const props = (legacy.defs.find((d) => d.name === tool)?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props) return args;
  return Object.fromEntries(Object.entries(args).filter(([k, v]) => k in props && v !== undefined && v !== ""));
}

export async function buildContext(
  legacy: LegacyToolset,
  state: SessionContextState,
  args: BuildContextArgs,
  signal?: AbortSignal,
): Promise<string> {
  const available = availableContextTypes(legacy);
  const have = new Set(legacy.defs.map((d) => d.name));
  const query = String(args.query ?? "").trim();
  const wanted = (args.types?.length ? args.types : []).map(String);
  if (!wanted.length) return `ERROR: types est requis. Valeurs : ${available.map((t) => t.id).join(", ")}.`;
  const unknown = wanted.filter((w) => !available.some((t) => t.id === w));
  if (unknown.length) return `ERROR: type(s) inconnu(s) ou indisponible(s) : ${unknown.join(", ")}. Valeurs : ${available.map((t) => t.id).join(", ")}.`;
  const limit = Math.max(1, Math.min(Number(args.limit) || 6, 20));
  if (!query && wanted.some((w) => w !== "table" && w !== "company" && w !== "resources" && w !== "findings")) {
    return "ERROR: query est requis (des mots-clés, un nom, une question).";
  }

  const results = await Promise.all(wanted.map(async (type) => {
    const spec = available.find((t) => t.id === type)!;
    const calls = spec.calls(query, { limit, filter: args.filter }).filter((c) => have.has(c.tool));
    const outs = await Promise.all(calls.map(async (c) => {
      try {
        return { tool: c.tool, text: await legacy.run(c.tool, fitArgs(legacy, c.tool, c.args), signal) };
      } catch (e) {
        return { tool: c.tool, text: `ERROR: ${e instanceof Error ? e.message : String(e)}` };
      }
    }));
    const pieces: ContextPiece[] = [];
    const errors: string[] = [];
    for (const o of outs) {
      if (/^ERROR/.test(o.text.trim())) { errors.push(o.text.trim().slice(0, 300)); continue; }
      if (isEmptyResult(o.text)) continue;
      for (const text of splitPieces(o.text)) {
        const id = `c${++state.next}`;
        const p = { id, type, source: o.tool, title: titleOf(text), text };
        state.pieces.set(id, p);
        pieces.push(p);
      }
    }
    return { type, pieces, errors };
  }));

  const total = results.reduce((n, r) => n + r.pieces.reduce((m, p) => m + p.text.length, 0), 0);
  const count = results.reduce((n, r) => n + r.pieces.length, 0);
  const inline = total <= INLINE_BUDGET;
  const blocks = results.map(({ type, pieces, errors }) => {
    const err = errors.length ? ` error="${escapeAttr(errors.join(" | "))}"` : "";
    if (!pieces.length) return `<${type} count="0"${err}>rien trouvé</${type}>`;
    if (inline) return pieces.map(pieceTag).join("\n");
    const lines = pieces.map((p) => `[${p.id}] ${p.title} (${p.text.length} car.)`);
    return `<${type} count="${pieces.length}"${err}>\n${lines.join("\n")}\n</${type}>`;
  });
  const head = `<context query="${escapeAttr(query)}" pieces="${count}"${inline ? "" : ` size="${total}"`}>`;
  const hint = !count
    ? "Rien trouvé : essaie d'autres mots-clés ou un autre type."
    : inline
    ? "Tout est là. Garde ce qui servira plus tard avec context_page(keep=[ids])."
    : "Ceci est un index. Lis les morceaux utiles avec context_page(ids=[…]) ou context_page(type=…, page=1) ; garde-les avec keep.";
  return `${head}\n${blocks.join("\n")}\n</context>\n${hint}`;
}

export interface ContextPageArgs {
  ids?: string[];
  type?: string;
  page?: number;
  keep?: string[];
  drop?: string[];
}

export function contextPage(state: SessionContextState, args: ContextPageArgs): string {
  const notes: string[] = [];
  for (const id of args.drop ?? []) if (state.pinned.delete(String(id))) notes.push(`retiré : ${id}`);
  const missing: string[] = [];
  for (const id of args.keep ?? []) {
    if (state.pieces.has(String(id))) state.pinned.add(String(id));
    else missing.push(String(id));
  }
  if (args.keep?.length) notes.push(`gardés : ${[...state.pinned].join(", ") || "aucun"}`);
  if (missing.length) notes.push(`inconnus : ${missing.join(", ")}`);

  let selected: ContextPiece[] = [];
  let more = "";
  if (args.ids?.length) {
    const ids = args.ids.map(String);
    const unknown = ids.filter((id) => !state.pieces.has(id));
    if (unknown.length) notes.push(`inconnus : ${unknown.join(", ")}`);
    selected = ids.map((id) => state.pieces.get(id)).filter((p): p is ContextPiece => !!p);
  } else if (args.type) {
    const all = [...state.pieces.values()].filter((p) => p.type === args.type);
    // Des pages au budget de texte, dans l'ordre où les morceaux sont arrivés.
    const pages: ContextPiece[][] = [[]];
    let size = 0;
    for (const p of all) {
      if (size + p.text.length > PAGE_BUDGET && pages[pages.length - 1].length) { pages.push([]); size = 0; }
      pages[pages.length - 1].push(p);
      size += p.text.length;
    }
    const n = Math.max(1, Math.min(Number(args.page) || 1, pages.length));
    selected = pages[n - 1];
    if (!all.length) notes.push(`aucun morceau de type ${args.type} : appelle build_context d'abord`);
    else more = n < pages.length ? `page ${n}/${pages.length} — suite : context_page(type="${args.type}", page=${n + 1})` : `page ${n}/${pages.length}`;
  }

  // Au budget d'un appel : le reste est signalé, pas perdu.
  const shown: ContextPiece[] = [];
  let size = 0;
  for (const p of selected) {
    if (shown.length && size + p.text.length > PAGE_BUDGET) break;
    shown.push(p);
    size += p.text.length;
  }
  const rest = selected.slice(shown.length).map((p) => p.id);
  if (rest.length) more = `${more ? `${more} · ` : ""}non affichés (budget) : context_page(ids=[${rest.map((r) => `"${r}"`).join(", ")}])`;

  const body = shown.map(pieceTag).join("\n");
  const tail = [more, ...notes].filter(Boolean).join("\n");
  if (!body && !tail) return "Rien à montrer : donne ids, ou type (et page), ou keep/drop.";
  return [body, tail].filter(Boolean).join("\n");
}

/** Ce que la session garde, rendu pour chaque requête (null : rien d'épinglé). */
export function pinnedBlock(state: SessionContextState): string | null {
  if (!state.pinned.size) return null;
  const parts: string[] = [];
  let size = 0;
  for (const id of state.pinned) {
    const p = state.pieces.get(id);
    if (!p) continue;
    if (size + p.text.length > PINNED_BUDGET) {
      parts.push(`<!-- ${id} et suivants : au-delà du budget, relis-les avec context_page -->`);
      break;
    }
    parts.push(pieceTag(p));
    size += p.text.length;
  }
  return parts.length ? `<working_context>\nLe contexte que tu as choisi de garder pour ce travail.\n${parts.join("\n")}\n</working_context>` : null;
}
