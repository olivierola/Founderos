import { useMemo, useState } from "react";
import {
  DatabaseIcon as Database,
  PlusIcon as Plus,
  PencilSimpleIcon as Pencil,
  TrashIcon as Trash2,
  ShieldWarningIcon as ShieldAlert,
  LockIcon as Lock,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useDataAssets, useGovCrud, type DataAsset, CLASSIFICATION_META } from "./shared";
import { Pill, FormDialog, type FieldDef } from "./ui";

export function GovDataAssetsPage() {
  const crud = useGovCrud("gov_data_assets");
  const { data: assets, isLoading } = useDataAssets();
  const [editing, setEditing] = useState<DataAsset | null>(null);
  const [creating, setCreating] = useState(false);

  const stats = useMemo(() => {
    const all = assets ?? [];
    return {
      total: all.length,
      pii: all.filter((a) => a.contains_pii).length,
      restricted: all.filter((a) => a.classification === "restricted" || a.classification === "confidential").length,
      noBasis: all.filter((a) => a.contains_pii && !a.lawful_basis).length,
    };
  }, [assets]);

  const fields: FieldDef[] = [
    { key: "name", label: "Jeu de données", required: true, placeholder: "Base clients CRM" },
    { key: "source", label: "Source", half: true, placeholder: "supabase.contacts / API Stripe" },
    { key: "classification", label: "Classification", type: "select", options: CLASSIFICATION_META, half: true },
    { key: "contains_pii", label: "Contient des données personnelles (PII)", type: "checkbox" },
    { key: "lawful_basis", label: "Base légale (RGPD)", half: true, placeholder: "Consentement / intérêt légitime…" },
    { key: "retention", label: "Rétention", half: true, placeholder: "36 mois" },
    { key: "owner_name", label: "Propriétaire" },
    { key: "description", label: "Description", type: "textarea" },
  ];

  const initial = (a?: DataAsset) => ({
    name: a?.name ?? "", source: a?.source ?? "", classification: a?.classification ?? "internal",
    contains_pii: a?.contains_pii ?? false, lawful_basis: a?.lawful_basis ?? "", retention: a?.retention ?? "",
    owner_name: a?.owner_name ?? "", description: a?.description ?? "",
  });

  const save = async (values: Record<string, unknown>) => {
    if (editing) await crud.update(editing.id, values, { action: "data_asset.updated", entityType: "data_asset", entityId: editing.id, entityLabel: String(values.name) });
    else await crud.create(values, { action: "data_asset.created", entityType: "data_asset", entityLabel: String(values.name) });
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Actifs de données"
        description="Catalogue des données qui alimentent l'IA : sensibilité, PII, base légale, rétention et propriétaire."
        actions={<Button onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" />Actif</Button>} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Actifs" value={String(stats.total)} icon={Database} />
        <MetricCard label="Avec PII" value={String(stats.pii)} icon={Lock} />
        <MetricCard label="Sensibles" value={String(stats.restricted)} icon={ShieldAlert} hint="confidentiel + restreint" />
        <MetricCard label="PII sans base légale" value={String(stats.noBasis)} icon={ShieldAlert} />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : (assets ?? []).length === 0 ? (
        <EmptyState icon={Database} title="Aucun actif de données" description="Recensez les jeux de données consommés par vos systèmes d'IA." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {(assets ?? []).map((a) => (
            <Card key={a.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{a.name}</span>
                    <Pill meta={CLASSIFICATION_META[a.classification]} />
                    {a.contains_pii && <Pill meta={{ label: "PII", tone: "orange" }} />}
                  </div>
                  {a.source && <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{a.source}</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(a)}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7"
                    onClick={() => { if (confirm("Supprimer cet actif ?")) void crud.remove(a.id, { action: "data_asset.deleted", entityType: "data_asset", entityId: a.id, entityLabel: a.name }); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                {a.owner_name && <span>Propriétaire : {a.owner_name}</span>}
                {a.lawful_basis && <span>Base : {a.lawful_basis}</span>}
                {a.retention && <span>Rétention : {a.retention}</span>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <FormDialog
          title={editing ? "Éditer l'actif" : "Nouvel actif de données"}
          fields={fields}
          initial={initial(editing ?? undefined)}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSubmit={save}
        />
      )}
    </div>
  );
}
