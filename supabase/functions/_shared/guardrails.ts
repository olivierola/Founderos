// Runtime enforcement of aiops_guardrails.
//
// Guardrails are the safety/behaviour rules configured in Governance → Guardrails
// (title, category, enforcement block/warn/log, free-markdown body). A guardrail
// becomes ENFORCEABLE when it carries a `match_pattern` regex + a `match_scope`
// (which surface it is tested against). Guardrails without a pattern are
// documentation-only and are never evaluated here.
//
// Enforcement semantics (applied by the caller):
//   - block  → the offending action must NOT happen (tool call not executed, or
//              the run refused) — the model gets a clear reason back.
//   - warn   → recorded on the run timeline; the action still happens.
//   - log    → recorded only (quietest).
//
// Best-effort by design: a guardrail misconfiguration must never take down the
// agent loop — failures to load are treated as "no guardrails".

import { createServiceClient } from "./supabase-admin.ts";
import { judge, noul, readNoul, qid, type JudgeContext } from "./typesafe.ts";

export type GuardrailScope = "prompt" | "tool_call" | "tool_result" | "all";
export type GuardrailEnforcement = "block" | "warn" | "log";

export interface GuardrailRow {
  id: string;
  title: string;
  category: string;
  enforcement: GuardrailEnforcement;
  enabled: boolean;
  match_pattern: string | null;
  match_scope: GuardrailScope;
  /** Le texte de la règle, écrit en français dans la Gouvernance. Inutile à
   *  l'expression régulière, indispensable au jugement sémantique : une règle
   *  jugée sur son seul titre est une règle devinée. */
  body: string;
}

export interface GuardrailViolation {
  guardrailId: string;
  title: string;
  category: string;
  enforcement: GuardrailEnforcement;
  scope: GuardrailScope;
  /** The matched snippet, capped. */
  matched: string;
}

/** Load the enforceable guardrails of a workspace/project (enabled + pattern). */
export async function loadGuardrails(
  admin: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  projectId: string,
  /** PolicyGuard (0259) : l'équipe (dashboard de service) de l'agent et sa
   *  surface. Une règle sans équipe vaut pour toutes ; une règle sans surface
   *  vaut pour les deux. Absent = toutes les règles, comme avant. */
  scope?: { teamId?: string | null; surface?: "internal" | "public" },
): Promise<GuardrailRow[]> {
  try {
    const base = "id, title, category, enforcement, enabled, match_pattern, match_scope, body";
    const query = (cols: string) => admin
      .from("aiops_guardrails")
      .select(cols)
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId)
      .eq("enabled", true);
    // Les colonnes de portée n'existent qu'après 0259 : une base en retard ne
    // doit pas perdre TOUS ses garde-fous pour une colonne manquante.
    let res = await query(`${base}, team_ids, surfaces`);
    if (res.error) res = await query(base);
    const all = (res.data ?? []) as Array<Partial<GuardrailRow> & { team_ids?: string[] | null; surfaces?: string[] | null }>;
    const rows = all.filter((r) => {
      if (!scope) return true;
      const teams = Array.isArray(r.team_ids) ? r.team_ids : [];
      const surfaces = Array.isArray(r.surfaces) ? r.surfaces : [];
      if (teams.length && (!scope.teamId || !teams.includes(scope.teamId))) return false;
      if (surfaces.length && scope.surface && !surfaces.includes(scope.surface)) return false;
      return true;
    });
    // ⚠️ Les règles SANS expression régulière sont désormais chargées elles
    // aussi. Elles restent inertes pour `checkGuardrails` (qui ne sait tester
    // qu'un motif), et ne deviennent applicables que si le jugement sémantique
    // est allumé. C'est ce qui rend enfin exécutable ce qui était écrit en
    // français dans la Gouvernance et n'y servait que de documentation.
    return rows
      .map((r) => ({
        id: String(r.id ?? ""),
        title: String(r.title ?? ""),
        category: String(r.category ?? ""),
        enforcement: (r.enforcement as GuardrailEnforcement) ?? "warn",
        enabled: true,
        match_pattern: r.match_pattern ?? null,
        match_scope: (r.match_scope as GuardrailScope) ?? "all",
        body: String(r.body ?? ""),
      }));
  } catch {
    return [];
  }
}

/** Les règles applicables par une expression régulière — le chemin historique,
 *  inchangé. */
export const patternRules = (rows: GuardrailRow[]): GuardrailRow[] =>
  rows.filter((g) => typeof g.match_pattern === "string" && g.match_pattern.trim().length > 0);

/** Does this guardrail target the given scope? */
function appliesTo(scope: GuardrailScope, g: GuardrailRow): boolean {
  return g.match_scope === "all" || g.match_scope === scope;
}

/**
 * Test every loaded guardrail against a piece of traffic. Returns the violations
 * (guardrails whose pattern matched), in order. Empty when nothing matched.
 * A bad pattern never throws — it is skipped.
 */
export function checkGuardrails(
  rows: GuardrailRow[],
  scope: GuardrailScope,
  text: string,
): GuardrailViolation[] {
  if (rows.length === 0 || !text) return [];
  const out: GuardrailViolation[] = [];
  for (const g of rows) {
    // Sans motif, rien à tester ici : c'est le jugement sémantique qui s'en
    // charge, ou personne.
    if (!appliesTo(scope, g) || !g.match_pattern) continue;
    try {
      const re = new RegExp(g.match_pattern, "i");
      const m = text.match(re);
      if (m) {
        out.push({
          guardrailId: g.id,
          title: g.title,
          category: g.category,
          enforcement: g.enforcement,
          scope,
          matched: String(m[0] ?? "").slice(0, 120),
        });
      }
    } catch { /* malformed regex → skip this guardrail */ }
  }
  return out;
}

