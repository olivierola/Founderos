// grep : chercher d'abord par mots-clés dans la base de connaissances, comme un
// développeur fait un grep dans un dépôt (docs/harness-opencode/03).
//
// L'agent lance un ou plusieurs grep avec des mots-clés de la demande et des
// mots voisins (synonymes, sigles, noms propres). Chaque source trouvée reçoit
// un identifiant (g1, g2…) avec sa provenance : son type, son chemin lisible,
// son titre, les lignes qui correspondent. Il lit ensuite ce qui l'intéresse
// avec build_context(from=[…]).
//
// L'index est une table de la base (migration 0308, search_index), tenue à jour
// par des triggers : rien n'est copié sur disque. Le texte y est plié
// (minuscules, sans accents) ; le motif est plié de la même façon ici.

import type { SessionContextState } from "./context.ts";

export const GREP_TYPES = ["documents", "memory", "team", "facts", "past_work", "artifacts", "conversation"] as const;
export type GrepType = (typeof GREP_TYPES)[number];

export const GREP_TYPE_DOC: Record<GrepType, string> = {
  documents: "passages des documents de la base de connaissances",
  memory: "ta mémoire durable",
  team: "la mémoire partagée de l'équipe",
  facts: "le graphe de connaissances : entités et faits",
  past_work: "les livrables de tes travaux passés",
  artifacts: "les documents de l'espace",
  conversation: "les messages de tes conversations",
};

/** Une ligne de l'index, telle que search_grep et search_read la rendent. */
export interface IndexRow {
  id: string;
  type: string;
  path: string;
  title: string | null;
  content: string;
  tags: string[];
  meta: Record<string, unknown>;
  grp: string;
  source_table: string;
  source_id: string;
  score: number;
  updated_at: string;
}

export interface SearchIndex {
  grep(p: { types: string[]; regexes: string[]; all: boolean; path: string | null; limit: number; offset: number }): Promise<IndexRow[]>;
  read(ids: string[], whole: boolean): Promise<IndexRow[]>;
}

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<IndexRow[]>;

/** L'index d'un agent : ses requêtes portent toujours son espace, son projet et son identité. */
export function rpcSearchIndex(rpc: Rpc, scope: { workspaceId: string; projectId: string | null; agentId: string }): SearchIndex {
  const base = { p_workspace: scope.workspaceId, p_project: scope.projectId, p_agent: scope.agentId };
  return {
    grep: (p) => rpc("search_grep", {
      ...base, p_types: p.types, p_regexes: p.regexes, p_all: p.all, p_path: p.path, p_limit: p.limit, p_offset: p.offset,
    }),
    read: (ids, whole) => rpc("search_read", { ...base, p_ids: ids, p_whole: whole }),
  };
}

/** L'appel RPC par un client Supabase (le client de service du backend). */
export const supabaseRpc = (admin: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> }): Rpc =>
  async (fn, args) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(error.message);
    return (data ?? []) as IndexRow[];
  };

// ── Pliage ───────────────────────────────────────────────────────────────────

// La même table que public.search_fold (0308) : caractère pour caractère.
const FOLD_FROM = "àáâãäåāçćčèéêëēėęìíîïīįñńòóôõöøōùúûüūýÿžźżœæß";
const FOLD_TO = "aaaaaaaccceeeeeeeiiiiiinnooooooouuuuuyyzzzoas";
const FOLD = new Map([...FOLD_FROM].map((c, i) => [c, FOLD_TO[i]]));

export const fold = (s: string) => [...s.toLowerCase()].map((c) => FOLD.get(c) ?? c).join("");

/** Plie un motif d'expression régulière sans toucher aux échappements (\D, \S, \W…). */
export function foldPattern(p: string): string {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "\\" && i + 1 < p.length) { out += p[i] + p[i + 1]; i++; continue; }
    out += fold(p[i]);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORD_START_JS = "(?<![\\p{L}\\p{N}])";

export type GrepMode = "any" | "all" | "phrase" | "regex";

export interface Patterns {
  /** Pour PostgreSQL (search_grep), sur le texte plié. */
  regexes: string[];
  all: boolean;
  /** Pour retrouver les lignes ici, sur chaque ligne pliée. */
  js: RegExp[];
}

/**
 * Les expressions d'un motif. Les mots (any, all) et la phrase sont cherchés en
 * début de mot : « factur » trouve « facture » et « facturation », pas « préfacturé ».
 */
