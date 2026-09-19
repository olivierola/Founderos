import { useMemo, useState } from "react";
import {
  SirenIcon as Siren,
  PlusIcon as Plus,
  PencilSimpleIcon as Pencil,
  TrashIcon as Trash2,
  WarningOctagonIcon as AlertOctagon,
  CheckCircleIcon as CheckCircle2,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  useIncidents, useAiSystems, useGovCrud, type Incident,
  INCIDENT_CATEGORY_META, SEVERITY_META, INCIDENT_STATUS_META,
} from "./shared";
import { Pill, FormDialog, type FieldDef } from "./ui";

export function GovIncidentsPage() {
  const crud = useGovCrud("gov_incidents");
  const { data: incidents, isLoading } = useIncidents();
  const { data: systems } = useAiSystems();
  const [editing, setEditing] = useState<Incident | null>(null);
  const [creating, setCreating] = useState(false);
  const systemName = (id: string | null) => systems?.find((s) => s.id === id)?.name ?? "—";

  const stats = useMemo(() => {
    const all = incidents ?? [];
    return {
      open: all.filter((i) => i.status === "open" || i.status === "investigating").length,
      critical: all.filter((i) => i.severity === "critical").length,
      resolved: all.filter((i) => i.status === "resolved" || i.status === "closed").length,
      total: all.length,
    };
  }, [incidents]);

  const fields: FieldDef[] = [
    { key: "title", label: "Titre", required: true, placeholder: "Réponse toxique générée en production" },
    { key: "category", label: "Catégorie", type: "select", options: INCIDENT_CATEGORY_META, half: true },
    { key: "severity", label: "Gravité", type: "select", options: SEVERITY_META, half: true },
    { key: "status", label: "Statut", type: "select", options: INCIDENT_STATUS_META, half: true },
    { key: "occurred_at", label: "Survenu le", type: "date", half: true },
    { key: "system_id", label: "Système concerné", type: "select",
      options: [{ value: "", label: "— Aucun —" }, ...(systems ?? []).map((s) => ({ value: s.id, label: s.name }))] },
    { key: "description", label: "Description", type: "textarea" },
    { key: "resolution", label: "Résolution", type: "textarea" },
  ];

  const initial = (i?: Incident) => ({
    title: i?.title ?? "", category: i?.category ?? "other", severity: i?.severity ?? "medium",
    status: i?.status ?? "open", occurred_at: i?.occurred_at ? i.occurred_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
    system_id: i?.system_id ?? "", description: i?.description ?? "", resolution: i?.resolution ?? "",
  });

  const save = async (values: Record<string, unknown>) => {
    const status = String(values.status);
    const payload = { ...values, resolved_at: (status === "resolved" || status === "closed") ? new Date().toISOString() : null };
    if (editing) await crud.update(editing.id, payload, { action: "incident.updated", entityType: "incident", entityId: editing.id, entityLabel: String(values.title) });
    else await crud.create(payload, { action: "incident.reported", entityType: "incident", entityLabel: String(values.title) });
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Incidents IA"
        description="Journal des incidents et quasi-incidents : biais, sorties nuisibles, fuites, pannes — gravité et résolution."
        actions={<Button onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" />Incident</Button>} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Ouverts" value={String(stats.open)} icon={AlertOctagon} />
        <MetricCard label="Critiques" value={String(stats.critical)} icon={Siren} />
        <MetricCard label="Résolus" value={String(stats.resolved)} icon={CheckCircle2} />
        <MetricCard label="Total" value={String(stats.total)} icon={Siren} />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : (incidents ?? []).length === 0 ? (
        <EmptyState icon={Siren} title="Aucun incident" description="Consignez ici les incidents liés à vos systèmes d'IA pour en garder la trace." />
      ) : (
        <div className="space-y-2">
          {(incidents ?? []).map((i) => (
            <Card key={i.id} className="flex items-center gap-4 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill meta={SEVERITY_META[i.severity]} />
                  <span className="truncate font-medium">{i.title}</span>
                  <Pill meta={INCIDENT_CATEGORY_META[i.category]} />
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {new Date(i.occurred_at).toLocaleDateString("fr-FR")} · {systemName(i.system_id)}
                </p>
              </div>
              <Pill meta={INCIDENT_STATUS_META[i.status]} />
              <div className="flex shrink-0 gap-1">
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(i)}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button size="icon" variant="ghost" className="h-7 w-7"
                  onClick={() => { if (confirm("Supprimer cet incident ?")) void crud.remove(i.id, { action: "incident.deleted", entityType: "incident", entityId: i.id, entityLabel: i.title }); }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <FormDialog
          title={editing ? "Éditer l'incident" : "Nouvel incident"}
          fields={fields}
          initial={initial(editing ?? undefined)}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSubmit={save}
        />
      )}
    </div>
  );
}
