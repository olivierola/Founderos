import { useMemo, useState } from "react";
import {
  FlaskIcon as Beaker,
  TrophyIcon as Trophy,
  CircleNotchIcon as Loader2,
  PlusIcon as Plus,
} from "@phosphor-icons/react";
import { TestTubeIcon } from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Pill, FormDialog, type FieldDef } from "../ui";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import { timeAgo, SELF_HOSTED_MODELS, type FtExperiment } from "./data";
import { useFtExperimentsDb, useFtDatasetsDb } from "./db";

export function GovFtExperimentsPage() {
  const { experiments, createExperiment } = useFtExperimentsDb();
  const { datasets } = useFtDatasetsDb();
  const [sel, setSel] = useState<FtExperiment | null>(null);
  const [creating, setCreating] = useState(false);

  const runsTotal = experiments.reduce((s, e) => s + e.runs.length, 0);

  const fields: FieldDef[] = [
    { key: "name", label: "Nom de l'expérience", required: true, placeholder: "exp-llm-vs-qlora" },
    { key: "goal", label: "Objectif", required: true, placeholder: "Meilleur modèle pour le support client", half: true },
    { key: "dataset", label: "Dataset", type: "select", half: true, required: true,
      options: datasets.map((d) => ({ value: d.name, label: d.name })) },
    { key: "model1", label: "Modèle 1 · avancé", type: "select", half: true, options: SELF_HOSTED_MODELS.map((m) => ({ value: m.id, label: m.label })) },
    { key: "model2", label: "Modèle 2 · avancé", type: "select", half: true, options: SELF_HOSTED_MODELS.map((m) => ({ value: m.id, label: m.label })) },
    { key: "model3", label: "Modèle 3 · avancé", type: "select", half: true, options: SELF_HOSTED_MODELS.map((m) => ({ value: m.id, label: m.label })) },
  ];

  const create = async (values: Record<string, unknown>) => {
    await createExperiment({
      name: String(values.name), goal: String(values.goal), dataset: String(values.dataset),
      models: [String(values.model1 ?? ""), String(values.model2 ?? ""), String(values.model3 ?? "")],
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Experiments"
        description="Chaque entraînement devient une expérience : comparez plusieurs modèles, datasets ou hyperparamètres sur le même objectif, puis gardez le vainqueur."
        actions={<Button onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" />Expérience</Button>}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Expériences" value={String(experiments.length)} icon={Beaker} />
        <MetricCard label="Runs comparés" value={String(runsTotal)} />
        <MetricCard label="En cours" value={String(experiments.filter((e) => e.status === "running").length)} />
      </div>

      <div className="space-y-3">
        {experiments.map((e) => (
          <Card key={e.id} className="cursor-pointer p-4 transition-colors hover:bg-muted/30" onClick={() => setSel(e)}>
            <div className="flex flex-wrap items-center gap-2">
              <TestTubeIcon weight="duotone" className="h-4 w-4 text-violet-500" />
              <span className="font-mono text-sm font-medium">{e.name}</span>
              {e.status === "running"
                ? <span className="inline-flex items-center gap-1 text-xs text-blue-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />en cours</span>
                : <Pill meta={{ label: "Terminée", tone: "emerald" }} />}
              <span className="text-xs text-muted-foreground">{e.goal} · {e.dataset}</span>
              <span className="ml-auto text-xs text-muted-foreground">{timeAgo(e.ts)}</span>
            </div>
            {/* Mini comparaison : accuracy par run, vainqueur souligné */}
            <div className="mt-3 space-y-1.5">
              {e.runs.map((run) => {
                const isWinner = run.model === e.winner && e.status === "done";
                const max = Math.max(...e.runs.map((x) => x.accuracy));
                return (
                  <div key={run.model} className="flex items-center gap-2 text-xs">
                    <span className={cn("w-56 truncate", isWinner ? "font-medium" : "text-muted-foreground")}>
                      {isWinner && <Trophy className="mr-1 inline h-3 w-3 text-amber-500" />}{run.model}
                    </span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full", isWinner ? "bg-[hsl(var(--accent-teal))]" : "bg-muted-foreground/40")}
                        style={{ width: `${(run.accuracy / max) * 100}%` }}
                      />
                    </div>
                    <span className="w-12 shrink-0 text-right tabular-nums">{run.accuracy}%</span>
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
      </div>

      {sel && (
        <DetailSheet
          onClose={() => setSel(null)}
          title={sel.name}
          subtitle={`${sel.goal} · ${timeAgo(sel.ts)}`}
          icon={<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-violet-500"><TestTubeIcon weight="duotone" className="h-5 w-5" /></div>}
        >
          <DetailSection title="Expérience">
            <DetailRow label="Objectif">{sel.goal}</DetailRow>
            <DetailRow label="Dataset"><code className="rounded bg-secondary px-1.5 py-0.5 text-xs">{sel.dataset}</code></DetailRow>
            <DetailRow label="Statut">{sel.status === "done" ? "Terminée" : "En cours"}</DetailRow>
            {sel.status === "done" && <DetailRow label="Vainqueur"><span className="inline-flex items-center gap-1 font-medium"><Trophy className="h-3.5 w-3.5 text-amber-500" />{sel.winner}</span></DetailRow>}
          </DetailSection>

          <DetailSection title="Résultats par run">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-2 font-medium">Run</th>
                    <th className="px-2 py-2 text-right font-medium">Acc.</th>
                    <th className="px-2 py-2 text-right font-medium">F1</th>
                    <th className="px-2 py-2 text-right font-medium">Latence</th>
                    <th className="py-2 pl-2 text-right font-medium">$/ktok</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {sel.runs.map((run) => {
                    const isWinner = run.model === sel.winner && sel.status === "done";
                    return (
                      <tr key={run.model} className={cn(isWinner && "bg-[hsl(var(--accent-teal)/0.07)]")}>
                        <td className="py-2 pr-2">{isWinner && <Trophy className="mr-1 inline h-3 w-3 text-amber-500" />}{run.model}</td>
                        <td className="px-2 py-2 text-right tabular-nums font-medium">{run.accuracy}%</td>
                        <td className="px-2 py-2 text-right tabular-nums">{run.f1}%</td>
                        <td className="px-2 py-2 text-right tabular-nums">{run.latencyMs} ms</td>
                        <td className="py-2 pl-2 text-right tabular-nums">${run.costPerKTok}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </DetailSection>

          <DetailSection title="Cycle">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Experiment → Dataset → Hyperparameters → Training → Evaluation → Metrics → Version.
              Promouvoir le vainqueur crée une version dans le Model Registry, prête pour le déploiement.
            </p>
          </DetailSection>
        </DetailSheet>
      )}

      {creating && (
        <FormDialog
          title="Nouvelle expérience"
          fields={fields}
          initial={{ name: "", goal: "", dataset: datasets[0]?.name ?? "", model1: "", model2: "", model3: "" }}
          submitLabel="Lancer l'expérience"
          onClose={() => setCreating(false)}
          onSubmit={create}
        />
      )}
    </div>
  );
}
