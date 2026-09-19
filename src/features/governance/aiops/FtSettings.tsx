import { useEffect, useState } from "react";
import {
  SlidersHorizontalIcon as Settings2,
  FloppyDiskIcon as Save,
  CheckIcon as Check,
  PlugIcon as Plug,
} from "@phosphor-icons/react";
import { PageSkeleton } from "@/components/ui/skeleton";
import { PlugsConnectedIcon } from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Field, Select } from "../ui";
import { FT_INTEGRATIONS, type FtSettings } from "./data";
import { useFtSettingsDb } from "./db";

export function GovFtSettingsPage() {
  const { settings, loading, save: saveDb } = useFtSettingsDb();
  const [draft, setDraft] = useState<FtSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [connected, setConnected] = useState<Set<string>>(() => new Set(Object.entries(settings.integrations).filter(([, v]) => v).map(([k]) => k)));

  // Local draft over the persisted config; "Enregistrer" writes the row.
  useEffect(() => {
    if (!loading) {
      setDraft(settings);
      setConnected(new Set(Object.entries(settings.integrations).filter(([, v]) => v).map(([k]) => k)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);
  const s = draft;
  if (!s) return <PageSkeleton cards={0} rows={8} />;

  const set = <K extends keyof FtSettings>(k: K, v: FtSettings[K]) => { setDraft((p) => (p ? { ...p, [k]: v } : p)); setSaved(false); };
  const save = () => { if (s) { void saveDb(s).then(() => setSaved(true)); } };
  const toggleIntegration = (id: string) =>
    setConnected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      setDraft((p) => (p ? { ...p, integrations: Object.fromEntries(FT_INTEGRATIONS.map((i) => [i.id, n.has(i.id)])) } : p));
      setSaved(false);
      return n;
    });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Configuration globale du studio : fournisseurs GPU/LLM, stockage, rétention, versioning, sauvegardes et quotas."
        actions={<Button onClick={save}>{saved ? <><Check className="mr-1.5 h-4 w-4" />Enregistré</> : <><Save className="mr-1.5 h-4 w-4" />Enregistrer</>}</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium"><Settings2 className="h-4 w-4 text-muted-foreground" />Fournisseurs & stockage</div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fournisseur GPU">
              <Select value={s.gpuProvider} onChange={(e) => set("gpuProvider", e.target.value)}>
                <option value="self_hosted">Serveurs privés (self-hosted)</option>
                <option value="aws">AWS (EC2 GPU)</option>
                <option value="gcp">Google Cloud</option>
                <option value="azure">Azure</option>
                <option value="runpod">RunPod</option>
              </Select>
            </Field>
            <Field label="Fournisseur LLM (éval / juge)">
              <Select value={s.llmProvider} onChange={(e) => set("llmProvider", e.target.value)}>
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="mistral">Mistral AI</option>
                <option value="deepseek">DeepSeek</option>
              </Select>
            </Field>
            <Field label="Stockage (poids & datasets)">
              <Select value={s.storage} onChange={(e) => set("storage", e.target.value)}>
                <option value="s3">Amazon S3</option>
                <option value="gcs">Google Cloud Storage</option>
                <option value="azure_blob">Azure Blob</option>
                <option value="local">Disque local (serveurs)</option>
              </Select>
            </Field>
            <Field label="Sauvegardes">
              <Select value={s.backups} onChange={(e) => set("backups", e.target.value)}>
                <option value="daily">Quotidiennes</option>
                <option value="weekly">Hebdomadaires</option>
                <option value="none">Désactivées</option>
              </Select>
            </Field>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 text-sm font-medium">Rétention, versioning & quotas</div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Rétention des datasets (jours)">
              <Input type="number" value={s.retentionDays} onChange={(e) => set("retentionDays", Number(e.target.value) || 0)} />
            </Field>
            <Field label="Quota GPU (h / mois)">
              <Input type="number" value={s.quotaGpuHours} onChange={(e) => set("quotaGpuHours", Number(e.target.value) || 0)} />
            </Field>
            <Field label="Jobs parallèles max">
              <Input type="number" value={s.quotaParallelJobs} onChange={(e) => set("quotaParallelJobs", Number(e.target.value) || 1)} />
            </Field>
            <label className="flex items-center gap-2 pt-6 text-sm">
              <button
                onClick={() => set("versioning", !s.versioning)}
                className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", s.versioning ? "bg-[hsl(var(--accent-teal))]" : "bg-muted")}
                aria-pressed={s.versioning}
              >
                <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", s.versioning ? "left-[18px]" : "left-0.5")} />
              </button>
              Versioning automatique des modèles
            </label>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Les quotas s'appliquent à tout le workspace ; un job qui dépasserait le quota GPU passe en file d'attente.
          </p>
        </Card>
      </div>

      {/* Intégrations */}
      <div>
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Plug className="h-4 w-4 text-muted-foreground" /> Intégrations
          <span className="text-xs font-normal text-muted-foreground">— {connected.size}/{FT_INTEGRATIONS.length} connectées</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {FT_INTEGRATIONS.map((i) => {
            const on = connected.has(i.id);
            return (
              <Card key={i.id} className="flex flex-col p-4">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                    <PlugsConnectedIcon weight="duotone" className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1 truncate text-sm font-medium">{i.name}</div>
                  {on && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
                </div>
                <p className="mt-2 flex-1 text-[11px] text-muted-foreground">{i.description}</p>
                <Button size="sm" variant={on ? "outline" : "default"} className="mt-3 h-7 w-full text-xs" onClick={() => toggleIntegration(i.id)}>
                  {on ? "Déconnecter" : "Connecter"}
                </Button>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
