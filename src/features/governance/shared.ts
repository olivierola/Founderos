// Shared types, data hooks, constants and helpers for the Governance module.
// Every entity is project-scoped and read/written directly against Supabase
// (see migration 0106_governance.sql). No edge functions are involved.
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAuth } from "@/lib/auth-context";

// ── Row types (mirror the SQL) ───────────────────────────────────────────────
export interface AiSystem {
  id: string; workspace_id: string; project_id: string;
  source: "internal_agent" | "external" | "manual";
  agent_id: string | null;
  name: string; description: string | null; purpose: string | null;
  owner_user_id: string | null; owner_name: string | null;
  model: string | null; provider: string | null;
  risk_tier: RiskTier; status: SystemStatus;
  data_sources: string[]; decision_logic: string | null; human_oversight: string | null;
  tags: string[]; last_review_at: string | null; next_review_at: string | null;
  created_at: string; updated_at: string;
}
export interface Risk {
  id: string; workspace_id: string; project_id: string; system_id: string | null;
  title: string; description: string | null; category: RiskCategory;
  likelihood: number; impact: number; mitigation: string | null;
  owner_name: string | null; status: RiskStatus; created_at: string;
}
export interface Policy {
  id: string; workspace_id: string; project_id: string;
  title: string; category: string | null; body: string | null;
  version: string; status: PolicyStatus; owner_name: string | null;
  effective_at: string | null; created_at: string;
}
export interface Control {
  id: string; workspace_id: string; project_id: string;
  framework: Framework; ref_code: string | null; title: string; description: string | null;
  status: ControlStatus; owner_name: string | null; system_id: string | null;
  evidence: string | null; created_at: string;
}
export interface Approval {
  id: string; workspace_id: string; project_id: string; system_id: string | null;
  title: string; description: string | null; kind: ApprovalKind;
  risk_tier: RiskTier | null; status: ApprovalStatus;
  requested_by_name: string | null; decided_by: string | null; decided_at: string | null;
  decision_note: string | null; created_at: string;
}
export interface Incident {
  id: string; workspace_id: string; project_id: string; system_id: string | null;
  title: string; description: string | null; category: IncidentCategory;
  severity: Severity; status: IncidentStatus;
  occurred_at: string; resolved_at: string | null; resolution: string | null; created_at: string;
}
export interface DataAsset {
  id: string; workspace_id: string; project_id: string;
  name: string; description: string | null; source: string | null;
  classification: Classification; contains_pii: boolean; lawful_basis: string | null;
  owner_name: string | null; retention: string | null; status: "active" | "archived"; created_at: string;
}
export interface AuditEvent {
  id: string; workspace_id: string; project_id: string;
  actor_user_id: string | null; actor_name: string | null;
  action: string; entity_type: string | null; entity_id: string | null; entity_label: string | null;
  detail: Record<string, unknown>; created_at: string;
}

// ── Enums ────────────────────────────────────────────────────────────────────
export type RiskTier = "unacceptable" | "high" | "limited" | "minimal";
export type SystemStatus = "draft" | "in_review" | "approved" | "deployed" | "deprecated" | "retired";
export type RiskCategory = "bias" | "security" | "privacy" | "hallucination" | "compliance" | "safety" | "operational" | "other";
export type RiskStatus = "open" | "mitigating" | "accepted" | "closed";
export type PolicyStatus = "draft" | "active" | "archived";
export type Framework = "eu_ai_act" | "nist_ai_rmf" | "iso_42001" | "gdpr" | "custom";
export type ControlStatus = "not_started" | "in_progress" | "implemented" | "not_applicable";
export type ApprovalKind = "deployment" | "use_case" | "model_change" | "data_access" | "other";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "changes_requested";
export type IncidentCategory = "bias" | "harmful_output" | "data_leak" | "outage" | "privacy" | "other";
export type Severity = "low" | "medium" | "high" | "critical";
export type IncidentStatus = "open" | "investigating" | "resolved" | "closed";
export type Classification = "public" | "internal" | "confidential" | "restricted";

// Label + tone maps. `tone` maps to the Pill color classes below.
type Tone = "red" | "orange" | "amber" | "emerald" | "blue" | "violet" | "slate" | "cyan";
interface Meta { label: string; tone: Tone }
const m = (label: string, tone: Tone): Meta => ({ label, tone });

