import { useMemo, useState } from "react";
import {
  CheckCircleIcon as CheckCircle2,
  XCircleIcon as XCircle,
  PlusIcon as Plus,
  ClockIcon as Clock,
  GitPullRequestIcon as GitPullRequestArrow,
  TrashIcon as Trash2,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  useApprovals, useAiSystems, useGovCrud, type Approval,
  APPROVAL_KIND_META, APPROVAL_STATUS_META, RISK_TIER_META, type RiskTier,
} from "./shared";
import { Pill, FormDialog, type FieldDef } from "./ui";

export function GovApprovalsPage() {
  const crud = useGovCrud("gov_approvals");
  const { data: approvals, isLoading } = useApprovals();
  const { data: systems } = useAiSystems();
  const [creating, setCreating] = useState(false);
  const systemName = (id: string | null) => systems?.find((s) => s.id === id)?.name;

  const stats = useMemo(() => {
    const all = approvals ?? [];
    return {
      pending: all.filter((a) => a.status === "pending").length,
      approved: all.filter((a) => a.status === "approved").length,
      rejected: all.filter((a) => a.status === "rejected").length,
      total: all.length,
    };
  }, [approvals]);

  const decide = async (a: Approval, status: "approved" | "rejected" | "changes_requested") => {
    const note = status !== "approved" ? (prompt("Motif de la décision (optionnel) :") ?? "") : "";
    await crud.update(a.id, {
      status, decided_by: crud.userId, decided_at: new Date().toISOString(), decision_note: note || null,
    }, { action: `approval.${status}`, entityType: "approval", entityId: a.id, entityLabel: a.title });
  };

  const fields: FieldDef[] = [
    { key: "title", label: "Objet de la demande", required: true, placeholder: "Déploiement de l'agent support en production" },
    { key: "kind", label: "Type", type: "select", options: APPROVAL_KIND_META, half: true },
    { key: "risk_tier", label: "Niveau de risque", type: "select",
      options: [{ value: "", label: "— Non défini —" }, ...Object.entries(RISK_TIER_META).map(([v, x]) => ({ value: v, label: x.label }))], half: true },
    { key: "system_id", label: "Système concerné", type: "select",
      options: [{ value: "", label: "— Aucun —" }, ...(systems ?? []).map((s) => ({ value: s.id, label: s.name }))] },
    { key: "requested_by_name", label: "Demandeur" },
    { key: "description", label: "Contexte", type: "textarea" },
  ];

  const save = async (values: Record<string, unknown>) => {
    await crud.create({ ...values, risk_tier: values.risk_tier || null, status: "pending" },
      { action: "approval.requested", entityType: "approval", entityLabel: String(values.title) });
  };

  const pending = (approvals ?? []).filter((a) => a.status === "pending");
  const decided = (approvals ?? []).filter((a) => a.status !== "pending");

  return (
    <div className="space-y-6">
      <PageHeader title="Validations (HITL)"
        description="File de supervision humaine : déploiements, cas d'usage sensibles et changements de modèle à valider."
        actions={<Button onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" />Demande</Button>} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="En attente" value={String(stats.pending)} icon={Clock} />
        <MetricCard label="Approuvées" value={String(stats.approved)} icon={CheckCircle2} />
        <MetricCard label="Rejetées" value={String(stats.rejected)} icon={XCircle} />
        <MetricCard label="Total" value={String(stats.total)} icon={GitPullRequestArrow} />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : (approvals ?? []).length === 0 ? (
        <EmptyState icon={GitPullRequestArrow} title="Aucune demande" description="Créez un point de validation humaine avant de déployer un système ou un cas d'usage à risque." />
      ) : (
        <div className="space-y-4">
          {pending.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">En attente ({pending.length})</h3>
              {pending.map((a) => (
                <Card key={a.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{a.title}</span>
                        <Pill meta={APPROVAL_KIND_META[a.kind]} />
                        {a.risk_tier && <Pill meta={RISK_TIER_META[a.risk_tier as RiskTier]} />}
                      </div>
                      {a.description && <p className="mt-1 text-xs text-muted-foreground">{a.description}</p>}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {systemName(a.system_id) ? `${systemName(a.system_id)} · ` : ""}{a.requested_by_name ? `demandé par ${a.requested_by_name}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
                    <Button size="sm" onClick={() => decide(a, "approved")}><CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />Approuver</Button>
                    <Button size="sm" variant="outline" onClick={() => decide(a, "changes_requested")}>Demander des modifs</Button>
                    <Button size="sm" variant="ghost" className="text-red-600 dark:text-red-400" onClick={() => decide(a, "rejected")}><XCircle className="mr-1.5 h-3.5 w-3.5" />Rejeter</Button>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {decided.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Décidées ({decided.length})</h3>
              {decided.map((a) => (
                <Card key={a.id} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{a.title}</span>
                      <Pill meta={APPROVAL_STATUS_META[a.status]} />
                    </div>
                    {a.decision_note && <p className="mt-0.5 truncate text-xs text-muted-foreground">« {a.decision_note} »</p>}
                  </div>
                  <Button size="icon" variant="ghost" className="h-7 w-7"
                    onClick={() => { if (confirm("Supprimer cette demande ?")) void crud.remove(a.id, { action: "approval.deleted", entityType: "approval", entityId: a.id, entityLabel: a.title }); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {creating && (
        <FormDialog
          title="Nouvelle demande de validation"
          fields={fields}
          initial={{ title: "", kind: "deployment", risk_tier: "", system_id: "", requested_by_name: "", description: "" }}
          submitLabel="Soumettre"
          onClose={() => setCreating(false)}
          onSubmit={save}
        />
      )}
    </div>
  );
}
