import { useEffect, useMemo, useState } from "react";
import {
  GraduationCapIcon as GraduationCap,
  PlusIcon as Plus,
  TimerIcon as Timer,
  CoinsIcon as Coins,
  LightningIcon as Zap,
  XCircleIcon as XCircle,
  ArrowsClockwiseIcon as RefreshCw,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { PageSkeleton } from "@/components/ui/skeleton";
import { MetricCard } from "@/components/MetricCard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Pill, FormDialog, type FieldDef } from "../ui";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import {
  usd, timeAgo, modelById, hfRepoFor,
  SELF_HOSTED_MODELS, FT_STATUS_META, FT_METHOD_META, GPU_OPTIONS,
  type FinetuneJob, type FtStatus, type FtMethod,
} from "./data";
import { useServersDb, useFtJobsDb } from "./db";
import { useProvidersDb, useInfraActions } from "./infra";

/** Tiny single-hue loss sparkline (one series → one color, line encodes). */
function LossSpark({ loss, w = 96, h = 28 }: { loss: number[]; w?: number; h?: number }) {
  if (loss.length < 2) return <span className="text-[11px] text-muted-foreground">—</span>;
  const max = Math.max(...loss), min = Math.min(...loss);
  const pts = loss.map((v, i) => `${(i / (loss.length - 1)) * w},${h - ((v - min) / Math.max(0.01, max - min)) * (h - 4) - 2}`).join(" ");
  return (
    <svg width={w} height={h} className="shrink-0" aria-label={`loss ${loss[loss.length - 1]}`}>
      <polyline points={pts} fill="none" stroke="hsl(var(--accent-teal))" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Colored state dot matching the spec (🟢 running · 🟡 pending · 🔵 completed · 🔴 failed). */
const DOT: Record<FtStatus, string> = {
  running: "bg-emerald-500", queued: "bg-amber-400", succeeded: "bg-blue-500", failed: "bg-red-500",
};

export function GovOpsFinetuningPage() {
  const { servers } = useServersDb();
  // Real rows: creating a job inserts it; the ticker advances SIM jobs and
  // publishes a version into the registry when one succeeds. RunPod jobs are
  // driven by the pod's webhook instead.
  const { jobs, loading, createJob: createJobDb } = useFtJobsDb(servers);
  const { runpodProviders } = useProvidersDb();
  const infra = useInfraActions();
  const [creating, setCreating] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const sel = useMemo(() => jobs.find((j) => j.id === selId) ?? null, [jobs, selId]);

  // Poll liveness of real (RunPod) jobs still running.
  const liveReal = jobs.filter((j) => j.runtime === "runpod" && (j.status === "running" || j.status === "queued"));
  const liveSig = liveReal.map((j) => j.id).join(",");
  useEffect(() => {
    if (liveReal.length === 0) return;
    const t = setInterval(() => { liveReal.forEach((j) => void infra.syncJob(j.id)); }, 12000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSig]);

  // Basic → Advanced field order; the "· avancé" hints mark the expert block.
  const fields: FieldDef[] = [
    { key: "name", label: "Nom du job", required: true, placeholder: "support-tone-v2" },
    { key: "baseModel", label: "Modèle de base", type: "select", options: SELF_HOSTED_MODELS.map((m) => ({ value: m.id, label: `${m.label} (${m.sizeGB} GB)` })), half: true },
    { key: "serverId", label: "Serveur", type: "select", options: servers.map((s) => ({ value: s.id, label: s.name })), half: true },
    { key: "dataset", label: "Dataset (.jsonl)", required: true, placeholder: "support-conversations.jsonl" },
    { key: "gpu", label: "GPU", type: "select", options: GPU_OPTIONS.map((g) => ({ value: g, label: g })), half: true },
    { key: "epochs", label: "Époques", type: "number", half: true },
    { key: "method", label: "Méthode", type: "select", options: FT_METHOD_META, half: true },
    { key: "lr", label: "Learning rate · avancé", half: true, placeholder: "2e-4" },
    { key: "batchSize", label: "Batch size · avancé", type: "number", half: true },
    { key: "loraRank", label: "LoRA rank · avancé", type: "number", half: true },
    { key: "loraAlpha", label: "LoRA alpha · avancé", type: "number", half: true },
    { key: "dropout", label: "Dropout · avancé", type: "number", half: true },
    { key: "weightDecay", label: "Weight decay · avancé", half: true, placeholder: "0.01" },
    { key: "optimizer", label: "Optimizer · avancé", type: "select", half: true, options: [{ value: "adamw", label: "AdamW" }, { value: "adamw_8bit", label: "AdamW 8-bit" }, { value: "sgd", label: "SGD" }] },
    { key: "scheduler", label: "Scheduler · avancé", type: "select", half: true, options: [{ value: "cosine", label: "Cosine" }, { value: "linear", label: "Linear" }, { value: "constant", label: "Constant" }] },
    { key: "warmupPct", label: "Warmup % · avancé", type: "number", half: true },
    { key: "maxSeqLen", label: "Longueur max · avancé", type: "number", half: true },
    // Execution runtime: simulation, or a real GPU pod on a connected RunPod account.
    { key: "runtime", label: "Exécution", type: "select", half: true,
      options: [{ value: "sim", label: "Simulation" }, ...(runpodProviders.length ? [{ value: "runpod", label: "RunPod (réel · GPU loué)" }] : [])],
      hint: runpodProviders.length ? "RunPod entraîne réellement sur un pod (dataset .jsonl importé requis)" : "connectez RunPod (onglet Serveurs) pour l'entraînement réel" },
  ];

  const createJob = async (values: Record<string, unknown>) => {
    const baseModel = String(values.baseModel || SELF_HOSTED_MODELS[0].id);
    const runtime = String(values.runtime) === "runpod" && runpodProviders.length ? "runpod" as const : "sim" as const;
    const job: Omit<FinetuneJob, "id"> = {
      name: String(values.name), baseModel, dataset: String(values.dataset), status: "queued" as FtStatus, progressPct: 0,
      epochs: Number(values.epochs) || 3, loss: [], gpuHours: 0, costUsd: 0,
      serverId: String(values.serverId || (servers[0]?.id ?? "")), startedAt: new Date().toISOString(),
      gpu: String(values.gpu || "H100"), timeH: 0, accuracy: null,
      runtime, providerId: null, podId: null, logs: [], error: null,
      hp: {
        method: (String(values.method) || "lora") as FtMethod, lr: String(values.lr || "2e-4"),
        batchSize: Number(values.batchSize) || 8, loraRank: Number(values.loraRank) || 16,
        warmupPct: Number(values.warmupPct) || 5, maxSeqLen: Number(values.maxSeqLen) || 4096,
        weightDecay: String(values.weightDecay || "0.01"),
        optimizer: (String(values.optimizer) || "adamw") as FinetuneJob["hp"]["optimizer"],
        loraAlpha: Number(values.loraAlpha) || 32, dropout: Number(values.dropout) || 0.05,
        scheduler: (String(values.scheduler) || "cosine") as FinetuneJob["hp"]["scheduler"],
      },
    };
    const row = await createJobDb(job, { runtime, hfRepo: hfRepoFor(baseModel) });
    if (runtime === "runpod" && row?.id && runpodProviders[0]) {
      try { await infra.launchJob(String(row.id), runpodProviders[0].id); }
      catch (e) { alert(`Lancement RunPod échoué : ${e instanceof Error ? e.message : e}`); }
    }
  };

  if (loading) return <PageSkeleton cards={4} rows={6} />;

  const running = jobs.filter((j) => j.status === "running").length;
  const gpuHours = jobs.reduce((s, j) => s + j.gpuHours, 0);
  const spend = jobs.reduce((s, j) => s + j.costUsd, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Entraînements"
        description="Lancez et suivez vos jobs de fine-tuning — hyperparamètres Basic/Advanced, progression, loss, coût GPU."
        actions={<Button onClick={() => setCreating(true)}><Plus className="mr-1.5 h-4 w-4" />Job</Button>}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Jobs en cours" value={String(running)} icon={GraduationCap} />
        <MetricCard label="Heures GPU (30 j)" value={gpuHours.toFixed(1)} icon={Timer} />
        <MetricCard label="Coût entraînement" value={usd(spend)} icon={Coins} />
      </div>

      {/* Table des jobs — Nom · Dataset · Modèle · Date · GPU · Temps · Coût · Accuracy · État */}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Nom</th>
                <th className="px-3 py-2.5 font-medium">Dataset</th>
                <th className="px-3 py-2.5 font-medium">Modèle</th>
                <th className="px-3 py-2.5 font-medium">Date</th>
                <th className="px-3 py-2.5 font-medium">GPU</th>
                <th className="px-3 py-2.5 text-right font-medium">Temps</th>
                <th className="px-3 py-2.5 text-right font-medium">Coût</th>
                <th className="px-3 py-2.5 text-right font-medium">Accuracy</th>
                <th className="px-3 py-2.5 font-medium">État</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {jobs.map((j) => (
                <tr key={j.id} onClick={() => setSelId(j.id)} className="cursor-pointer transition-colors hover:bg-muted/30">
                  <td className="px-4 py-2.5">
                    <div className="font-mono text-xs font-medium">{j.name}</div>
                    {j.status === "running" && (
                      <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${j.progressPct}%` }} />
                      </div>
                    )}
                  </td>
                  <td className="max-w-[140px] truncate px-3 py-2.5 text-xs text-muted-foreground">{j.dataset}</td>
                  <td className="px-3 py-2.5 text-xs">{modelById(j.baseModel)?.label ?? j.baseModel}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{timeAgo(j.startedAt)}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{j.gpu}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-xs">{j.timeH > 0 ? `${j.timeH} h` : "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-xs">{j.costUsd > 0 ? usd(j.costUsd) : "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-xs">
                    {j.accuracy != null ? <span className="font-medium text-emerald-500">{j.accuracy}%</span> : "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span className={cn("h-2 w-2 rounded-full", DOT[j.status], j.status === "running" && "animate-pulse")} />
                      {FT_STATUS_META[j.status].label}
                      {j.runtime === "runpod" && <Pill meta={{ label: "réel", tone: "violet" }} className="px-1 py-0 text-[9px]" />}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {sel && (() => { const base = modelById(sel.baseModel); const server = servers.find((s) => s.id === sel.serverId); return (
        <DetailSheet
          onClose={() => setSelId(null)}
          title={sel.name}
          subtitle={`Fine-tuning · ${timeAgo(sel.startedAt)}`}
          icon={<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground"><GraduationCap className="h-[18px] w-[18px]" /></div>}
          actions={sel.runtime === "runpod" && (sel.status === "running" || sel.status === "queued")
            ? <Button size="sm" variant="outline" className="h-8 text-red-500" onClick={() => { if (confirm("Annuler l'entraînement et terminer le pod ?")) void infra.cancelJob(sel.id); }}><XCircle className="mr-1.5 h-3.5 w-3.5" />Annuler</Button>
            : undefined}
        >
          <DetailSection title="Configuration">
            <DetailRow label="État"><Pill meta={FT_STATUS_META[sel.status]} /></DetailRow>
            <DetailRow label="Modèle de base">{base?.label ?? sel.baseModel}{base?.sizeGB ? ` · ${base.sizeGB} GB` : ""}</DetailRow>
            <DetailRow label="Dataset"><code className="rounded bg-secondary px-1.5 py-0.5 text-xs">{sel.dataset}</code></DetailRow>
            <DetailRow label="Serveur">{server?.name ?? sel.serverId} · {sel.gpu}</DetailRow>
            <DetailRow label="Démarré">{new Date(sel.startedAt).toLocaleString("fr-FR")}</DetailRow>
            {sel.accuracy != null && <DetailRow label="Accuracy"><span className="font-medium text-emerald-500">{sel.accuracy}%</span></DetailRow>}
          </DetailSection>

          {sel.runtime === "runpod" && (
            <DetailSection title="Exécution RunPod (réelle)">
              <DetailRow label="Runtime"><span className="inline-flex items-center gap-1"><Zap className="h-3.5 w-3.5 text-violet-500" />GPU loué · axolotl QLoRA</span></DetailRow>
              <DetailRow label="Pod"><span className="font-mono text-xs">{sel.podId ?? "—"}</span></DetailRow>
              {sel.error && <DetailRow label="Erreur"><span className="text-red-500">{sel.error}</span></DetailRow>}
              {sel.logs.length > 0 && (
                <pre className="scrollbar-slim mt-2 max-h-40 overflow-y-auto rounded-md border border-border bg-[#0b0b0f] p-2.5 text-[10px] leading-relaxed text-zinc-300">
                  {sel.logs.slice(-40).join("\n")}
                </pre>
              )}
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline" className="h-8" onClick={() => void infra.syncJob(sel.id)}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Rafraîchir</Button>
              </div>
            </DetailSection>
          )}

          <DetailSection title="Hyperparamètres">
            <DetailRow label="Méthode"><Pill meta={FT_METHOD_META[sel.hp.method]} /></DetailRow>
            <DetailRow label="Learning rate"><code className="rounded bg-secondary px-1.5 py-0.5 text-xs">{sel.hp.lr}</code></DetailRow>
            <DetailRow label="Époques">{sel.epochs}</DetailRow>
            <DetailRow label="Batch size">{sel.hp.batchSize}</DetailRow>
            {sel.hp.method !== "full" && <DetailRow label="LoRA rank / alpha">{sel.hp.loraRank} / {sel.hp.loraAlpha}</DetailRow>}
            <DetailRow label="Dropout">{sel.hp.dropout}</DetailRow>
            <DetailRow label="Weight decay">{sel.hp.weightDecay}</DetailRow>
            <DetailRow label="Optimizer">{sel.hp.optimizer}</DetailRow>
            <DetailRow label="Scheduler">{sel.hp.scheduler} · warmup {sel.hp.warmupPct}%</DetailRow>
            <DetailRow label="Longueur max">{sel.hp.maxSeqLen.toLocaleString("fr-FR")} tokens</DetailRow>
          </DetailSection>

          <DetailSection title="Progression">
            <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
              <span>avancement</span><span className="tabular-nums">{sel.progressPct}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full", sel.status === "failed" ? "bg-red-500" : "bg-[hsl(var(--accent-teal))]")} style={{ width: `${sel.progressPct}%` }} />
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2 text-center">
              <div><div className="text-sm font-semibold tabular-nums">{Math.min(sel.epochs, Math.max(1, Math.ceil((sel.progressPct / 100) * sel.epochs)))} / {sel.epochs}</div><div className="text-[10px] text-muted-foreground">epoch</div></div>
              <div><div className="text-sm font-semibold tabular-nums">{sel.loss.length ? sel.loss[sel.loss.length - 1] : "—"}</div><div className="text-[10px] text-muted-foreground">loss</div></div>
              <div><div className="text-sm font-semibold tabular-nums">{sel.accuracy != null ? `${sel.accuracy}%` : "—"}</div><div className="text-[10px] text-muted-foreground">accuracy</div></div>
              <div><div className="text-sm font-semibold tabular-nums">{sel.status === "running" ? `${Math.max(2, Math.round((100 - sel.progressPct) * 0.8))} min` : "—"}</div><div className="text-[10px] text-muted-foreground">ETA</div></div>
            </div>
          </DetailSection>

          <DetailSection title="Courbe de loss">
            {sel.loss.length >= 2 ? (
              <div className="rounded-md border border-border bg-card p-3">
                <LossSpark loss={sel.loss} w={340} h={110} />
                <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                  <span>début {sel.loss[0]}</span>
                  <span>actuel <span className="font-medium text-foreground">{sel.loss[sel.loss.length - 1]}</span></span>
                </div>
              </div>
            ) : <p className="text-xs text-muted-foreground">Pas encore de points de loss.</p>}
          </DetailSection>

          <DetailSection title="Coût">
            <DetailRow label="Temps d'entraînement">{sel.timeH > 0 ? `${sel.timeH} h` : "—"}</DetailRow>
            <DetailRow label="Heures GPU">{sel.gpuHours} h</DetailRow>
            <DetailRow label="Coût total"><span className="font-medium">{usd(sel.costUsd)}</span></DetailRow>
          </DetailSection>
        </DetailSheet>
      ); })()}

      {creating && (
        <FormDialog
          title="Nouveau job de fine-tuning"
          fields={fields}
          initial={{
            name: "", baseModel: SELF_HOSTED_MODELS[0].id, serverId: servers[0]?.id ?? "", dataset: "", epochs: 3,
            method: "lora", lr: "2e-4", batchSize: 8, loraRank: 16, loraAlpha: 32, dropout: 0.05,
            weightDecay: "0.01", optimizer: "adamw", scheduler: "cosine", warmupPct: 5, maxSeqLen: 4096,
            runtime: "sim",
          }}
          submitLabel="Lancer"
          onClose={() => setCreating(false)}
          onSubmit={createJob}
        />
      )}
    </div>
  );
}
