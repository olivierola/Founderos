import { useMemo, useState } from "react";
import {
  WarningIcon as AlertTriangle,
  PlusIcon as Plus,
  PencilSimpleIcon as Pencil,
  TrashIcon as Trash2,
  ShieldWarningIcon as ShieldAlert,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  useRisks, useAiSystems, useGovCrud, type Risk,
  RISK_CATEGORY_META, RISK_STATUS_META, riskScore, riskScoreTone,
} from "./shared";
import { Pill, FormDialog, type FieldDef } from "./ui";

export function GovRisksPage() {
  const crud = useGovCrud("gov_risks");
  const { data: risks, isLoading } = useRisks();
  const { data: systems } = useAiSystems();
  const [editing, setEditing] = useState<Risk | null>(null);
  const [creating, setCreating] = useState(false);

  const systemName = (id: string | null) => systems?.find((s) => s.id === id)?.name ?? "—";

  const stats = useMemo(() => {
    const all = risks ?? [];
    const open = all.filter((r) => r.status === "open" || r.status === "mitigating");
    const critical = all.filter((r) => riskScore(r.likelihood, r.impact) >= 15).length;
    const avg = all.length ? Math.round((all.reduce((s, r) => s + riskScore(r.likelihood, r.impact), 0) / all.length) * 10) / 10 : 0;
    return { total: all.length, open: open.length, critical, avg };
  }, [risks]);

  const fields: FieldDef[] = [
    { key: "title", label: "Intitulé du risque", required: true, placeholder: "Biais de genre dans le scoring CV" },
    { key: "category", label: "Catégorie", type: "select", options: RISK_CATEGORY_META, half: true },
    { key: "status", label: "Statut", type: "select", options: RISK_STATUS_META, half: true },
    { key: "likelihood", label: "Probabilité (1–5)", type: "number", half: true },
    { key: "impact", label: "Impact (1–5)", type: "number", half: true },
    { key: "system_id", label: "Système concerné", type: "select",
      options: [{ value: "", label: "— Aucun —" }, ...(systems ?? []).map((s) => ({ value: s.id, label: s.name }))] },
    { key: "owner_name", label: "Responsable", placeholder: "Équipe / personne" },
    { key: "description", label: "Description", type: "textarea" },
    { key: "mitigation", label: "Plan de mitigation", type: "textarea" },
  ];

  const initial = (r?: Risk) => ({
    title: r?.title ?? "", category: r?.category ?? "other", status: r?.status ?? "open",
    likelihood: r?.likelihood ?? 3, impact: r?.impact ?? 3, system_id: r?.system_id ?? "",
    owner_name: r?.owner_name ?? "", description: r?.description ?? "", mitigation: r?.mitigation ?? "",
  });

  const save = async (values: Record<string, unknown>) => {
    const clamp = (n: unknown) => Math.min(5, Math.max(1, Number(n) || 3));
    const payload = { ...values, likelihood: clamp(values.likelihood), impact: clamp(values.impact) };
    if (editing) await crud.update(editing.id, payload, { action: "risk.updated", entityType: "risk", entityId: editing.id, entityLabel: String(values.title) });
    else await crud.create(payload, { action: "risk.created", entityType: "risk", entityLabel: String(values.title) });
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Registre des risques"
        description="Biais, sécurité, fuite de données, hallucination, conformité — évalués (probabilité × impact) et suivis."
        actions={<Button onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" />Risque</Button>} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Risques" value={String(stats.total)} icon={ShieldAlert} />
        <MetricCard label="Ouverts" value={String(stats.open)} icon={AlertTriangle} />
        <MetricCard label="Critiques" value={String(stats.critical)} icon={AlertTriangle} hint="score ≥ 15" />
        <MetricCard label="Score moyen" value={String(stats.avg)} icon={ShieldAlert} hint="sur 25" />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : (risks ?? []).length === 0 ? (
        <EmptyState icon={ShieldAlert} title="Aucun risque enregistré" description="Identifiez et évaluez les risques liés à vos systèmes d'IA." />
      ) : (
        <div className="space-y-2">
          {(risks ?? []).map((r) => {
            const score = riskScore(r.likelihood, r.impact);
            return (
              <Card key={r.id} className="flex items-center gap-4 p-3">
                <div className={`flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg border text-sm font-semibold ${riskScoreClass(score)}`}>
                  {score}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{r.title}</span>
                    <Pill meta={RISK_CATEGORY_META[r.category]} />
                    <Pill meta={RISK_STATUS_META[r.status]} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    P{r.likelihood} × I{r.impact} · {systemName(r.system_id)}{r.owner_name ? ` · ${r.owner_name}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(r)}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7"
                    onClick={() => { if (confirm("Supprimer ce risque ?")) void crud.remove(r.id, { action: "risk.deleted", entityType: "risk", entityId: r.id, entityLabel: r.title }); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {(creating || editing) && (
        <FormDialog
          title={editing ? "Éditer le risque" : "Nouveau risque"}
          fields={fields}
          initial={initial(editing ?? undefined)}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSubmit={save}
        />
      )}
    </div>
  );
}

function riskScoreClass(score: number) {
  const map: Record<string, string> = {
    red: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
    orange: "border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400",
    amber: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  };
  return map[riskScoreTone(score)] ?? "";
}
