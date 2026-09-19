import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileTextIcon as FileText,
  PlusIcon as Plus,
  PencilSimpleIcon as Pencil,
  TrashIcon as Trash2,
  CheckIcon as Check,
  ScrollIcon as ScrollText,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { usePolicies, useGovCrud, type Policy, POLICY_STATUS_META } from "./shared";
import { Pill, FormDialog, type FieldDef } from "./ui";

export function GovPoliciesPage() {
  const crud = useGovCrud("gov_policies");
  const { user } = useAuth();
  const { workspaceId, projectId } = useCurrentContext();
  const qc = useQueryClient();
  const { data: policies, isLoading } = usePolicies();
  const [editing, setEditing] = useState<Policy | null>(null);
  const [creating, setCreating] = useState(false);

  // Which policies the current user has acknowledged.
  const { data: myAcks } = useQuery({
    queryKey: ["gov_policy_acks", projectId, user?.id],
    enabled: !!projectId && !!user?.id,
    queryFn: async () => {
      const { data } = await supabase.from("gov_policy_acks").select("policy_id").eq("user_id", user!.id);
      return new Set((data ?? []).map((r) => (r as { policy_id: string }).policy_id));
    },
  });

  const stats = useMemo(() => {
    const all = policies ?? [];
    return {
      total: all.length,
      active: all.filter((p) => p.status === "active").length,
      draft: all.filter((p) => p.status === "draft").length,
    };
  }, [policies]);

  const fields: FieldDef[] = [
    { key: "title", label: "Titre", required: true, placeholder: "Politique d'usage de l'IA générative" },
    { key: "category", label: "Catégorie", half: true, placeholder: "Usage, Sécurité, Données…" },
    { key: "version", label: "Version", half: true, placeholder: "v1" },
    { key: "status", label: "Statut", type: "select", options: POLICY_STATUS_META, half: true },
    { key: "effective_at", label: "Entrée en vigueur", type: "date", half: true },
    { key: "owner_name", label: "Responsable" },
    { key: "body", label: "Contenu (markdown)", type: "textarea" },
  ];

  const initial = (p?: Policy) => ({
    title: p?.title ?? "", category: p?.category ?? "", version: p?.version ?? "v1",
    status: p?.status ?? "draft", effective_at: p?.effective_at ?? "",
    owner_name: p?.owner_name ?? "", body: p?.body ?? "",
  });

  const save = async (values: Record<string, unknown>) => {
    if (editing) await crud.update(editing.id, values, { action: "policy.updated", entityType: "policy", entityId: editing.id, entityLabel: String(values.title) });
    else await crud.create(values, { action: "policy.created", entityType: "policy", entityLabel: String(values.title) });
  };

  const acknowledge = async (p: Policy) => {
    if (!workspaceId || !user?.id) return;
    await supabase.from("gov_policy_acks").insert({ workspace_id: workspaceId, policy_id: p.id, user_id: user.id });
    qc.invalidateQueries({ queryKey: ["gov_policy_acks", projectId, user.id] });
    crud.audit({ action: "policy.acknowledged", entityType: "policy", entityId: p.id, entityLabel: p.title });
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Politiques IA"
        description="Règles internes d'usage de l'IA, versionnées, avec accusés de lecture par l'équipe."
        actions={<Button onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" />Politique</Button>} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Politiques" value={String(stats.total)} icon={ScrollText} />
        <MetricCard label="Actives" value={String(stats.active)} icon={Check} />
        <MetricCard label="Brouillons" value={String(stats.draft)} icon={FileText} />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : (policies ?? []).length === 0 ? (
        <EmptyState icon={ScrollText} title="Aucune politique" description="Formalisez vos règles d'usage de l'IA et diffusez-les à l'équipe." />
      ) : (
        <div className="space-y-2">
          {(policies ?? []).map((p) => {
            const acked = myAcks?.has(p.id);
            return (
              <Card key={p.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{p.title}</span>
                      <Pill meta={POLICY_STATUS_META[p.status]} />
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{p.version}</span>
                      {p.category && <span className="text-[11px] text-muted-foreground">{p.category}</span>}
                    </div>
                    {p.body && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.body}</p>}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(p)}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7"
                      onClick={() => { if (confirm("Supprimer cette politique ?")) void crud.remove(p.id, { action: "policy.deleted", entityType: "policy", entityId: p.id, entityLabel: p.title }); }}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {p.status === "active" && (
                  <div className="mt-3 border-t pt-3">
                    {acked ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                        <Check className="h-3.5 w-3.5" /> Vous avez accusé lecture
                      </span>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => acknowledge(p)}>
                        <Check className="mr-1.5 h-3.5 w-3.5" /> Accuser lecture
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {(creating || editing) && (
        <FormDialog
          title={editing ? "Éditer la politique" : "Nouvelle politique"}
          fields={fields}
          initial={initial(editing ?? undefined)}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSubmit={save}
        />
      )}
    </div>
  );
}
