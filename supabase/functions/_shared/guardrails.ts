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
): Promise<GuardrailRow[]> {
  try {
    const { data } = await admin
      .from("aiops_guardrails")
      .select("id, title, category, enforcement, enabled, match_pattern, match_scope")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId)
      .eq("enabled", true);
    const rows = (data ?? []) as Partial<GuardrailRow>[];
    return rows
      .filter((r) => typeof r.match_pattern === "string" && (r.match_pattern as string).trim().length > 0)
      .map((r) => ({
        id: String(r.id ?? ""),
        title: String(r.title ?? ""),
        category: String(r.category ?? ""),
        enforcement: (r.enforcement as GuardrailEnforcement) ?? "warn",
        enabled: true,
        match_pattern: r.match_pattern ?? null,
        match_scope: (r.match_scope as GuardrailScope) ?? "all",
      }));
  } catch {
    return [];
  }
}

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
