// La mémoire des recherches d'un run (ancien moteur, run-tool-hooks.ts) :
//
//   avant une recherche  - la même requête déjà faite dans ce run : refusée, ses
//                          résultats sont déjà dans le contexte ;
//                        - un sujet recherché récemment dans le projet (mémoire
//                          proche et datée de moins de 14 jours) : servi depuis
//                          la mémoire, sans appel web ; relancer la même requête
//                          part alors sur le web ;
//   après une recherche  - ce que la mémoire sait déjà du sujet est joint en tête
//                          des résultats web (trois fois par run au plus) ;
//                        - chaque trouvaille utile est notée sur le run
//                          (événement « log », relu par build_context, type findings) ;
//   à la fin du run      - les trouvailles (deux au moins) deviennent UNE mémoire
//                          de contexte : la prochaine mission sur le sujet part de là.
//
// Les outils arrivent ici sous leur ancien nom (web_search, read_url…) : le
// toolkit traduit les appels regroupés avant de les exécuter.

import type { SupabaseClient } from "@supabase/supabase-js";
import { embedTexts, embeddingsAvailable, toVectorLiteral } from "../edge/_shared/jina.ts";
import { RELEVANCE_FLOOR } from "../edge/_shared/agent-memory.ts";
import { touchAgentMemories, writeAgentMemory } from "../edge/_shared/internal-agent-tools.ts";

type Admin = SupabaseClient;

const SEARCH_TOOLS = new Set(["web_search", "deep_research", "search_knowledge", "search_memory", "search_past_work"]);
const RESEARCH_TOOLS = new Set(["web_search", "deep_research", "read_url", "http_get", "search_knowledge"]);
const MEMORY_ANSWER_MIN_SIM = 0.62;
const MEMORY_ANSWER_MAX_AGE_DAYS = 14;

type KnownHit = { id: string; content: string; created_at?: string | null; similarity: number | null };

export interface Finding { tool: string; label: string; text: string }

interface ResearchState {
  admin: Admin;
  runId: string;
  agentId: string;
  projectId: string | null;
  workspaceId: string;
  searchSigs: Map<string, number>;
  servedFromMemory: Set<string>;
  probedIds: Set<string>;
  probes: number;
  findings: Finding[];
  known: Map<string, Promise<KnownHit[]>>;
}

const states = new Map<string, ResearchState>();

