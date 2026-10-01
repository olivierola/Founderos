// PolicyGuard — ce qu'un agent a le droit de faire seul, par équipe et par
// environnement, et la trace de chaque décision.
//
// Avant : sept endroits du runtime décidaient chacun « faut-il une
// approbation ? » avec la même règle — une écriture connue, sauf si l'agent est
// en autopilote. Conséquence : un agent en autopilote pouvait payer, supprimer
// ou écrire à un client sans que personne ne le voie, et rien ne distinguait
// l'équipe Finance de l'équipe Marketing, ni une conversation où quelqu'un
// regarde d'une mission planifiée qui tourne la nuit.
//
// PolicyGuard ajoute, AU-DESSUS de ces règles (jamais à leur place) :
//
//   1. un NIVEAU DE RISQUE par action (Jev, usage `policy_guard`) :
//        0 lecture · 1 écriture interne réversible · 2 effet visible par un
//        tiers ou difficile à défaire · 3 irréversible ou engageant
//      Le niveau ne descend jamais sous ce que la liste statique sait déjà :
//      une écriture connue vaut au moins 1.
//   2. une GRILLE par équipe (dashboard de service) et par environnement
//      (interactif = quelqu'un est dans la conversation ; autonome = mission,
//      planification, room) : à partir de quel niveau on demande, à partir de
//      quel niveau on refuse, et jusqu'où l'autopilote dispense d'approbation.
//   3. un JOURNAL (`policy_decisions`) : l'action, son niveau, la règle
//      appliquée, la décision, et l'approbation humaine qui en a découlé.
//
// Invariant, hérité de `isRiskyAction` : PolicyGuard ne RETIRE jamais une
// approbation. Si l'ancienne règle demandait, on demande.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { judge, score, readScore } from "./typesafe.ts";

type Admin = SupabaseClient;

export type RiskLevel = 0 | 1 | 2 | 3;
export type Environment = "interactive" | "autonomous";
export type PolicyDecision = "allow" | "approve" | "block";

export const RISK_LABEL: Record<RiskLevel, string> = {
  0: "lecture",
  1: "écriture interne réversible",
  2: "effet visible par un tiers",
  3: "irréversible ou engageant",
};

/** La grille d'un environnement. `null` = jamais. */
export interface EnvPolicy {
  /** Niveau à partir duquel une approbation est demandée. */
  approve_at: RiskLevel | null;
  /** Niveau à partir duquel l'action est refusée. */
  block_at: RiskLevel | null;
}

export interface TeamPolicy {
  interactive: EnvPolicy;
  autonomous: EnvPolicy;
  /** L'autopilote dispense d'approbation JUSQU'À ce niveau exclu : au-delà,
   *  même un agent en autopilote demande. 4 = l'autopilote dispense de tout
   *  (le comportement d'avant). */
  autopilot_ceiling: RiskLevel | 4;
}

/** La grille par défaut — celle qu'on applique à une équipe sans réglage.
 *  Elle reproduit le comportement d'avant pour tout ce qui n'est pas
 *  irréversible, et ajoute UNE chose : même en autopilote, une action
 *  irréversible ou engageante demande une personne. */
export const DEFAULT_TEAM_POLICY: TeamPolicy = {
  interactive: { approve_at: 2, block_at: null },
  autonomous: { approve_at: 2, block_at: null },
  autopilot_ceiling: 3,
};

function normalizeEnv(raw: unknown, d: EnvPolicy): EnvPolicy {
  const r = (raw ?? {}) as Partial<EnvPolicy>;
  const lvl = (v: unknown, fb: RiskLevel | null): RiskLevel | null =>
    v === null ? null : [0, 1, 2, 3].includes(Number(v)) ? (Number(v) as RiskLevel) : fb;
  return { approve_at: lvl(r.approve_at, d.approve_at), block_at: lvl(r.block_at, d.block_at) };
}