export const RISK_TIER_META: Record<RiskTier, Meta> = {
  unacceptable: m("Inacceptable", "red"),
  high: m("Élevé", "orange"),
  limited: m("Limité", "amber"),
  minimal: m("Minimal", "emerald"),
};
export const SYSTEM_STATUS_META: Record<SystemStatus, Meta> = {
  draft: m("Brouillon", "slate"),
  in_review: m("En revue", "amber"),
  approved: m("Approuvé", "blue"),
  deployed: m("En production", "emerald"),
  deprecated: m("Déprécié", "orange"),
  retired: m("Retiré", "slate"),
};
export const RISK_CATEGORY_META: Record<RiskCategory, Meta> = {
  bias: m("Biais", "violet"),
  security: m("Sécurité", "red"),
  privacy: m("Vie privée", "cyan"),
  hallucination: m("Hallucination", "orange"),
  compliance: m("Conformité", "blue"),
  safety: m("Sûreté", "amber"),
  operational: m("Opérationnel", "slate"),
  other: m("Autre", "slate"),
};
export const RISK_STATUS_META: Record<RiskStatus, Meta> = {
  open: m("Ouvert", "red"),
  mitigating: m("En traitement", "amber"),
  accepted: m("Accepté", "blue"),
  closed: m("Clos", "emerald"),
};
export const POLICY_STATUS_META: Record<PolicyStatus, Meta> = {
  draft: m("Brouillon", "slate"),
  active: m("Active", "emerald"),
  archived: m("Archivée", "slate"),
};
export const FRAMEWORK_META: Record<Framework, Meta> = {
  eu_ai_act: m("EU AI Act", "blue"),
  nist_ai_rmf: m("NIST AI RMF", "violet"),
  iso_42001: m("ISO 42001", "cyan"),
  gdpr: m("RGPD", "emerald"),
  custom: m("Custom", "slate"),
};
export const CONTROL_STATUS_META: Record<ControlStatus, Meta> = {
  not_started: m("Non démarré", "slate"),
  in_progress: m("En cours", "amber"),
  implemented: m("Implémenté", "emerald"),
  not_applicable: m("N/A", "slate"),
};
export const APPROVAL_KIND_META: Record<ApprovalKind, Meta> = {
  deployment: m("Déploiement", "blue"),
  use_case: m("Cas d'usage", "violet"),
  model_change: m("Changement de modèle", "amber"),
  data_access: m("Accès données", "cyan"),
  other: m("Autre", "slate"),
};
export const APPROVAL_STATUS_META: Record<ApprovalStatus, Meta> = {
  pending: m("En attente", "amber"),
  approved: m("Approuvé", "emerald"),
  rejected: m("Rejeté", "red"),
  changes_requested: m("Modifs demandées", "orange"),
};
export const INCIDENT_CATEGORY_META: Record<IncidentCategory, Meta> = {
  bias: m("Biais", "violet"),
  harmful_output: m("Sortie nuisible", "red"),
  data_leak: m("Fuite de données", "red"),
  outage: m("Panne", "orange"),
  privacy: m("Vie privée", "cyan"),
  other: m("Autre", "slate"),
};
export const SEVERITY_META: Record<Severity, Meta> = {
  low: m("Faible", "emerald"),
  medium: m("Moyenne", "amber"),
  high: m("Élevée", "orange"),
  critical: m("Critique", "red"),
};
export const INCIDENT_STATUS_META: Record<IncidentStatus, Meta> = {
  open: m("Ouvert", "red"),
  investigating: m("Investigation", "amber"),
  resolved: m("Résolu", "emerald"),
  closed: m("Clos", "slate"),
};
export const CLASSIFICATION_META: Record<Classification, Meta> = {
  public: m("Public", "emerald"),
  internal: m("Interne", "blue"),
  confidential: m("Confidentiel", "orange"),
  restricted: m("Restreint", "red"),
};

// Pill color classes keyed by tone (soft bg + readable text in both themes).
export const PILL_TONES: Record<Tone, string> = {
  red: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  orange: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
  cyan: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20",
  slate: "bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20",
};
export function toneClass(tone: Tone) { return PILL_TONES[tone]; }