export function buildPatterns(pattern: string, mode: GrepMode): Patterns | string {
  const p = pattern.trim();
  if (!p) return "pattern est vide.";
  if (mode === "regex") {
    const pg = foldPattern(p);
    const jsSource = pg.replace(/\\m/g, WORD_START_JS).replace(/\\M/g, "(?![\\p{L}\\p{N}])").replace(/\\y/g, "\\b");
    let js: RegExp[] = [];
    try { js = [new RegExp(jsSource, "u")]; } catch (e) {
      // PostgreSQL connaît quelques constructions de plus : on le laisse juger.
      if (!/\\[mMyYAZ]/.test(pg)) return `expression régulière invalide : ${e instanceof Error ? e.message : String(e)}`;
    }
    return { regexes: [pg], all: true, js };
  }
  if (mode === "phrase") {
    const body = escapeRe(fold(p)).replace(/\s+/g, "\\s+");
    return { regexes: [`\\m${body}`], all: true, js: [new RegExp(`${WORD_START_JS}${body}`, "u")] };
  }
  const words = [...new Set(p.split(/[\s,;|]+/).map((w) => fold(w.replace(/^["'«“]+|["'»”]+$/g, ""))).filter((w) => w.length >= 2))].slice(0, 12);
  if (!words.length) return "pattern ne contient aucun mot d'au moins 2 caractères.";
  return {
    regexes: words.map((w) => `\\m${escapeRe(w)}`),
    all: mode === "all",
    js: words.map((w) => new RegExp(`${WORD_START_JS}${escapeRe(w)}`, "u")),
  };
}

/** Un motif de chemin à la manière d'un glob : documents/contrats/*, facts/customer/**. */
export function globToLike(glob: string | undefined | null): string | null {
  const g = (glob ?? "").trim();
  if (!g) return null;
  const escaped = g.replace(/[\\%_]/g, (c) => `\\${c}`);
  const like = escaped.replace(/\*\*?/g, "%").replace(/\?/g, "_");
  return /[*?]/.test(g) ? like : `${like}%`;
}

// ── Les lignes trouvées ─────────────────────────────────────────────────────

const LINE_MAX = 240;

/** Une ligne longue (un passage de PDF sans retours) : la fenêtre autour de la correspondance. */
function windowOf(line: string, at: number): string {
  if (line.length <= LINE_MAX) return line;
  const start = Math.max(0, Math.min(at - 80, line.length - LINE_MAX));
  return `${start > 0 ? "…" : ""}${line.slice(start, start + LINE_MAX)}${start + LINE_MAX < line.length ? "…" : ""}`;
}

/** Les lignes d'un contenu qui correspondent, avec leurs voisines, au format ripgrep. */
export function matchingLines(content: string, js: RegExp[], context: number, maxMatches: number): { text: string; matches: number } {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const hits: Array<{ i: number; at: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const f = fold(lines[i]);
    let at = -1;
    for (const re of js) {
      const m = re.exec(f);
      if (m && (at < 0 || m.index < at)) at = m.index;
    }
    if (at >= 0) hits.push({ i, at });
  }
  if (!hits.length) {
    // Le titre seul correspond, ou un motif que seul PostgreSQL sait lire : le début.
    const first = lines.findIndex((l) => l.trim());
    return { text: first >= 0 ? `${first + 1}- ${windowOf(lines[first], 0)}` : "", matches: 0 };
  }
  const shown = new Map<number, string>();
  for (const h of hits.slice(0, maxMatches)) {
    for (let j = Math.max(0, h.i - context); j <= Math.min(lines.length - 1, h.i + context); j++) {
      if (j === h.i) shown.set(j, `${j + 1}: ${windowOf(lines[j], h.at)}`);
      else if (!shown.has(j) && lines[j].trim()) shown.set(j, `${j + 1}- ${windowOf(lines[j], 0)}`);
    }
  }
  const order = [...shown.keys()].sort((a, b) => a - b);
  const out: string[] = [];
  order.forEach((j, k) => {
    if (k > 0 && j > order[k - 1] + 1) out.push("--");
    out.push(shown.get(j)!);
  });
  if (hits.length > maxMatches) out.push(`… ${hits.length - maxMatches} autre(s) ligne(s)`);
  return { text: out.join("\n"), matches: hits.length };
}

// ── L'outil ──────────────────────────────────────────────────────────────────

export interface GrepArgs {
  pattern?: string;
  mode?: GrepMode;
  types?: string[];
  path?: string;
  output?: "content" | "sources" | "count";
  context?: number;
  limit?: number;
  offset?: number;
}

/** Une source trouvée, que build_context(from) sait relire. */
export interface GrepHit {
  hit: string;
  id: string;
  type: string;
  path: string;
  title: string | null;
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const OUTPUT_BUDGET = 7_000;

function hitFor(state: SessionContextState, row: IndexRow): GrepHit {
  for (const h of state.hits.values()) if (h.id === row.id) return h;
  const hit = `g${++state.nextHit}`;
  const h = { hit, id: row.id, type: row.type, path: row.path, title: row.title };
  state.hits.set(hit, h);
  return h;
}

export async function grep(index: SearchIndex, state: SessionContextState, args: GrepArgs, allowed: readonly string[]): Promise<string> {
  const mode: GrepMode = (["any", "all", "phrase", "regex"] as const).includes(args.mode as GrepMode) ? args.mode as GrepMode : "any";
  const patterns = buildPatterns(String(args.pattern ?? ""), mode);
  if (typeof patterns === "string") return `ERROR: ${patterns}`;
  const types = args.types?.length ? args.types.map(String) : [...allowed];
  const refused = types.filter((t) => !allowed.includes(t));
  if (refused.length) return `ERROR: type(s) non permis : ${refused.join(", ")}. Valeurs : ${allowed.join(", ")}.`;
  const output = args.output === "sources" || args.output === "count" ? args.output : "content";
  const context = Math.max(0, Math.min(Number(args.context ?? 1) || 0, 5));
  const limit = Math.max(1, Math.min(Number(args.limit) || 15, 50));
  const offset = Math.max(0, Number(args.offset) || 0);
  const path = globToLike(args.path);

  let rows: IndexRow[];
  try {
    rows = await index.grep({
      types, regexes: patterns.regexes, all: patterns.all, path,
      limit: output === "count" ? 500 : limit + 1, offset: output === "count" ? 0 : offset,
    });
  } catch (e) {
    return `ERROR: recherche impossible : ${e instanceof Error ? e.message : String(e)}`;
  }
  const head = `<grep pattern="${attr(String(args.pattern))}" mode="${mode}" types="${types.join(",")}"${args.path ? ` path="${attr(args.path)}"` : ""}`;

  if (output === "count") {
    const byType = new Map<string, number>();
    const byPath = new Map<string, number>();
    for (const r of rows) {
      byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
      byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
    }
    const top = [...byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    return `${head} output="count" total="${rows.length}${rows.length === 500 ? "+" : ""}">\n` +
      [...byType.entries()].map(([t, n]) => `${t}: ${n}`).join("\n") +
      (top.length ? `\n-- chemins les plus touchés\n${top.map(([p, n]) => `${p}: ${n}`).join("\n")}` : "") +
      "\n</grep>";
  }

  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  if (!page.length) {
    return `${head} sources="0">rien trouvé</grep>\n` +
      "Essaie d'autres mots (synonymes, sigles, forme courte : « factur » trouve facture et facturation), mode=any, un autre type, " +
      "ou la recherche sémantique : build_context(query, types).";
  }
  const blocks: string[] = [];
  let size = 0;
  let cut = -1;
  for (let k = 0; k < page.length; k++) {
    const r = page[k];
    const h = hitFor(state, r);
    const at = `hit="${h.hit}" path="${attr(r.path)}"${r.title ? ` title="${attr(r.title)}"` : ""}`;
    let block: string;
    if (output === "sources") {
      const { matches } = matchingLines(r.content, patterns.js, 0, 1);
      block = `<${r.type} ${at} lines="${matches}"/>`;
    } else {
      const { text } = matchingLines(r.content, patterns.js, context, 6);
      block = `<${r.type} ${at}>\n${text}\n</${r.type}>`;
    }
    if (size + block.length > OUTPUT_BUDGET && blocks.length) { cut = k; break; }
    blocks.push(block);
    size += block.length;
  }
  const shown = cut >= 0 ? cut : page.length;
  const nextOffset = offset + shown;
  const tail = cut >= 0 || more
    ? `Suite : grep(…, offset=${nextOffset}).`
    : "";
  const ids = page.slice(0, shown).map((r) => `"${hitFor(state, r).hit}"`).join(", ");
  return `${head} sources="${shown}"${more || cut >= 0 ? ` more="true"` : ""}>\n${blocks.join("\n")}\n</grep>\n` +
    [tail, `Lis ce qui compte avec build_context(from=[${ids}]) ; whole=true relit le document ou la conversation entière.`].filter(Boolean).join("\n");
}
