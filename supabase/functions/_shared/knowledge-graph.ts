// Knowledge graph — the workspace's shared, named knowledge (migration 0289).
//
// Every agent of a workspace reads and writes the same graph:
//
//   READ   searchKnowledge — one RPC (knowledge_search): exact name / alias,
//          trigram, full text over names, summaries and live facts; a vector
//          pass only when the lexical one comes back thin. Fast enough to call
//          BEFORE asking a human or a peer something the space may already know.
//
//   WRITE  curateKnowledge — never a raw insert. Candidates (from the agent's
//          knowledge_save, or extracted from a finished run by the curator)
//          go through a DECISION MODEL that sees what the graph already holds
//          about those names and decides, item by item:
//            · is it significant, durable and useful to someone else later?
//            · is it the same thing as an existing entity (merge, add alias)?
//            · does it restate a known fact (skip) or replace one (supersede)?
//          Secrets never reach the model's decision: they are dropped first.
//
// Naming is the point of the exercise: one entity per real thing, under its
// canonical name, with every other spelling as an alias — so "Acme", "ACME
// SAS" and "acme sas" are one node an agent finds whichever it types.

import { callAi, safeParseJson } from "./ai.ts";
import { embedTexts, toVectorLiteral } from "./jina.ts";
import type { createServiceClient } from "./supabase-admin.ts";

type Admin = ReturnType<typeof createServiceClient>;