// Risk score = likelihood × impact (1..25) with a tier band.
export function riskScore(likelihood: number, impact: number) { return likelihood * impact; }
export function riskScoreTone(score: number): Tone {
  if (score >= 15) return "red";
  if (score >= 8) return "orange";
  if (score >= 4) return "amber";
  return "emerald";
}

// ── Data hooks ───────────────────────────────────────────────────────────────
export function useGovTable<T>(table: string, orderBy = "created_at") {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: [table, projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from(table).select("*")
        .eq("project_id", projectId!).order(orderBy, { ascending: false });
      return (data ?? []) as T[];
    },
  });
}

export const useAiSystems = () => useGovTable<AiSystem>("gov_ai_systems");

/** Idempotently mirror the project's internal_agents into the AI registry, then
 *  refresh the systems query. Call once at the top of pages that show systems. */
export function useEnsureSystemsSynced() {
  const { workspaceId, projectId } = useCurrentContext();
  const qc = useQueryClient();
  useEffect(() => {
    if (!workspaceId || !projectId) return;
    let cancelled = false;
    void supabase.rpc("gov_sync_ai_systems", { p_workspace: workspaceId, p_project: projectId })
      .then(() => { if (!cancelled) qc.invalidateQueries({ queryKey: ["gov_ai_systems", projectId] }); });
    return () => { cancelled = true; };
  }, [workspaceId, projectId, qc]);
}
export const useRisks = () => useGovTable<Risk>("gov_risks");
export const usePolicies = () => useGovTable<Policy>("gov_policies");
export const useControls = () => useGovTable<Control>("gov_controls");
export const useApprovals = () => useGovTable<Approval>("gov_approvals");
export const useIncidents = () => useGovTable<Incident>("gov_incidents");
export const useDataAssets = () => useGovTable<DataAsset>("gov_data_assets");
export const useAuditEvents = () => useGovTable<AuditEvent>("gov_audit_events");

// ── Generic CRUD (insert/update/delete + invalidation + audit) ───────────────
// Used by the entity list pages. `create` auto-injects workspace/project/creator.
export function useGovCrud(table: string) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const qc = useQueryClient();
  const actorName = (user?.email as string | undefined) ?? null;
  const invalidate = () => qc.invalidateQueries({ queryKey: [table, projectId] });

  type AuditArgs = { action: string; entityType?: string; entityId?: string; entityLabel?: string; detail?: Record<string, unknown> };
  const audit = (a: AuditArgs) => {
    if (!workspaceId || !projectId) return;
    void logAudit({ workspaceId, projectId, actorId: user?.id ?? null, actorName, ...a });
  };

  return {
    ready: !!workspaceId && !!projectId,
    workspaceId, projectId, userId: user?.id ?? null, actorName,
    async create(values: Record<string, unknown>, a?: AuditArgs) {
      const { data, error } = await supabase.from(table).insert({
        workspace_id: workspaceId, project_id: projectId, created_by: user?.id ?? null, ...values,
      }).select("*").single();
      if (error) throw new Error(error.message);
      invalidate();
      if (a) audit(a);
      return data;
    },
    async update(id: string, patch: Record<string, unknown>, a?: AuditArgs) {
      const { error } = await supabase.from(table)
        .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) throw new Error(error.message);
      invalidate();
      if (a) audit(a);
    },
    async remove(id: string, a?: AuditArgs) {
      const { error } = await supabase.from(table).delete().eq("id", id);
      if (error) throw new Error(error.message);
      invalidate();
      if (a) audit(a);
    },
    audit,
  };
}

// ── Audit logging ────────────────────────────────────────────────────────────
// Fire-and-forget: never blocks the calling action.
export async function logAudit(input: {
  workspaceId: string; projectId: string;
  actorId: string | null; actorName: string | null;
  action: string; entityType?: string; entityId?: string; entityLabel?: string;
  detail?: Record<string, unknown>;
}) {
  try {
    await supabase.from("gov_audit_events").insert({
      workspace_id: input.workspaceId, project_id: input.projectId,
      actor_user_id: input.actorId, actor_name: input.actorName,
      action: input.action, entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null, entity_label: input.entityLabel ?? null,
      detail: input.detail ?? {},
    });
  } catch { /* audit is best-effort */ }
}
