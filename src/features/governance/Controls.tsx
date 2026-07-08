import { useMemo, useState } from "react";
import { ClipboardCheck, Plus, Pencil, Trash2, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  useControls, useAiSystems, useGovCrud, type Control,
  FRAMEWORK_META, CONTROL_STATUS_META,
} from "./shared";
import { Pill, Select, FormDialog, metaOptions, type FieldDef } from "./ui";

export function GovControlsPage() {
  const crud = useGovCrud("gov_controls");
  const { data: controls, isLoading } = useControls();
  const { data: systems } = useAiSystems();
  const [framework, setFramework] = useState<string>("all");
  const [editing, setEditing] = useState<Control | null>(null);
  const [creating, setCreating] = useState(false);

  const stats = useMemo(() => {
    const all = (controls ?? []).filter((c) => c.status !== "not_applicable");
    const implemented = all.filter((c) => c.status === "implemented").length;
    const coverage = all.length ? Math.round((implemented / all.length) * 100) : 0;
    return { total: (controls ?? []).length, implemented, inProgress: all.filter((c) => c.status === "in_progress").length, coverage };
  }, [controls]);

  const visible = (controls ?? []).filter((c) => framework === "all" || c.framework === framework);

  const fields: FieldDef[] = [
    { key: "framework", label: "Référentiel", type: "select", options: FRAMEWORK_META, half: true },
    { key: "ref_code", label: "Référence", half: true, placeholder: "Art. 9 / GOVERN-1.1" },
    { key: "title", label: "Contrôle", required: true, placeholder: "Système de gestion des risques" },
    { key: "status", label: "Statut", type: "select", options: CONTROL_STATUS_META, half: true },
    { key: "owner_name", label: "Responsable", half: true },
    { key: "system_id", label: "Système concerné", type: "select",
      options: [{ value: "", label: "— Aucun —" }, ...(systems ?? []).map((s) => ({ value: s.id, label: s.name }))] },
    { key: "description", label: "Description", type: "textarea" },
    { key: "evidence", label: "Preuve / évidence", type: "textarea" },
  ];

  const initial = (c?: Control) => ({
    framework: c?.framework ?? "eu_ai_act", ref_code: c?.ref_code ?? "", title: c?.title ?? "",
    status: c?.status ?? "not_started", owner_name: c?.owner_name ?? "", system_id: c?.system_id ?? "",
    description: c?.description ?? "", evidence: c?.evidence ?? "",
  });

  const save = async (values: Record<string, unknown>) => {
    if (editing) await crud.update(editing.id, values, { action: "control.updated", entityType: "control", entityId: editing.id, entityLabel: String(values.title) });
    else await crud.create(values, { action: "control.created", entityType: "control", entityLabel: String(values.title) });
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Contrôles & conformité"
        description="Cartographie des exigences réglementaires (EU AI Act, NIST AI RMF, ISO 42001, RGPD) vers vos contrôles."
        actions={<Button onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" />Contrôle</Button>} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Contrôles" value={String(stats.total)} icon={ClipboardCheck} />
        <MetricCard label="Implémentés" value={String(stats.implemented)} icon={ShieldCheck} />
        <MetricCard label="En cours" value={String(stats.inProgress)} icon={ClipboardCheck} />
        <MetricCard label="Couverture" value={`${stats.coverage}%`} icon={ShieldCheck} hint="hors N/A" />
      </div>

      <Select value={framework} onChange={(e) => setFramework(e.target.value)} className="h-10 w-auto">
        <option value="all">Tous les référentiels</option>
        {metaOptions(FRAMEWORK_META)}
      </Select>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : visible.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="Aucun contrôle" description="Mappez les exigences de vos référentiels vers des contrôles suivis." />
      ) : (
        <div className="space-y-2">
          {visible.map((c) => (
            <Card key={c.id} className="flex items-center gap-4 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill meta={FRAMEWORK_META[c.framework]} />
                  {c.ref_code && <span className="font-mono text-[11px] text-muted-foreground">{c.ref_code}</span>}
                  <span className="truncate font-medium">{c.title}</span>
                </div>
                {c.owner_name && <p className="mt-0.5 text-xs text-muted-foreground">{c.owner_name}</p>}
              </div>
              <Pill meta={CONTROL_STATUS_META[c.status]} />
              <div className="flex shrink-0 gap-1">
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(c)}><Pencil className="h-3.5 w-3.5" /></Button>
                <Button size="icon" variant="ghost" className="h-7 w-7"
                  onClick={() => { if (confirm("Supprimer ce contrôle ?")) void crud.remove(c.id, { action: "control.deleted", entityType: "control", entityId: c.id, entityLabel: c.title }); }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <FormDialog
          title={editing ? "Éditer le contrôle" : "Nouveau contrôle"}
          fields={fields}
          initial={initial(editing ?? undefined)}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSubmit={save}
        />
      )}
    </div>
  );
}
