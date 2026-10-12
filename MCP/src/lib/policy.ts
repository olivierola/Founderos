// Décision d'autorisation avant chaque appel : OPA (policies/ai_tools.rego), ou
// l'évaluateur intégré qui applique les mêmes règles — pour les tests et le
// développement local, jamais par défaut.
//
// OPA injoignable ou réponse inattendue : refus. Un moteur de politique en panne
// ne doit pas ouvrir les vannes.

import type { Catalog, Cluster } from "./catalog.ts";
import { requestJson } from "./http.ts";

export type Decision = "allow" | "deny" | "approval_required";

export interface PolicyInput {
  tool: string;
  cluster: Cluster;
  target_cluster: Cluster;
  params_hash: string;
  token: { sub: string; azp: string; scopes: string[]; roles: string[] };
  approval?: { id: string; tool: string; target_cluster: string; params_hash: string; approver: string; approvers?: string[] };
}

export interface PolicyResult {
  decision: Decision;
  reason: string;
}

export interface PolicyEngine {
  decide(input: PolicyInput): Promise<PolicyResult>;
}

export class OpaPolicyEngine implements PolicyEngine {
  constructor(private readonly url: string, private readonly caFile?: string) {}

  async decide(input: PolicyInput): Promise<PolicyResult> {
    try {
      const res = await requestJson<{ result?: { decision?: string; reason?: string } }>(
        `${this.url.replace(/\/$/, "")}/v1/data/ai/tools`,
        { method: "POST", json: { input }, caFile: this.caFile, timeoutMs: 3000 },
      );
      const decision = res?.result?.decision;
      if (decision === "allow" || decision === "deny" || decision === "approval_required") {
        return { decision, reason: res.result?.reason ?? decision };
      }
      return { decision: "deny", reason: "opa_invalid_response" };
    } catch {
      return { decision: "deny", reason: "opa_unavailable" };
    }
  }
}

/** Mêmes règles que policies/ai_tools.rego ; tests croisés dans test/policy.test.ts. */
export class BuiltinPolicyEngine implements PolicyEngine {
  constructor(private readonly catalog: Catalog) {}

  async decide(input: PolicyInput): Promise<PolicyResult> {
    const c = this.catalog;
    const scope = c.scopes[input.tool];
    if (!scope || !(c.tools[input.cluster] ?? []).includes(input.tool)) return { decision: "deny", reason: "not_in_catalog" };
    if (!input.token.scopes.includes(scope)) return { decision: "deny", reason: "scope_missing" };
    if (!input.token.roles.some((r) => (c.role_scopes[r] ?? []).includes(scope))) return { decision: "deny", reason: "role_missing" };

    const gated = (c.approval_required[input.target_cluster] ?? []).includes(input.tool);
    const a = input.approval;
    const approvers = a ? [...new Set(a.approvers ?? [a.approver])] : [];
    const quorum = c.approval_quorum?.[input.target_cluster] ?? 1;
    const validApproval = !!a
      && a.tool === input.tool
      && a.target_cluster === input.target_cluster
      && a.params_hash === input.params_hash
      && a.approver !== input.token.sub
      && !approvers.includes(input.token.sub)
      && approvers.length >= quorum;
    if (gated && !validApproval) return { decision: "approval_required", reason: "approval_required" };
    return { decision: "allow", reason: "ok" };
  }
}