/** Most restrictive enforcement among a set of violations (block > warn > log). */
export function strongestEnforcement(v: GuardrailViolation[]): GuardrailEnforcement | null {
  if (v.length === 0) return null;
  if (v.some((x) => x.enforcement === "block")) return "block";
  if (v.some((x) => x.enforcement === "warn")) return "warn";
  return "log";
}


// ── Le jugement sémantique ───────────────────────────────────────────────────
//
// Une règle de gouvernance s'écrit en français — « ne jamais promettre un délai
// de livraison », « ne pas donner de conseil médical ». Jusqu'ici, la seule
// façon de la rendre APPLICABLE était de lui trouver une expression régulière,
// ce qui marche pour un numéro de carte et pour rien qui demande de comprendre.
// Toutes les autres étaient chargées, affichées, et jamais évaluées.
//
// Ici, chaque règle devient un `noul` : « ce texte enfreint-il cette règle ? ».
// Une seule requête porte toute la batterie — c'est ce qui rend la chose
// tenable sur chaque appel d'outil.
//
// Deux garde-fous sur le garde-fou :
//   • on ne BLOQUE qu'au-dessus du seuil réglé (0,75 par défaut) ; entre 0,45 et
//     le seuil, la violation est rapportée avec l'application la plus faible
//     (`warn`) même si la règle dit `block` — une probabilité moyenne ne doit
//     pas couper la parole à un agent ;
//   • en mode `shadow`, rien n'est rendu : le jugement est journalisé et le
//     comportement d'avant tient.

/** En dessous, on ne rapporte rien : le modèle dit simplement « non ». */
const REPORT_FLOOR = 0.45;

export async function judgeGuardrails(
  ctx: JudgeContext,
  rows: GuardrailRow[],
  scope: GuardrailScope,
  text: string,
): Promise<GuardrailViolation[]> {
  const candidates = rows.filter((g) => appliesTo(scope, g) && (g.title || "").trim());
  if (candidates.length === 0 || !text.trim()) return [];

  // 255 options maximum côté modèle, et une batterie trop large dilue l'état :
  // au-delà, on garde les règles les plus strictes d'abord.
  const battery = candidates
    .sort((a, b) => rank(b.enforcement) - rank(a.enforcement))
    .slice(0, 24);

  const byQid = new Map<string, GuardrailRow>();
  const questions: Record<string, ReturnType<typeof noul>> = {};
  for (const g of battery) {
    const id = uniqueQid(byQid, g);
    byQid.set(id, g);
    const rule = g.body.replace(/\s+/g, " ").trim().slice(0, 900);
    questions[id] = noul(
      // L'énoncé porte la règle ENTIÈRE, pas son intitulé. La documentation le
      // dit sans détour : le modèle répond à la question qu'on a écrite, pas à
      // celle qu'on avait en tête — « Règle : Ton commercial » ne veut rien
      // dire, « ne jamais promettre une date de livraison » se juge.
      {
        regle: g.title,
        categorie: g.category || "règle interne",
        enonce: rule || g.title,
        question: "Le texte de l'état enfreint-il cette règle ?",
      },
      {
        true: { what: `Le texte enfreint : ${rule || g.title}` },
        false: { what: "Le texte respecte la règle, ou n'a rien à voir avec elle." },
      },
    );
  }

  const verdict = await judge(
    ctx, "guardrails",
    { scope, text: text.slice(0, 6000) },
    questions,
    { subject: `${scope} · ${battery.length} règle(s)` },
  );
  if (!verdict?.apply) return [];

  const out: GuardrailViolation[] = [];
  for (const [id, g] of byQid) {
    const p = readNoul(verdict, id);
    if (p === null || p < REPORT_FLOOR) continue;
    out.push({
      guardrailId: g.id,
      title: g.title,
      category: g.category,
      // Une probabilité moyenne ne bloque pas, quelle que soit la règle : on
      // rapporte, on trace, et l'action passe.
      enforcement: p >= verdict.threshold ? g.enforcement : weakest(g.enforcement),
      scope,
      matched: `jugé contraire (p=${p.toFixed(2)})`,
    });
  }
  return out.sort((a, b) => rank(b.enforcement) - rank(a.enforcement));
}

/** Les deux passes réunies, une ligne par règle. Une règle qui a un motif ET
 *  qui est jugée contraire ne doit pas être rapportée deux fois — on garde
 *  l'application la plus forte, et la preuve la plus concrète (le motif trouvé
 *  vaut mieux qu'une probabilité pour expliquer un blocage). */
export function mergeViolations(...lists: GuardrailViolation[][]): GuardrailViolation[] {
  const byId = new Map<string, GuardrailViolation>();
  for (const v of lists.flat()) {
    const seen = byId.get(v.guardrailId);
    if (!seen) { byId.set(v.guardrailId, v); continue; }
    byId.set(v.guardrailId, {
      ...seen,
      enforcement: rank(v.enforcement) > rank(seen.enforcement) ? v.enforcement : seen.enforcement,
      matched: seen.matched.startsWith("jugé contraire") ? v.matched : seen.matched,
    });
  }
  return [...byId.values()].sort((a, b) => rank(b.enforcement) - rank(a.enforcement));
}

const rank = (e: GuardrailEnforcement): number => (e === "block" ? 2 : e === "warn" ? 1 : 0);
const weakest = (e: GuardrailEnforcement): GuardrailEnforcement => (e === "block" ? "warn" : e);

/** Deux règles peuvent porter le même titre ; leurs questions, non. */
function uniqueQid(taken: Map<string, GuardrailRow>, g: GuardrailRow): string {
  const base = qid(g.title) || "regle";
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  return id;
}