export function normalizeTeamPolicy(raw: unknown): TeamPolicy {
  const r = (raw ?? {}) as Partial<TeamPolicy>;
  const ceiling = Number(r.autopilot_ceiling);
  return {
    interactive: normalizeEnv(r.interactive, DEFAULT_TEAM_POLICY.interactive),
    autonomous: normalizeEnv(r.autonomous, DEFAULT_TEAM_POLICY.autonomous),
    autopilot_ceiling: [0, 1, 2, 3, 4].includes(ceiling) ? (ceiling as RiskLevel | 4) : DEFAULT_TEAM_POLICY.autopilot_ceiling,
  };
}

/** La politique d'une équipe : sa ligne, sinon celle du projet (team NULL),
 *  sinon la grille par défaut. */
export async function loadTeamPolicy(
  admin: Admin, projectId: string, teamId: string | null | undefined,
): Promise<{ policy: TeamPolicy; source: "team" | "project" | "default" }> {
  try {
    const { data } = await admin.from("policyguard_policies")
      .select("service_dashboard_id, policy")
      .eq("project_id", projectId);
    const rows = (data ?? []) as Array<{ service_dashboard_id: string | null; policy: unknown }>;
    const team = teamId ? rows.find((r) => r.service_dashboard_id === teamId) : null;
    if (team) return { policy: normalizeTeamPolicy(team.policy), source: "team" };
    const project = rows.find((r) => r.service_dashboard_id === null);
    if (project) return { policy: normalizeTeamPolicy(project.policy), source: "project" };
  } catch { /* table absente : grille par défaut */ }
  return { policy: DEFAULT_TEAM_POLICY, source: "default" };
}

// ── Le niveau de risque ──────────────────────────────────────────────────────

// Quatre SITUATIONS, reconnaissables à ce qu'elles font dans le monde — pas
// « un peu risqué / très risqué », qui ne donne rien à comparer.
const RISK_LEVELS = [
  {
    summary: "Lecture : l'action consulte, cherche ou liste, et ne change rien nulle part.",
    signals: ["lister, récupérer, chercher, lire", "aucun paramètre de contenu à écrire"],
  },
  {
    summary: "Écriture interne réversible : elle modifie quelque chose chez nous, que personne d'extérieur ne voit, et qui se défait facilement.",
    signals: ["brouillon", "étiquette, statut, champ interne", "note, tâche, commentaire interne"],
  },
  {
    summary: "Effet visible par un tiers : un client, un partenaire ou le public va le voir, ou l'effet est pénible à rattraper.",
    signals: ["envoyer un e-mail ou un message à l'extérieur", "publier, inviter, partager", "créer un objet chez un client ou dans un outil partagé"],
  },
  {
    summary: "Irréversible ou engageant : de l'argent part, une donnée disparaît, un droit est accordé, ou l'entreprise s'engage.",
    signals: ["paiement, remboursement, virement", "suppression définitive", "donner ou retirer un accès", "signer, accepter un devis, promettre une remise"],
  },
];

/**
 * Le niveau de risque d'une action, ou `null` quand le jugement n'a pas tourné.
 * `floor` = ce que la liste statique sait déjà (1 pour une écriture connue) :
 * le résultat ne descend jamais en dessous.
 */
async function judgeRisk(
  ctx: { admin: Admin; workspaceId: string; projectId: string; runId?: string | null },
  tool: string, action: string, params: Record<string, unknown>,
): Promise<{ level: RiskLevel; confidence: number; applied: boolean; mode: "shadow" | "on" } | null> {
  let paramsText = "";
  try { paramsText = JSON.stringify(params ?? {}).slice(0, 1500); } catch { paramsText = ""; }
  const verdict = await judge(
    { admin: ctx.admin, workspaceId: ctx.workspaceId, projectId: ctx.projectId, runId: ctx.runId ?? null },
    "policy_guard",
    { outil: tool, action, parametres: paramsText },
    { risque: score("Que produit cette action dans le monde si elle s'exécute ?", RISK_LEVELS) },
    { subject: `${tool} · ${action}` },
  );
  const s = readScore(verdict, "risque");
  if (!verdict || !s) return null;
  const level = Math.min(3, Math.max(0, Math.round(s.score))) as RiskLevel;
  return { level, confidence: s.confidence, applied: verdict.apply, mode: verdict.mode === "on" ? "on" : "shadow" };
}