export const ENTITY_KINDS = [
  "person", "organization", "customer", "product", "project", "system",
  "document", "process", "decision", "place", "event", "concept",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const FACT_KINDS = ["fact", "decision", "procedure", "metric", "preference", "event", "risk", "contact"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

// ---------------------------------------------------------------------------
// Naming — must fold exactly like public.knowledge_key() in SQL.
// ---------------------------------------------------------------------------

const FROM = "àâäáãåçéèêëíìîïñóòôöõúùûüýÿœæ";
const TO = "aaaaaaceeeeiiiinooooouuuuyyoa";

export function entityKey(name: string): string {
  let s = String(name ?? "").toLowerCase();
  s = [...s].map((c) => { const i = FROM.indexOf(c); return i >= 0 ? TO[i] : c; }).join("");
  return s.replace(/[^a-z0-9]+/g, " ").trim();
}

/** "Travaille pour" / "works-for" / "dépend de" → travaille_pour, works_for, depend_de. */
export function relationName(raw: string): string | null {
  const s = entityKey(raw).replace(/ /g, "_").slice(0, 60);
  return /^[a-z0-9_]{2,60}$/.test(s) ? s : null;
}

const asKind = (k: unknown): EntityKind => (ENTITY_KINDS as readonly string[]).includes(String(k)) ? k as EntityKind : "concept";
const asFactKind = (k: unknown): FactKind => (FACT_KINDS as readonly string[]).includes(String(k)) ? k as FactKind : "fact";
const clean = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const clampImp = (v: unknown) => Math.min(5, Math.max(1, Math.round(Number(v) || 3)));

/** Anything that reads like a credential or a payment number. Dropped before
 *  the decision model ever sees it: the graph is read by every agent of the
 *  space, and some of them post to Slack. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(password|passwd|mot de passe|mdp|secret|api[_ -]?key|token)\s*[:=]\s*\S{4,}/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /\b(?:\d[ -]?){13,19}\b/,
  /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/,
];
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text ?? ""));
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface KnowledgeHit {
  id: string; name: string; kind: string; summary: string | null; aliases: string[];
  importance: number; updated_at: string; score: number;
  facts: Array<{ id: string; statement: string; kind: string; date: string }>;
  relations: Array<{ relation: string; other: string; direction: "out" | "in" }>;
}

async function tryEmbed(text: string, task: "retrieval.query" | "retrieval.passage", scope: Record<string, unknown>): Promise<number[] | null> {
  try {
    const [v] = await embedTexts([text.slice(0, 1000)], task, scope as never);
    return Array.isArray(v) && v.length ? v : null;
  } catch {
    return null;
  }
}

export async function searchKnowledge(admin: Admin, workspaceId: string, query: string, opts: {
  kind?: string | null; limit?: number; facts?: number; agentId?: string | null; runId?: string | null;
} = {}): Promise<KnowledgeHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 20);
  const kind = opts.kind && (ENTITY_KINDS as readonly string[]).includes(opts.kind) ? opts.kind : null;
  const run = async (embedding: number[] | null) => {
    const { data } = await admin.rpc("knowledge_search", {
      p_workspace: workspaceId, p_query: query, p_kind: kind, p_limit: limit,
      p_embedding: embedding ? toVectorLiteral(embedding) : null,
    });
    return (data ?? []) as Array<Omit<KnowledgeHit, "facts" | "relations">>;
  };
  let rows = await run(null);
  // The vector pass costs an embedding call: only when words were not enough.
  if (rows.length < Math.min(3, limit) && entityKey(query)) {
    const v = await tryEmbed(query, "retrieval.query", { workspace_id: workspaceId, agent_id: opts.agentId ?? null, run_id: opts.runId ?? null, feature: "knowledge-search" });
    if (v) {
      const seen = new Set(rows.map((r) => r.id));
      rows = [...rows, ...(await run(v)).filter((r) => !seen.has(r.id))].slice(0, limit);
    }
  }
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const perEntity = opts.facts ?? 6;
  const [{ data: facts }, { data: outRel }, { data: inRel }] = await Promise.all([
    admin.from("knowledge_facts").select("id, entity_id, statement, kind, importance, updated_at")
      .in("entity_id", ids).is("superseded_by", null)
      .order("importance", { ascending: false }).order("updated_at", { ascending: false }).limit(perEntity * ids.length),
    admin.from("knowledge_relations").select("from_entity, relation, to:knowledge_entities!knowledge_relations_to_entity_fkey(name)")
      .in("from_entity", ids).limit(80),
    admin.from("knowledge_relations").select("to_entity, relation, from:knowledge_entities!knowledge_relations_from_entity_fkey(name)")
      .in("to_entity", ids).limit(80),
  ]);
  const one = <T,>(v: T | T[] | null | undefined): T | null => Array.isArray(v) ? v[0] ?? null : v ?? null;
  return rows.map((r) => ({
    ...r,
    facts: ((facts ?? []) as Array<{ id: string; entity_id: string; statement: string; kind: string; updated_at: string }>)
      .filter((f) => f.entity_id === r.id).slice(0, perEntity)
      .map((f) => ({ id: f.id, statement: f.statement, kind: f.kind, date: f.updated_at.slice(0, 10) })),
    relations: [
      ...((outRel ?? []) as Array<{ from_entity: string; relation: string; to: { name: string } | { name: string }[] | null }>)
        .filter((x) => x.from_entity === r.id && one(x.to))
        .map((x) => ({ relation: x.relation, other: one(x.to)!.name, direction: "out" as const })),
      ...((inRel ?? []) as Array<{ to_entity: string; relation: string; from: { name: string } | { name: string }[] | null }>)
        .filter((x) => x.to_entity === r.id && one(x.from))
        .map((x) => ({ relation: x.relation, other: one(x.from)!.name, direction: "in" as const })),
    ].slice(0, 12),
  }));
}

/** The hits as the agent reads them: compact, one entity per block. */
export function renderKnowledgeHits(hits: KnowledgeHit[]): string {
  if (!hits.length) return "";
  return hits.map((h) => {
    const head = `■ ${h.name} [${h.kind}]${h.aliases.length ? ` (aussi : ${h.aliases.slice(0, 4).join(", ")})` : ""}`;
    const lines = [head];
    if (h.summary) lines.push(`  ${h.summary}`);
    for (const f of h.facts) lines.push(`  - ${f.statement} (${f.date})`);
    for (const r of h.relations) lines.push(r.direction === "out" ? `  → ${r.relation} → ${r.other}` : `  ← ${r.other} ${r.relation}`);
    return lines.join("\n");
  }).join("\n\n");
}

// ---------------------------------------------------------------------------
// Write — the decision model
// ---------------------------------------------------------------------------

export interface CandidateEntity {
  name: string;
  kind?: string;
  summary?: string | null;
  aliases?: string[];
  facts?: Array<{ statement: string; kind?: string; importance?: number } | string>;
}
export interface CandidateRelation { from: string; relation: string; to: string; note?: string | null }
export interface KnowledgeCandidates { entities: CandidateEntity[]; relations?: CandidateRelation[] }

export interface CurateInput {
  workspaceId: string;
  projectId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  source: "agent" | "curator" | "backfill";
  /** Explicit candidates (knowledge_save) … */
  candidates?: KnowledgeCandidates;
  /** … or raw text to extract them from (end of run, backfill). */
  text?: string;
  /** What the run was about — helps the extractor tell signal from chatter. */
  context?: string;
}

export interface CurateResult {
  entities: { created: string[]; merged: string[] };
  facts: { saved: number; superseded: number; skipped: number };
  relations: number;
  notes: string[];
}

const today = () => new Date().toISOString().slice(0, 10);

const EXTRACT_SYSTEM = [
  "Tu lis le résultat du travail d'un agent IA et tu en extrais la connaissance qui mérite d'entrer dans le graphe de connaissances PARTAGÉ de l'entreprise.",
  "Sois très sélectif : n'extrais que ce qu'un autre agent ou un collègue aurait intérêt à retrouver plus tard — faits stables sur des personnes, clients, produits, systèmes, projets ; décisions et leurs raisons ; procédures qui ont marché ; chiffres clés datés ; contacts ; risques.",
  "N'extrais PAS : l'état d'avancement de la tâche, ce que l'agent a fait ou va faire, les politesses, les hypothèses, les généralités connues de tous, les secrets.",
  "Chaque entité porte son nom complet et officiel. Chaque fait est une phrase autoportante qui nomme l'entité, datée si elle peut changer.",
  "Relations : un verbe en snake_case (travaille_pour, client_de, depend_de, responsable_de, utilise, fait_partie_de, remplace, decide_par).",
  `Types d'entité : ${ENTITY_KINDS.join(", ")}. Types de fait : ${FACT_KINDS.join(", ")}.`,
  "Au plus 8 entités. Si rien ne mérite d'être gardé, renvoie {\"entities\":[],\"relations\":[]} — c'est la réponse la plus fréquente.",
  "JSON strict : {\"entities\":[{\"name\":\"…\",\"kind\":\"…\",\"summary\":\"…\"|null,\"aliases\":[],\"facts\":[{\"statement\":\"…\",\"kind\":\"fact\",\"importance\":3}]}],\"relations\":[{\"from\":\"…\",\"relation\":\"…\",\"to\":\"…\"}]}",
].join("\n");

const GATE_SYSTEM = [
  "Tu es le modèle de décision du graphe de connaissances partagé d'un espace de travail. Des agents proposent d'y écrire ; tu décides ce qui entre, et sous quel nom.",
  "",
  "Pour chaque ENTITÉ candidate :",
  "- \"merge\" si elle désigne la même chose qu'une entité existante (même sous une autre écriture) : donne existing_id, et mets l'autre écriture dans aliases.",
  "- \"create\" si elle est nouvelle ET qu'au moins un de ses faits mérite d'être gardé, ou qu'elle est un nœud utile d'une relation.",
  "- \"skip\" sinon.",
  "Nomme-la par son nom canonique : complet, officiel, casse correcte (« Acme SAS », « Marie Dupont », « API de facturation »). summary : une phrase qui dit ce qu'elle est, ou null pour garder l'existant.",
  "",
  "Pour chaque FAIT :",
  "- \"save\" s'il est significatif, durable et utile à quelqu'un d'autre plus tard.",
  "- \"supersede\" s'il remplace un fait existant devenu faux ou périmé : donne son id dans supersedes.",
  "- \"skip\" s'il est trivial, transitoire (avancement d'une tâche, intention), spéculatif, déjà connu (même sens qu'un fait existant), une généralité, ou sensible (secret, donnée personnelle sensible).",
  "Réécris statement si besoin : autoportant, nomme l'entité, daté s'il peut changer, 300 caractères max.",
  "",
  "Pour chaque RELATION : \"save\" si elle relie deux entités gardées et dit quelque chose d'utile, sinon \"skip\". relation en snake_case.",
  "",
  "En cas de doute, skip : un graphe bruité ne sert plus à personne.",
  "JSON strict : {\"entities\":[{\"i\":0,\"decision\":\"create|merge|skip\",\"existing_id\":null,\"name\":\"…\",\"kind\":\"…\",\"summary\":null,\"aliases\":[],\"importance\":3,\"facts\":[{\"j\":0,\"decision\":\"save|supersede|skip\",\"supersedes\":null,\"statement\":\"…\",\"kind\":\"fact\",\"importance\":3}]}],\"relations\":[{\"k\":0,\"decision\":\"save|skip\",\"relation\":\"…\"}]}",
].join("\n");

interface GateEntity {
  i: number; decision: "create" | "merge" | "skip"; existing_id?: string | null; name?: string; kind?: string;
  summary?: string | null; aliases?: string[]; importance?: number;
  facts?: Array<{ j: number; decision: "save" | "supersede" | "skip"; supersedes?: string | null; statement?: string; kind?: string; importance?: number }>;
}

function normalizeCandidates(c: KnowledgeCandidates): KnowledgeCandidates {
  const entities = (c.entities ?? []).slice(0, 12).map((e) => ({
    name: clean(e.name, 160),
    kind: asKind(e.kind),
    summary: e.summary ? clean(e.summary, 400) : null,
    aliases: (e.aliases ?? []).map((a) => clean(a, 160)).filter(Boolean).slice(0, 8),
    facts: (e.facts ?? []).slice(0, 10)
      .map((f) => typeof f === "string" ? { statement: f } : f)
      .map((f) => ({ statement: clean(f.statement, 600), kind: asFactKind(f.kind), importance: clampImp(f.importance) }))
      .filter((f) => f.statement && !looksSecret(f.statement)),
  })).filter((e) => entityKey(e.name) && !looksSecret(e.name) && !(e.summary && looksSecret(e.summary)));
  const relations = (c.relations ?? []).slice(0, 20)
    .map((r) => ({ from: clean(r.from, 160), relation: clean(r.relation, 60), to: clean(r.to, 160), note: r.note ? clean(r.note, 300) : null }))
    .filter((r) => r.from && r.to && relationName(r.relation) && entityKey(r.from) !== entityKey(r.to));
  return { entities, relations };
}

async function extractCandidates(text: string, context: string | undefined): Promise<KnowledgeCandidates> {
  const res = await callAi({
    task: "json_extraction", jsonMode: true, temperature: 0, maxTokens: 1500,
    systemPrompt: `${EXTRACT_SYSTEM}\nDate du jour : ${today()}.`,
    userPrompt: [context ? `Contexte de la tâche :\n${context.slice(0, 1500)}\n` : "", "Résultat de l'agent :", text.slice(0, 9000)].join("\n"),
  });
  const parsed = safeParseJson<KnowledgeCandidates>(res.content);
  return parsed && Array.isArray(parsed.entities) ? parsed : { entities: [], relations: [] };
}

/** What the graph already holds about these names — the gate decides against it. */
async function existingFor(admin: Admin, workspaceId: string, names: string[]) {
  const found = new Map<string, KnowledgeHit>();
  for (const n of [...new Set(names.map((x) => x.trim()).filter(Boolean))].slice(0, 16)) {
    const { data } = await admin.rpc("knowledge_search", { p_workspace: workspaceId, p_query: n, p_kind: null, p_limit: 3, p_embedding: null });
    for (const r of (data ?? []) as Array<{ id: string; score: number }>) {
      if (r.score >= 0.6 && !found.has(r.id)) found.set(r.id, r as unknown as KnowledgeHit);
    }
  }
  if (!found.size) return [] as KnowledgeHit[];
  const ids = [...found.keys()];
  const { data: facts } = await admin.from("knowledge_facts").select("id, entity_id, statement, kind, updated_at")
    .in("entity_id", ids).is("superseded_by", null).order("updated_at", { ascending: false }).limit(12 * ids.length);
  return ids.map((id) => ({
    ...found.get(id)!,
    facts: ((facts ?? []) as Array<{ id: string; entity_id: string; statement: string; kind: string; updated_at: string }>)
      .filter((f) => f.entity_id === id).slice(0, 12)
      .map((f) => ({ id: f.id, statement: f.statement, kind: f.kind, date: f.updated_at.slice(0, 10) })),
    relations: [],
  }));
}

async function gate(cands: KnowledgeCandidates, existing: KnowledgeHit[]) {
  const res = await callAi({
    task: "classification", jsonMode: true, temperature: 0, maxTokens: 2000,
    systemPrompt: `${GATE_SYSTEM}\nDate du jour : ${today()}.`,
    userPrompt: [
      "Ce que le graphe contient déjà sur ces noms :",
      existing.length
        ? existing.map((e) => [
          `[${e.id}] ${e.name} (${e.kind})${e.aliases?.length ? ` — alias : ${e.aliases.join(", ")}` : ""}${e.summary ? ` — ${e.summary}` : ""}`,
          ...e.facts.map((f) => `   fait [${f.id}] ${f.statement}`),
        ].join("\n")).join("\n")
        : "(rien)",
      "",
      "Candidats proposés :",
      JSON.stringify({
        entities: cands.entities.map((e, i) => ({ i, ...e, facts: (e.facts ?? []).map((f, j) => ({ j, ...(f as object) })) })),
        relations: (cands.relations ?? []).map((r, k) => ({ k, ...r })),
      }),
    ].join("\n"),
  });
  return safeParseJson<{ entities?: GateEntity[]; relations?: Array<{ k: number; decision: string; relation?: string }> }>(res.content);
}

export async function curateKnowledge(admin: Admin, input: CurateInput): Promise<CurateResult> {
  const out: CurateResult = { entities: { created: [], merged: [] }, facts: { saved: 0, superseded: 0, skipped: 0 }, relations: 0, notes: [] };

  let raw = input.candidates;
  if (!raw && input.text?.trim()) raw = await extractCandidates(input.text, input.context);
  if (!raw) return out;
  const cands = normalizeCandidates(raw);
  if (!cands.entities.length) { out.notes.push("rien de significatif à enregistrer"); return out; }

  const names = cands.entities.flatMap((e) => [e.name, ...(e.aliases ?? [])]);
  const existing = await existingFor(admin, input.workspaceId, names);
  const existingIds = new Set(existing.map((e) => e.id));
  const existingFactIds = new Set(existing.flatMap((e) => e.facts.map((f) => f.id)));

  const verdict = await gate(cands, existing);
  if (!verdict?.entities) { out.notes.push("le modèle de décision n'a pas répondu"); return out; }

  // Candidate index → entity id kept in the graph, for the relations below.
  const idOf = new Map<number, string>();
  const idByKey = new Map<string, string>(existing.map((e) => [entityKey(e.name), e.id]));
  for (const e of existing) for (const a of e.aliases ?? []) idByKey.set(entityKey(a), e.id);

  for (const d of verdict.entities) {
    const cand = cands.entities[d.i];
    if (!cand) continue;
    const facts = (d.facts ?? []).filter((f) => f.decision !== "skip");
    out.facts.skipped += (cand.facts?.length ?? 0) - facts.length;
    if (d.decision === "skip") continue;

    const name = clean(d.name || cand.name, 160);
    const kind = asKind(d.kind ?? cand.kind);
    const aliases = [...new Set([...(cand.aliases ?? []), ...(d.aliases ?? []), cand.name]
      .map((a) => clean(a, 160)).filter((a) => a && entityKey(a) !== entityKey(name)))].slice(0, 12);
    const summary = d.summary ? clean(d.summary, 400) : null;

    let entityId: string | null = null;
    // Merge: into the entity the gate named — only one it was actually shown —
    // or, failing that, whatever already sits under this canonical key.
    const target = d.decision === "merge" && d.existing_id && existingIds.has(d.existing_id) ? d.existing_id : null;
    const byKey = target ?? idByKey.get(entityKey(name)) ?? await (async () => {
      const { data } = await admin.from("knowledge_entities").select("id")
        .eq("workspace_id", input.workspaceId).eq("key", entityKey(name)).maybeSingle();
      return (data as { id: string } | null)?.id ?? null;
    })();

    if (byKey) {
      const { data: cur } = await admin.from("knowledge_entities").select("id, name, aliases, summary, importance, mentions").eq("id", byKey).maybeSingle();
      if (cur) {
        const c = cur as { id: string; name: string; aliases: string[]; summary: string | null; importance: number; mentions: number };
        const merged = [...new Set([...(c.aliases ?? []), ...aliases, ...(entityKey(name) !== entityKey(c.name) ? [name] : [])])]
          .filter((a) => entityKey(a) !== entityKey(c.name)).slice(0, 24);
        await admin.from("knowledge_entities").update({
          aliases: merged,
          summary: summary ?? c.summary,
          importance: Math.max(c.importance, clampImp(d.importance)),
          mentions: (c.mentions ?? 0) + 1,
        }).eq("id", c.id);
        entityId = c.id;
        out.entities.merged.push(c.name);
      }
    }
    if (!entityId) {
      const { data: ins, error } = await admin.from("knowledge_entities").insert({
        workspace_id: input.workspaceId, project_id: input.projectId ?? null,
        name, key: entityKey(name), kind, summary, aliases, importance: clampImp(d.importance),
        created_by_agent: input.agentId ?? null,
      }).select("id").single();
      if (error || !ins) {
        // Lost a race on (workspace_id, key): someone created it a moment ago.
        const { data } = await admin.from("knowledge_entities").select("id")
          .eq("workspace_id", input.workspaceId).eq("key", entityKey(name)).maybeSingle();
        entityId = (data as { id: string } | null)?.id ?? null;
        if (entityId) out.entities.merged.push(name);
      } else {
        entityId = (ins as { id: string }).id;
        out.entities.created.push(name);
        const v = await tryEmbed(`${name} — ${summary ?? kind}`, "retrieval.passage", { workspace_id: input.workspaceId, agent_id: input.agentId ?? null, feature: "knowledge-entity" });
        if (v) await admin.from("knowledge_entities").update({ embedding: toVectorLiteral(v) }).eq("id", entityId);
      }
    }
    if (!entityId) continue;
    idOf.set(d.i, entityId);
    idByKey.set(entityKey(name), entityId);
    for (const a of aliases) idByKey.set(entityKey(a), entityId);

    for (const f of facts) {
      const c = cand.facts?.[f.j] as { statement: string; kind?: string; importance?: number } | undefined;
      const statement = clean(f.statement || c?.statement, 600);
      if (!statement || looksSecret(statement)) { out.facts.skipped++; continue; }
      const { data: fi } = await admin.from("knowledge_facts").upsert({
        workspace_id: input.workspaceId, entity_id: entityId, key: entityKey(statement).slice(0, 300), statement,
        kind: asFactKind(f.kind ?? c?.kind), importance: clampImp(f.importance ?? c?.importance),
        source_kind: input.source, source_agent_id: input.agentId ?? null, source_run_id: input.runId ?? null,
      }, { onConflict: "entity_id,key", ignoreDuplicates: true }).select("id");
      const newId = (fi as Array<{ id: string }> | null)?.[0]?.id;
      if (!newId) { out.facts.skipped++; continue; }
      out.facts.saved++;
      if (f.decision === "supersede" && f.supersedes && existingFactIds.has(f.supersedes)) {
        await admin.from("knowledge_facts").update({ superseded_by: newId }).eq("id", f.supersedes);
        out.facts.superseded++;
      }
    }
  }

  // Relations: both ends must be in the graph — kept above, or already there.
  const keepRel = new Map((verdict.relations ?? []).map((r) => [r.k, r]));
  for (const [k, r] of (cands.relations ?? []).entries()) {
    const v = keepRel.get(k);
    if (!v || v.decision !== "save") continue;
    const rel = relationName(v.relation || r.relation);
    const resolve = async (n: string) => {
      const ci = cands.entities.findIndex((e) => entityKey(e.name) === entityKey(n) || (e.aliases ?? []).some((a) => entityKey(a) === entityKey(n)));
      if (ci >= 0 && idOf.has(ci)) return idOf.get(ci)!;
      if (idByKey.has(entityKey(n))) return idByKey.get(entityKey(n))!;
      const { data } = await admin.from("knowledge_entities").select("id").eq("workspace_id", input.workspaceId).eq("key", entityKey(n)).maybeSingle();
      return (data as { id: string } | null)?.id ?? null;
    };
    const [a, b] = [await resolve(r.from), await resolve(r.to)];
    if (!rel || !a || !b || a === b) continue;
    const { data } = await admin.from("knowledge_relations").upsert({
      workspace_id: input.workspaceId, from_entity: a, to_entity: b, relation: rel, note: r.note ?? null,
      source_agent_id: input.agentId ?? null,
    }, { onConflict: "from_entity,relation,to_entity", ignoreDuplicates: true }).select("id");
    if ((data as unknown[] | null)?.length) out.relations++;
  }
  return out;
}

export function describeCurate(r: CurateResult): string {
  const parts: string[] = [];
  if (r.entities.created.length) parts.push(`créé ${r.entities.created.map((n) => `« ${n} »`).join(", ")}`);
  if (r.entities.merged.length) parts.push(`complété ${r.entities.merged.map((n) => `« ${n} »`).join(", ")}`);
  if (r.facts.saved) parts.push(`${r.facts.saved} fait(s) enregistré(s)${r.facts.superseded ? ` dont ${r.facts.superseded} en remplacement` : ""}`);
  if (r.relations) parts.push(`${r.relations} relation(s)`);
  if (r.facts.skipped) parts.push(`${r.facts.skipped} écarté(s) par le modèle de décision (trivial, transitoire, déjà connu ou sensible)`);
  if (!parts.length) return `Rien d'enregistré${r.notes.length ? ` : ${r.notes.join(" ; ")}` : " — le modèle de décision n'a rien jugé assez significatif"}.`;
  return `Graphe de connaissances : ${parts.join(" ; ")}.`;
}

/** End of a run: let the curator decide whether anything in it deserves the
 *  shared graph. Detached — a run never waits on, or fails because of, it. */
export function captureKnowledgeInBackground(admin: Admin, input: Omit<CurateInput, "source" | "candidates">): void {
  const text = String(input.text ?? "").trim();
  // Short replies ("c'est fait", a question back) carry no knowledge worth an
  // extraction call.
  if (text.length < 280) return;
  const job = curateKnowledge(admin, { ...input, source: "curator" })
    .catch((e) => console.error("knowledge capture failed", e));
  const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(job);
}
