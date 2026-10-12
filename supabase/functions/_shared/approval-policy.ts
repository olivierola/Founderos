// Règles d'approbation (G3, migration 0281).
//
// PolicyGuard (policyguard.ts) décide S'IL faut une approbation. Une règle dit
// QUI approuve, COMBIEN de personnes et en COMBIEN de temps, pour une portée :
// type de connexion, connexion, environnement, risque, opérations.
//
//   Serveur MCP     : le serveur décide de demander (OPA) ; la règle fixe les
//                     approbateurs. Sans règle : DEFAULT_MCP_POLICY, le
//                     comportement d'avant (SCIC inchangé).
//   Outil interne   : la règle peut aussi IMPOSER l'approbation (FounderOS
//                     exécute l'appel). Sans règle : rien ne change.
//
// La règle trouvée est COPIÉE sur la demande (approvalColumns) : la modifier
// ensuite ne change pas une demande en cours. Les votes, le quorum et les
// quatre yeux sont tenus ici (gateApprovalVote) et, en dernier ressort, par la
// base (0281).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { IdpError } from "./idp-tokens.ts";
import { PRD_APPROVER_ROLE, type IdpIdentity, type McpApprovalRow } from "./mcp-approval.ts";

export type ConnectionKind = "mcp" | "custom_connector";
export type ActionRisk = "read" | "write" | "destructive";
export type ConnectionEnvironment = "development" | "staging" | "production";

export interface ApprovalPolicy {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  connection_kind: ConnectionKind | null;
  connection_id: string | null;
  environment: ConnectionEnvironment | null;
  min_risk: "write" | "destructive";
  operations: string[];
  approver_roles: string[];
  approver_idp_roles: string[];
  quorum: number;
  ttl_minutes: number;
  /** 0284 : connexion SSO de moins de N minutes exigée pour voter (null : non). */
  fresh_login_minutes?: number | null;
  created_at?: string;
}

export interface ApproverRule {
  /** Rôles FounderOS dans l'espace : owner, admin, member. */
  roles: string[];
  /** Rôles ou groupes de l'IdP. */
  idp_roles: string[];
  /** 0284 : connexion SSO de moins de N minutes exigée pour voter. */
  fresh_login_minutes?: number | null;
}

export interface ResolvedPolicy {
  policyId: string | null;
  name: string;
  rule: ApproverRule;
  quorum: number;
  ttlMinutes: number;
  source: "policy" | "default";
}

/** Sans règle, une action en production demandée par un serveur MCP : comme avant G3. */
export const DEFAULT_MCP_POLICY: ResolvedPolicy = {
  policyId: null,
  name: `Par défaut : rôle ${PRD_APPROVER_ROLE}`,
  rule: { roles: [], idp_roles: [PRD_APPROVER_ROLE] },
  quorum: 1,
  ttlMinutes: 15,
  source: "default",
};

const RISK_RANK: Record<ActionRisk, number> = { read: 0, write: 1, destructive: 2 };

export interface ApprovalScope {
  kind: ConnectionKind;
  connectionId: string;
  environment: string | null | undefined;
  risk: ActionRisk;
  operation: string;
}

/** Plus une règle nomme de choses, plus elle est précise. */
function specificity(p: ApprovalPolicy): number {
  return (p.connection_id ? 8 : 0) + (p.connection_kind ? 4 : 0) + (p.environment ? 2 : 0) + (p.operations.length ? 1 : 0);
}

export function policyMatches(p: ApprovalPolicy, s: ApprovalScope): boolean {
  if (!p.enabled) return false;
  if (p.connection_kind && p.connection_kind !== s.kind) return false;
  if (p.connection_id && p.connection_id !== s.connectionId) return false;
  // Une règle de production ne s'applique qu'à une connexion déclarée en production.
  if (p.environment && p.environment !== s.environment) return false;
  if (RISK_RANK[s.risk] < RISK_RANK[p.min_risk]) return false;
  if (p.operations.length && !p.operations.includes(s.operation)) return false;
  return true;
}