/** La signature d'une recherche : l'outil et les mots de la requête, triés (l'ordre ne compte pas). */
export function querySig(name: string, args: Record<string, unknown>): string | null {
  if (!SEARCH_TOOLS.has(name)) return null;
  const q = String(args.query ?? args.q ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  // Les mots de liaison (de, la, et…) ne font pas une autre recherche.
  const words = [...new Set(q.split(/[^a-z0-9]+/).filter((w) => w.length > 2))].sort();
  return words.length ? `${name}:${words.join(" ")}` : null;
}

export function researchFor(run: { runId: string; agentId: string; projectId: string | null; workspaceId: string }, admin: Admin): ResearchState {
  let s = states.get(run.runId);
  if (!s) {
    s = {
      admin, runId: run.runId, agentId: run.agentId, projectId: run.projectId, workspaceId: run.workspaceId,
      searchSigs: new Map(), servedFromMemory: new Set(), probedIds: new Set(), probes: 0, findings: [], known: new Map(),
    };
    states.set(run.runId, s);
    while (states.size > 64) states.delete(states.keys().next().value as string);
  }
  return s;
}

const event = (s: ResearchState, kind: string, payload: Record<string, unknown>) =>
  s.admin.from("internal_agent_run_events").insert({ run_id: s.runId, agent_id: s.agentId, kind, payload }).then(() => {}, () => {});

/** Ce que la mémoire du projet sait d'un sujet : sémantique si possible, sinon par mots. */
function recallKnown(s: ResearchState, query: string): Promise<KnownHit[]> {
  const key = query.trim().toLowerCase();
  if (!s.known.has(key)) s.known.set(key, (async () => {
    try {
      if (embeddingsAvailable() && s.projectId) {
        const [qvec] = await embedTexts([query.slice(0, 500)], "retrieval.query").catch(() => [null]);
        if (qvec) {
          const { data } = await s.admin.rpc("match_project_memories", {
            p_project_id: s.projectId, p_query_embedding: toVectorLiteral(qvec), p_match_count: 5,
          });
          const sem = ((data ?? []) as KnownHit[])
            .map((m) => ({ ...m, similarity: Number(m.similarity ?? 0) }))
            .filter((m) => (m.similarity ?? 0) >= Math.max(RELEVANCE_FLOOR, 0.45));
          if (sem.length) return sem;
        }
      }
      const { data } = await s.admin.from("internal_agent_memories").select("id, content, created_at")
        .eq("project_id", s.projectId).in("kind", ["context", "learning", "fact"])
        .order("created_at", { ascending: false }).limit(60);
      const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      return ((data ?? []) as KnownHit[])
        .filter((m) => terms.filter((t) => String(m.content ?? "").toLowerCase().includes(t)).length >= 2)
        .map((m) => ({ ...m, similarity: null }));
    } catch {
      return [];
    }
  })());
  return s.known.get(key)!;
}

const knownLine = (h: KnownHit) => `- ${h.created_at ? `(${String(h.created_at).slice(0, 10)}) ` : ""}${String(h.content).slice(0, 700)}`;

/** Avant un appel : une réponse qui le remplace (doublon, réponse de la mémoire), ou null. */
export async function beforeTool(s: ResearchState, name: string, args: Record<string, unknown>): Promise<string | null> {
  const sig = querySig(name, args);
  if (!sig) return null;
  const seen = (s.searchSigs.get(sig) ?? 0) + 1;
  s.searchSigs.set(sig, seen);
  if (seen > 1 && !s.servedFromMemory.has(sig)) {
    return `ERROR: recherche déjà effectuée dans ce run (${seen}× « ${String(args.query ?? "")} »). Ses résultats sont DÉJÀ dans ton contexte : les relancer ne donnera rien de neuf. ` +
      `Tu as lancé ${s.searchSigs.size} recherches distinctes. Passe à l'exploitation : lis les pages les plus prometteuses (outil web, action read) pour en extraire les chiffres. ` +
      "Si une donnée reste introuvable après lecture, écris « non publié » et avance ; ne reformule pas la même requête.";
  }
  if ((name === "web_search" || name === "deep_research") && !s.servedFromMemory.has(sig) && s.servedFromMemory.size < 3) {
    const fresh = (await recallKnown(s, String(args.query ?? ""))).filter((h) =>
      h.similarity != null && h.similarity >= MEMORY_ANSWER_MIN_SIM && !s.probedIds.has(h.id) &&
      (!h.created_at || Date.now() - Date.parse(h.created_at) <= MEMORY_ANSWER_MAX_AGE_DAYS * 86_400_000),
    ).slice(0, 3);
    if (fresh.length) {
      // La même requête relancée part alors sur le web (le doublon ne la refuse pas).
      s.servedFromMemory.add(sig);
      s.searchSigs.set(sig, seen - 1);
      for (const h of fresh) s.probedIds.add(h.id);
      touchAgentMemories(s.admin as never, fresh.map((h) => h.id));
      await event(s, "status", { message: "Recherche servie depuis la mémoire du projet : appel web économisé." });
      return `⚡ RÉPONDU DEPUIS LA MÉMOIRE (aucune recherche web lancée : ce sujet a déjà été recherché récemment dans ce projet) :\n${fresh.map(knownLine).join("\n")}\n\n` +
        "Si c'est suffisant, utilise-le directement. Si c'est insuffisant ou périmé, relance EXACTEMENT la même requête : elle partira alors sur le web.";
    }
  }
  return null;
}

/** Après un appel : la trouvaille notée, et ce que la mémoire sait déjà joint aux résultats web. */
export async function afterTool(s: ResearchState, name: string, args: Record<string, unknown>, result: string): Promise<string> {
  if (!RESEARCH_TOOLS.has(name) || result.length <= 80 || /^\s*ERROR\b/.test(result)) return result;
  const label = String(args.query ?? args.url ?? args.q ?? "").slice(0, 200) || name;
  const text = result.slice(0, 12_000);
  s.findings.push({ tool: name, label, text });
  await event(s, "log", { finding: { tool: name, label, text } });
  if ((name === "web_search" || name === "deep_research") && s.probes < 3 && String(args.query ?? "").trim()) {
    s.probes++;
    const hits = (await recallKnown(s, String(args.query))).filter((h) => !s.probedIds.has(h.id)).slice(0, 3);
    if (hits.length) {
      for (const h of hits) s.probedIds.add(h.id);
      touchAgentMemories(s.admin as never, hits.map((h) => h.id));
      await event(s, "status", { message: `${hits.length} élément(s) déjà en mémoire sur ce sujet : joints aux résultats.` });
      return `⚡ DÉJÀ EN MÉMOIRE (travail antérieur sur ce sujet : vérifie la date, réutilise plutôt que de rechercher) :\n${hits.map(knownLine).join("\n")}\n\n— Résultats web ci-dessous —\n${result}`;
    }
  }
  return result;
}

/**
 * La fin du run : ses trouvailles (deux au moins, hors échecs) deviennent UNE
 * mémoire de contexte, fusionnée avec la précédente sur le même sujet. Puis
 * l'état du run est oublié.
 */
export async function persistFindings(runId: string): Promise<void> {
  const s = states.get(runId);
  states.delete(runId);
  if (!s) return;
  const useful = s.findings.filter((f) => f.text.trim() && !/^\s*ERROR\b/i.test(f.text));
  if (useful.length < 2) return;
  try {
    const subjects = [...new Set(useful.map((f) => f.label.trim()).filter(Boolean))];
    const subject = subjects.slice(0, 4).join(" ; ").slice(0, 240) || (useful[0]?.label ?? "");
    const digest = useful.slice(0, 12).map((f) => `• [${f.label}] ${f.text.replace(/\s+/g, " ").slice(0, 320)}`).join("\n");
    const content = `[Recherche — ${subject} · ${new Date().toISOString().slice(0, 10)}]\n${digest}`.slice(0, 4000);
    const res = await writeAgentMemory(s.admin as never, {
      workspace_id: s.workspaceId, project_id: s.projectId, agent_id: s.agentId, kind: "context", importance: 3,
      source_run_id: runId, content,
    } as never);
    const status = (res as { status?: string } | null)?.status;
    if (status === "inserted" || status === "merged") {
      await event(s, "status", {
        message: `${useful.length} collecte(s) ${status === "merged" ? "fusionnées avec la veille précédente" : "versées"} en mémoire permanente : une prochaine mission sur « ${subjects[0] ?? subject} » les retrouvera sans rechercher.`,
      });
    }
  } catch { /* la mémoire est un bonus, jamais un blocage */ }
}

/** Oublie l'état d'un run sans rien enregistrer (échec, annulation). */
export const dropResearch = (runId: string) => { states.delete(runId); };
