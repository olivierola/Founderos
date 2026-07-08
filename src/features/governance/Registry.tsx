import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ShieldCheck, Plus, Bot, ExternalLink, Pencil, Trash2, Search, Cpu, AlertTriangle,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import {
  useAiSystems, useEnsureSystemsSynced, useGovCrud, type AiSystem,
  RISK_TIER_META, SYSTEM_STATUS_META, type RiskTier, type SystemStatus,
} from "./shared";
import { Pill, Field, Select, metaOptions } from "./ui";

const BLANK = {
  name: "", description: "", purpose: "", owner_name: "", model: "", provider: "",
  risk_tier: "limited" as RiskTier, status: "draft" as SystemStatus,
  data_sources: "", decision_logic: "", human_oversight: "",
};

export function GovRegistryPage() {
  useEnsureSystemsSynced();
  const { workspace, project } = useCurrentContext();
  const crud = useGovCrud("gov_ai_systems");
  const { data: systems, isLoading } = useAiSystems();
  const [q, setQ] = useState("");
  const [tier, setTier] = useState<string>("all");
  const [editing, setEditing] = useState<AiSystem | null>(null);
  const [creating, setCreating] = useState(false);

  const stats = useMemo(() => {
    const all = systems ?? [];
    const highRisk = all.filter((s) => s.risk_tier === "high" || s.risk_tier === "unacceptable").length;
    const deployed = all.filter((s) => s.status === "deployed").length;
    const needReview = all.filter((s) => !s.next_review_at || new Date(s.next_review_at) < new Date()).length;
    return { total: all.length, highRisk, deployed, needReview };
  }, [systems]);

  const visible = (systems ?? []).filter((s) =>
    (tier === "all" || s.risk_tier === tier) &&
    (!q || s.name.toLowerCase().includes(q.toLowerCase()) || (s.purpose ?? "").toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Registry"
        description="Inventaire des systèmes d'IA — model cards : finalité, propriétaire, données, niveau de risque et statut."
        actions={<Button onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" />Système IA</Button>}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Systèmes IA" value={String(stats.total)} icon={Cpu} />
        <MetricCard label="Risque élevé" value={String(stats.highRisk)} icon={AlertTriangle} hint="high + inacceptable" />
        <MetricCard label="En production" value={String(stats.deployed)} icon={ShieldCheck} />
        <MetricCard label="Revue à faire" value={String(stats.needReview)} icon={AlertTriangle} hint="revue expirée / absente" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un système…" className="pl-9" />
        </div>
        <Select value={tier} onChange={(e) => setTier(e.target.value)} className="h-10 w-auto">
          <option value="all">Tous les niveaux</option>
          {metaOptions(RISK_TIER_META)}
        </Select>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : visible.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="Aucun système d'IA"
          description="Vos agents internes sont importés automatiquement. Ajoutez ici les systèmes IA externes à gouverner." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {visible.map((s) => (
            <Card key={s.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {s.source === "internal_agent" ? <Bot className="h-4 w-4 shrink-0 text-primary" /> : <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className="truncate font-medium">{s.name}</span>
                  </div>
                  {s.purpose && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{s.purpose}</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(s)}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7"
                    onClick={() => { if (confirm(`Supprimer « ${s.name} » du registre ?`)) void crud.remove(s.id, { action: "system.deleted", entityType: "system", entityId: s.id, entityLabel: s.name }); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Pill meta={RISK_TIER_META[s.risk_tier]} />
                <Pill meta={SYSTEM_STATUS_META[s.status]} />
                {s.model && <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{s.model}</span>}
                {s.owner_name && <span className="text-[11px] text-muted-foreground">· {s.owner_name}</span>}
              </div>
              {s.source === "internal_agent" && s.agent_id && workspace && project && (
                <Link to={`/app/${workspace.slug}/${project.slug}/agent/internal/${s.agent_id}`}
                  className="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  Voir l'agent <ExternalLink className="h-3 w-3" />
                </Link>
              )}
            </Card>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <SystemDialog
          system={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSave={async (values) => {
            if (editing) {
              await crud.update(editing.id, values, { action: "system.updated", entityType: "system", entityId: editing.id, entityLabel: String(values.name) });
            } else {
              await crud.create({ ...values, source: "manual" }, { action: "system.created", entityType: "system", entityLabel: String(values.name) });
            }
            setCreating(false); setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function SystemDialog({ system, onClose, onSave }: {
  system: AiSystem | null;
  onClose: () => void;
  onSave: (values: Record<string, unknown>) => Promise<void>;
}) {
  const isAgent = system?.source === "internal_agent";
  const [form, setForm] = useState({
    ...BLANK,
    ...(system ? {
      name: system.name, description: system.description ?? "", purpose: system.purpose ?? "",
      owner_name: system.owner_name ?? "", model: system.model ?? "", provider: system.provider ?? "",
      risk_tier: system.risk_tier, status: system.status,
      data_sources: (system.data_sources ?? []).join(", "),
      decision_logic: system.decision_logic ?? "", human_oversight: system.human_oversight ?? "",
    } : {}),
  });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await onSave({
        name: form.name.trim(), description: form.description || null, purpose: form.purpose || null,
        owner_name: form.owner_name || null, model: form.model || null, provider: form.provider || null,
        risk_tier: form.risk_tier, status: form.status,
        data_sources: form.data_sources ? form.data_sources.split(",").map((x) => x.trim()).filter(Boolean) : [],
        decision_logic: form.decision_logic || null, human_oversight: form.human_oversight || null,
      });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{system ? "Éditer le système" : "Nouveau système d'IA"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label="Nom">
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} disabled={isAgent} placeholder="Assistant support v2" />
          </Field>
          <Field label="Finalité / cas d'usage">
            <Textarea value={form.purpose} onChange={(e) => set("purpose", e.target.value)} placeholder="À quoi sert ce système et pour qui ?" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Niveau de risque (EU AI Act)">
              <Select value={form.risk_tier} onChange={(e) => set("risk_tier", e.target.value as RiskTier)}>{metaOptions(RISK_TIER_META)}</Select>
            </Field>
            <Field label="Statut">
              <Select value={form.status} onChange={(e) => set("status", e.target.value as SystemStatus)}>{metaOptions(SYSTEM_STATUS_META)}</Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Propriétaire"><Input value={form.owner_name} onChange={(e) => set("owner_name", e.target.value)} placeholder="Équipe / personne" /></Field>
            <Field label="Modèle"><Input value={form.model} onChange={(e) => set("model", e.target.value)} placeholder="claude-opus-4-8" /></Field>
          </div>
          <Field label="Sources de données" hint="Séparées par des virgules">
            <Input value={form.data_sources} onChange={(e) => set("data_sources", e.target.value)} placeholder="CRM, tickets support, docs internes" />
          </Field>
          <Field label="Logique de décision (explicabilité)">
            <Textarea value={form.decision_logic} onChange={(e) => set("decision_logic", e.target.value)} placeholder="Comment le système prend ses décisions ?" />
          </Field>
          <Field label="Supervision humaine (HITL)">
            <Textarea value={form.human_oversight} onChange={(e) => set("human_oversight", e.target.value)} placeholder="Quels contrôles humains encadrent le système ?" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={submit} disabled={saving || !form.name.trim()}>{saving ? "Enregistrement…" : "Enregistrer"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
