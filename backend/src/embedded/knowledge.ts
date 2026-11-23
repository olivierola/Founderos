// La connaissance embarquée d'un agent : ce qu'il peut lire dans l'index de
// recherche (0308), figé dans un fichier pour chercher même sans réseau.
//
//   côté plateforme  knowledgeSnapshot() : ses documents (collections de ses
//                    pools), sa mémoire, celle de l'équipe ; rien de ce qu'il
//                    ne pourrait pas lire en ligne (mêmes règles que search_grep)
//   côté conteneur   localIndex() : le grep et la relecture du toolkit sur ce
//                    fichier, avec la sémantique de search_grep / search_read
//
// Le fichier est dans l'image (knowledge.jsonl, à l'export) et se rafraîchit à
// chaque démarrage ou rechargement quand FounderOS répond.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fold, grepTypesFor, pgRegexToJs, type IndexRow, type SearchIndex } from "../harness/toolkit/grep.ts";

/** Ce qui s'embarque : la base de connaissances et les mémoires, pas les conversations ni le graphe. */
export const SNAPSHOT_TYPES = ["documents", "memory", "team"] as const;
const MAX_ROWS = 20_000;
const MAX_BYTES = 40 * 1024 * 1024;
const PAGE = 1000;

export type SnapshotRow = Omit<IndexRow, "score"> & { created_at: string };

const COLUMNS = "id, type, path, title, content, tags, meta, grp, source_table, source_id, updated_at, created_at, project_id, agent_id";

/** L'instantané de ce que l'agent peut lire, dans la limite de MAX_ROWS lignes et MAX_BYTES. */
export async function knowledgeSnapshot(admin: SupabaseClient, scope: {
  workspaceId: string; projectId: string; agentId: string;
  /** Les outils de l'agent (après ses pools) : un type n'est embarqué que s'il le lit déjà. */
  tools: string[];
  /** null : tous les documents du projet ; [] : aucun ; sinon ces collections. */
  collections: string[] | null;
}): Promise<{ rows: SnapshotRow[]; truncated: boolean }> {
  const types = grepTypesFor(scope.tools).filter((t) => (SNAPSHOT_TYPES as readonly string[]).includes(t));
  const rows: SnapshotRow[] = [];
  let bytes = 0;
  let truncated = false;
  const visible = (r: Record<string, unknown>) =>
    (r.project_id == null || r.project_id === scope.projectId) && (r.agent_id == null || r.agent_id === scope.agentId);

  const pull = async (type: string, collections: string[] | null) => {
    for (let from = 0; !truncated; from += PAGE) {
      let q = admin.from("search_index").select(COLUMNS).eq("workspace_id", scope.workspaceId).eq("type", type);
      if (collections) q = q.in("collection_id", collections);
      const { data, error } = await q.order("id").range(from, from + PAGE - 1);
      if (error) throw new Error(`instantané (${type}) : ${error.message}`);
      const page = (data ?? []) as Array<Record<string, unknown>>;
      for (const r of page) {
        if (!visible(r)) continue;
        const { project_id: _p, agent_id: _a, ...row } = r;
        const size = String(row.content ?? "").length + String(row.title ?? "").length + 200;
        if (rows.length >= MAX_ROWS || bytes + size > MAX_BYTES) { truncated = true; break; }
        bytes += size;
        rows.push(row as unknown as SnapshotRow);
      }
      if (page.length < PAGE) break;
    }
  };
  for (const type of types) {
    if (type === "documents") {
      if (scope.collections && !scope.collections.length) continue;
      await pull(type, scope.collections);
    } else {
      await pull(type, null);
    }
  }
  return { rows, truncated };
}

export const toJsonl = (rows: SnapshotRow[]) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

export function fromJsonl(text: string): SnapshotRow[] {
  const out: SnapshotRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as SnapshotRow); } catch { /* une ligne abîmée ne bloque pas le reste */ }
  }
  return out;
}

/** Un motif LIKE (globToLike) en expression régulière ancrée. */
function likeToRegExp(like: string): RegExp {
  let src = "";
  for (let i = 0; i < like.length; i++) {
    const c = like[i];
    if (c === "\\" && i + 1 < like.length) { src += like[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    src += c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}$`, "s");
}

/** Le grep et la relecture du toolkit sur l'instantané, comme search_grep et search_read en base. */
export function localIndex(rows: SnapshotRow[]): SearchIndex {
  const indexed = rows.map((r) => ({ r, doc: fold(`${r.title ?? ""}\n${r.content}`), title: fold(r.title ?? "") }));
  const time = (s: string) => Date.parse(s) || 0;
  const asIndexRow = (r: SnapshotRow, score: number): IndexRow => {
    const { created_at: _c, ...rest } = r;
    return { ...rest, score };
  };
  return {
    async grep(p) {
      const res = (p.regexes ?? []).flatMap((pg) => {
        try { return [new RegExp(pgRegexToJs(pg), "u")]; } catch { return []; }
      });
      if (!res.length) return [];
      const path = p.path ? likeToRegExp(p.path) : null;
      const types = new Set(p.types ?? []);
      const hits: Array<{ r: SnapshotRow; score: number }> = [];
      for (const x of indexed) {
        if (!types.has(x.r.type) || (path && !path.test(x.r.path))) continue;
        const found = res.filter((re) => re.test(x.doc)).length;
        if (p.all ? found < res.length : found === 0) continue;
        hits.push({ r: x.r, score: found + (res.some((re) => re.test(x.title)) ? 1 : 0) });
      }
      hits.sort((a, b) => b.score - a.score || time(b.r.updated_at) - time(a.r.updated_at));
      const limit = Math.max(1, Math.min(p.limit ?? 50, 500));
      const offset = Math.max(0, p.offset ?? 0);
      return hits.slice(offset, offset + limit).map((h) => asIndexRow(h.r, h.score));
    },
    async read(ids, whole) {
      const wanted = new Set(ids);
      const groups = new Set(rows.filter((r) => wanted.has(r.id)).map((r) => r.grp));
      return rows
        .filter((r) => wanted.has(r.id) || (whole && groups.has(r.grp)))
        .sort((a, b) => a.grp.localeCompare(b.grp) || time(a.created_at) - time(b.created_at) || a.id.localeCompare(b.id))
        .slice(0, 60)
        .map((r) => asIndexRow(r, 0));
    },
  };
}

/** L'instantané d'un agent d'après son manifeste (ses outils et ses collections, après ses pools). */
export const snapshotFor = (admin: SupabaseClient, m: {
  agent: { id: string; workspace_id: string; project_id: string };
  tools: string[];
  knowledge: { collections: string[] | null };
}) => knowledgeSnapshot(admin, {
  workspaceId: m.agent.workspace_id, projectId: m.agent.project_id, agentId: m.agent.id,
  tools: m.tools, collections: m.knowledge.collections,
});