// ── La porte ─────────────────────────────────────────────────────────────────

const READ_ACTION_RE = /^(GET|LIST|FETCH|SEARCH|FIND|READ|RETRIEVE|QUERY|DESCRIBE|COUNT|LOOKUP|VIEW|SHOW|CHECK|PREVIEW)\b|\b(GET|LIST|FETCH|SEARCH|FIND|READ|RETRIEVE|QUERY|LOOKUP)\b/;
const normalizeAction = (a: string) => String(a ?? "").toUpperCase().replace(/[_.\-]+/g, " ").trim();

export interface GateContext {
  admin: Admin;
  workspaceId: string;
  projectId: string;
  agentId: string;
  runId: string | null;
  conversationId?: string | null;
  serviceDashboardId?: string | null;
  autopilot?: boolean;
}

export interface GateInput {
  tool: string;
  action: string;
  params: Record<string, unknown>;
  /** Ce que la règle d'origine décidait : approbation demandée ou non. */
  legacyApproval: boolean;
  /** La liste statique sait-elle que c'est une écriture ? (plancher de risque 1) */
  knownWrite: boolean;
}

export interface GateResult {
  decision: PolicyDecision;
  /** Phrase à rendre à l'agent en cas de refus. */
  message?: string;
  /** À appeler avec l'id de l'approbation créée, pour relier journal et validation. */
  linkApproval: (approvalId: string) => void;
}

/**
 * La décision pour une action. Ne lève jamais ; en cas de doute ou de panne,
 * rend la décision d'origine (`legacyApproval`).
 */
export async function policyGate(ctx: GateContext, input: GateInput): Promise<GateResult> {
  const legacy: PolicyDecision = input.legacyApproval ? "approve" : "allow";
  const env: Environment = ctx.conversationId ? "interactive" : "autonomous";
  // Une lecture évidente ne coûte ni appel ni ligne de journal : c'est la
  // majorité des appels d'outils, et leur niveau est connu d'avance.
  if (!input.legacyApproval && !input.knownWrite && READ_ACTION_RE.test(normalizeAction(input.action))) {
    return { decision: "allow", linkApproval: () => {} };
  }
  let decisionId: number | null = null;
  const pendingLink: string[] = [];
  const linkApproval = (approvalId: string) => {
    if (decisionId != null) {
      void ctx.admin.from("policy_decisions").update({ approval_id: approvalId }).eq("id", decisionId).then(() => {}, () => {});
    } else {
      pendingLink.push(approvalId);
    }
  };

  try {
    const risk = await judgeRisk(ctx, input.tool, input.action, input.params);
    if (!risk) return { decision: legacy, linkApproval };

    const floor: RiskLevel = input.knownWrite ? 1 : 0;
    const level = Math.max(risk.level, floor) as RiskLevel;
    const { policy, source } = await loadTeamPolicy(ctx.admin, ctx.projectId, ctx.serviceDashboardId);
    const grid = policy[env];

    let decision: PolicyDecision = legacy;
    const reasons: string[] = [];
    if (grid.block_at != null && level >= grid.block_at) {
      decision = "block";
      reasons.push(`niveau ${level} ≥ refus à ${grid.block_at} (${env === "interactive" ? "interactif" : "autonome"})`);
    } else {
      const wantsApproval = grid.approve_at != null && level >= grid.approve_at;
      // L'autopilote dispense d'approbation sous son plafond, et seulement là.
      const autopilotExempt = !!ctx.autopilot && level < policy.autopilot_ceiling;
      if (wantsApproval && !autopilotExempt) {
        decision = "approve";
        reasons.push(`niveau ${level} ≥ approbation à ${grid.approve_at}`);
      }
      if (ctx.autopilot && level >= policy.autopilot_ceiling && policy.autopilot_ceiling < 4) {
        decision = "approve";
        reasons.push(`autopilote plafonné sous le niveau ${policy.autopilot_ceiling}`);
      }
      // Jamais moins que la règle d'origine.
      if (legacy === "approve" && decision === "allow") {
        decision = "approve";
        reasons.push("règle d'origine");
      }
    }

    const final: PolicyDecision = risk.applied ? decision : legacy;
    const { data } = await ctx.admin.from("policy_decisions").insert({
      workspace_id: ctx.workspaceId,
      project_id: ctx.projectId,
      agent_id: ctx.agentId,
      service_dashboard_id: ctx.serviceDashboardId ?? null,
      run_id: ctx.runId,
      conversation_id: ctx.conversationId ?? null,
      environment: env,
      autopilot: !!ctx.autopilot,
      tool: input.tool.slice(0, 120),
      action: input.action.slice(0, 200),
      risk_level: level,
      risk_confidence: Number(risk.confidence.toFixed(3)),
      // Ce que PolicyGuard décide, et ce qui s'est appliqué — identiques en
      // mode on, différents en shadow : c'est la colonne qu'on lit avant de
      // basculer.
      decision,
      applied_decision: final,
      legacy_decision: legacy,
      policy_source: source,
      reason: reasons.join(" · ") || null,
      mode: risk.mode,
    }).select("id").maybeSingle();
    decisionId = (data as { id?: number } | null)?.id ?? null;
    for (const id of pendingLink.splice(0)) linkApproval(id);

    if (final === "block") {
      return {
        decision: "block",
        message:
          `⛔ Action refusée par la politique de l'équipe : ${input.tool} · ${input.action} est classée « ${RISK_LABEL[level]} » ` +
          `et ce niveau n'est pas autorisé ${env === "interactive" ? "en conversation" : "en autonomie"}. ` +
          "Ne la retente pas sous une autre forme : explique à l'utilisateur ce que tu voulais faire et laisse-le décider.",
        linkApproval,
      };
    }
    return { decision: final, linkApproval };
  } catch {
    return { decision: legacy, linkApproval };
  }
}