/** La règle qui s'applique : la plus petite priorité, puis la plus précise, puis la plus ancienne. */
export function matchApprovalPolicy(policies: ApprovalPolicy[], s: ApprovalScope): ApprovalPolicy | null {
  const hits = policies.filter((p) => policyMatches(p, s));
  hits.sort((a, b) => a.priority - b.priority || specificity(b) - specificity(a)
    || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  return hits[0] ?? null;
}

export function toResolved(p: ApprovalPolicy): ResolvedPolicy {
  return {
    policyId: p.id, name: p.name,
    rule: {
      roles: [...p.approver_roles], idp_roles: [...p.approver_idp_roles],
      ...(p.fresh_login_minutes ? { fresh_login_minutes: p.fresh_login_minutes } : {}),
    },
    quorum: p.quorum, ttlMinutes: p.ttl_minutes, source: "policy",
  };
}

/**
 * La règle d'une action. MCP : la règle trouvée, sinon DEFAULT_MCP_POLICY.
 * Outil interne : la règle trouvée, sinon null (rien ne change).
 * Une base injoignable rend le défaut (MCP) ou null : jamais moins d'approbation.
 */
export async function resolveApprovalPolicy(admin: SupabaseClient, workspaceId: string, s: ApprovalScope): Promise<ResolvedPolicy | null> {
  let policies: ApprovalPolicy[] = [];
  try {
    const { data } = await admin.from("approval_policies")
      .select("id, name, enabled, priority, connection_kind, connection_id, environment, min_risk, operations, approver_roles, approver_idp_roles, quorum, ttl_minutes, fresh_login_minutes, created_at")
      .eq("workspace_id", workspaceId).eq("enabled", true);
    policies = (data ?? []) as ApprovalPolicy[];
  } catch { /* table absente : pas de règle */ }
  const hit = matchApprovalPolicy(policies, s);
  if (hit) return toResolved(hit);
  return s.kind === "mcp" ? DEFAULT_MCP_POLICY : null;
}

const ROLE_LABEL: Record<string, string> = { owner: "propriétaire", admin: "admin", member: "membre" };

/** « 2 approbateurs : groupe Ops » — pour l'agent, la notification et l'écran. */
export function describeApprovers(p: { rule: ApproverRule; quorum: number }): string {
  const who = [
    ...p.rule.roles.map((r) => ROLE_LABEL[r] ?? r),
    ...p.rule.idp_roles.map((r) => `« ${r} »`),
  ].join(" ou ");
  return `${p.quorum} approbateur${p.quorum > 1 ? "s distincts" : ""} : ${who}`;
}

/** Les colonnes que la demande garde de sa règle (0281). */
export function approvalColumns(p: ResolvedPolicy, environment: string | null | undefined, now = Date.now()) {
  return {
    quorum: p.quorum,
    approver_rule: p.rule,
    policy_id: p.policyId,
    policy_name: p.name,
    environment: environment === "development" || environment === "staging" || environment === "production" ? environment : null,
    expires_at: new Date(now + p.ttlMinutes * 60_000).toISOString(),
  };
}

export function isEligibleApprover(rule: ApproverRule, who: { workspaceRole: string | null; idpRoles: string[] }): boolean {
  if (who.workspaceRole && rule.roles.includes(who.workspaceRole)) return true;
  return who.idpRoles.some((r) => rule.idp_roles.includes(r));
}

export interface PolicyApprovalRow extends McpApprovalRow {
  quorum: number;
  approver_rule: ApproverRule;
  policy_name?: string | null;
  environment?: string | null;
}

export type VoteGate =
  | { ok: true; approver: IdpIdentity | null }
  | { ok: false; status: number; error: string; expired?: boolean };

/**
 * Une décision sur une demande soumise à une règle. Pure : l'identité, le rôle
 * dans l'espace et les votes déjà posés sont fournis par l'appelant.
 *   - approuver : un approbateur de la règle (rôle FounderOS, ou rôle ou groupe
 *     de l'IdP dans un jeton frais), ni le demandeur ni sous son identité, une
 *     voix par personne, avant l'échéance, une action à la fois ;
 *   - refuser : le demandeur (il retire sa demande) ou un approbateur (veto).
 */
export async function gateApprovalVote(
  row: PolicyApprovalRow,
  input: {
    userId: string;
    decision: "approve" | "approve_all" | "reject";
    now?: number;
    identity: () => Promise<IdpIdentity>;
    /** Le rôle de la personne dans l'espace de la demande ; null : pas membre. */
    workspaceRole: () => Promise<string | null>;
    alreadyVoted: () => Promise<boolean>;
    /** La dernière connexion SSO de la personne dans cette organisation (0284). */
    lastSsoLoginAt?: () => Promise<string | null>;
  },
): Promise<VoteGate> {
  if (row.status !== "pending") return { ok: false, status: 409, error: `Demande déjà traitée (${row.status}).` };
  const now = input.now ?? Date.now();
  if (!row.expires_at || Date.parse(row.expires_at) <= now) {
    return { ok: false, status: 409, error: "Demande expirée : l'agent doit refaire sa demande.", expired: true };
  }
  if (input.decision === "approve_all") {
    return { ok: false, status: 400, error: "Une action soumise à une règle d'approbation s'approuve une par une." };
  }
  const isRequester = !!row.requested_by && row.requested_by === input.userId;
  if (input.decision === "reject" && isRequester) return { ok: true, approver: null };
  if (input.decision === "approve" && isRequester) {
    return { ok: false, status: 403, error: "Règle des quatre yeux : vous ne pouvez pas approuver une action demandée en votre nom." };
  }
  const role = await input.workspaceRole();
  if (!role) return { ok: false, status: 403, error: "Vous n'êtes pas membre de l'espace de cette demande." };
  let identity: IdpIdentity;
  try {
    identity = await input.identity();
  } catch (err) {
    const detail = err instanceof IdpError ? err.message : "identité illisible";
    return { ok: false, status: 403, error: `Décision impossible sans session SSO valide : ${detail}` };
  }
  if (!isEligibleApprover(row.approver_rule, { workspaceRole: role, idpRoles: identity.roles })) {
    return { ok: false, status: 403, error: `Cette demande est réservée à ${describeApprovers({ rule: row.approver_rule, quorum: row.quorum })}.` };
  }
  if (input.decision === "approve" && identity.sub === String(row.payload?.requester_sub ?? "")) {
    return { ok: false, status: 403, error: "Règle des quatre yeux : votre identité est celle du demandeur." };
  }
  if (input.decision === "approve" && await input.alreadyVoted()) {
    return { ok: false, status: 409, error: "Vous avez déjà approuvé cette demande : il faut un autre approbateur." };
  }
  // Groupes relus à la connexion : une règle peut exiger qu'elle soit récente.
  // Un départ dans l'IdP empêche alors de voter, même avec une session ouverte.
  const fresh = row.approver_rule.fresh_login_minutes;
  if (input.decision === "approve" && fresh) {
    const last = input.lastSsoLoginAt ? await input.lastSsoLoginAt() : null;
    if (!last || now - Date.parse(last) > fresh * 60_000) {
      return {
        ok: false, status: 403,
        error: `Cette règle exige une connexion SSO de moins de ${fresh} min pour voter (dernière : ${last ? `il y a ${Math.round((now - Date.parse(last)) / 60_000)} min` : "aucune"}). Déconnectez-vous, reconnectez-vous par le SSO, puis votez.`,
      };
    }
  }
  return { ok: true, approver: identity };
}