// ── Lecture pour les agents internes (outil policy_audit) ────────────────────

export async function policyAudit(
  admin: Admin, projectId: string, sinceDays: number,
): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const { data } = await admin.from("policy_decisions")
    .select("agent_id, service_dashboard_id, environment, autopilot, tool, action, risk_level, decision, applied_decision, legacy_decision, mode, reason, approval_id, created_at")
    .eq("project_id", projectId).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(5000);
  const rows = (data ?? []) as Array<{
    agent_id: string; service_dashboard_id: string | null; environment: string; autopilot: boolean;
    tool: string; action: string; risk_level: number; decision: string; applied_decision: string;
    legacy_decision: string; mode: string; reason: string | null; approval_id: string | null; created_at: string;
  }>;
  const approvalIds = rows.map((r) => r.approval_id).filter((x): x is string => !!x);
  const outcomes: Record<string, number> = {};
  if (approvalIds.length) {
    const { data: aps } = await admin.from("internal_agent_approvals")
      .select("id, status").in("id", approvalIds.slice(0, 1000));
    for (const a of (aps ?? []) as Array<{ status: string }>) outcomes[a.status] = (outcomes[a.status] ?? 0) + 1;
  }
  const count = (key: (r: typeof rows[number]) => string) => {
    const m: Record<string, number> = {};
    for (const r of rows) { const k = key(r); m[k] = (m[k] ?? 0) + 1; }
    return m;
  };
  return {
    period_days: sinceDays,
    actions_evaluated: rows.length,
    by_risk_level: count((r) => `${r.risk_level} — ${RISK_LABEL[r.risk_level as RiskLevel] ?? "?"}`),
    by_decision: count((r) => r.applied_decision),
    stricter_than_before: rows.filter((r) => r.decision !== r.legacy_decision && r.decision !== "allow").length,
    in_shadow_mode: rows.filter((r) => r.mode === "shadow").length,
    human_validations: outcomes,
    blocked: rows.filter((r) => r.applied_decision === "block").slice(0, 20)
      .map((r) => ({ tool: r.tool, action: r.action, level: r.risk_level, reason: r.reason, at: r.created_at })),
    autopilot_escalations: rows.filter((r) => r.autopilot && r.applied_decision === "approve").length,
  };
}
