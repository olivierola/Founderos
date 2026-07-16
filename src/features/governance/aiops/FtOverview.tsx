import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageSkeleton } from "@/components/ui/skeleton";
import { aiopsTabPath } from "@/lib/navigation";
import { Package, Rocket, Trophy, Coins, Cpu, Database, GraduationCap, ArrowRight, Loader2, ArrowDown } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Pill } from "../ui";
import {
  usd, timeAgo, FT_STATUS_META, VERSION_STATUS_META,
} from "./data";
import { useServersDb, useFtJobsDb, useFtVersionsDb, useFtDatasetsDb } from "./db";

function Tile({ label, value, hint, icon: Icon, onClick }: { label: string; value: string; hint?: string; icon: typeof Package; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-muted/30">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="font-stat-number mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </button>
  );
}

export function GovFtOverviewPage() {
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const navigate = useNavigate();
  const go = (slug: string) => navigate(aiopsTabPath(workspaceSlug, projectSlug, slug));

  const { servers, loading } = useServersDb();
  const { jobs } = useFtJobsDb(servers);
  const { versions } = useFtVersionsDb(servers);
  const { datasets } = useFtDatasetsDb();
  const data = { jobs, versions, datasets };

  if (loading) return <PageSkeleton cards={4} rows={5} />;

  const running = data.jobs.filter((j) => j.status === "running");
  const prod = data.versions.filter((v) => v.status === "deployed");
  const accs = data.versions.map((v) => v.accuracy);
  const avgAcc = accs.length ? Math.round(accs.reduce((s, a) => s + a, 0) / accs.length) : 0;
  const best = [...data.versions].sort((a, b) => b.winRate - a.winRate)[0];
  const gpuH = data.jobs.reduce((s, j) => s + j.gpuHours, 0);
  // Monthly spend = real training cost + real server infra (30 j).
  const current = Math.round((data.jobs.reduce((s, j) => s + j.costUsd, 0) + servers.reduce((s, x) => s + x.costPerDay, 0) * 30) * 100) / 100;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fine-tuning Studio"
        description="Préparez vos données, expérimentez, entraînez, évaluez, déployez et améliorez vos modèles — en continu."
      />

      {/* Widgets */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Tile label="Models" value={String(data.versions.length)} icon={Package} onClick={() => go("ft-versions")} />
        <Tile label="Training Jobs" value={`${running.length} running`} icon={GraduationCap} onClick={() => go("ops-finetuning")} />
        <Tile label="Production" value={String(prod.length)} icon={Rocket} onClick={() => go("ft-deployment")} />
        <Tile label="Accuracy moyenne" value={`${avgAcc}%`} icon={Trophy} onClick={() => go("ft-evaluation")} />
        <Tile label="Coût mensuel" value={usd(current)} icon={Coins} onClick={() => go("ft-costs")} />
        <Tile label="Heures GPU" value={`${gpuH.toFixed(0)} h`} icon={Cpu} onClick={() => go("ops-servers")} />
        <Tile label="Datasets" value={String(data.datasets.length)} icon={Database} onClick={() => go("ft-datasets")} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Meilleur modèle */}
        {best && (
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Trophy className="h-4 w-4 text-amber-500" /> Meilleur modèle
            </div>
            <button onClick={() => go("ft-versions")} className="w-full rounded-lg border border-[hsl(var(--accent-teal)/0.4)] bg-[hsl(var(--accent-teal)/0.06)] p-4 text-left transition-colors hover:bg-[hsl(var(--accent-teal)/0.12)]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium">{best.name} {best.version}</span>
                <Pill meta={VERSION_STATUS_META[best.status]} />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div><div className="font-stat-number text-lg font-semibold tabular-nums text-emerald-500">{best.winRate}%</div><div className="text-[10px] text-muted-foreground">win-rate</div></div>
                <div><div className="font-stat-number text-lg font-semibold tabular-nums">{best.accuracy}%</div><div className="text-[10px] text-muted-foreground">accuracy</div></div>
                <div><div className="font-stat-number text-lg font-semibold tabular-nums">{best.sizeGB} GB</div><div className="text-[10px] text-muted-foreground">poids</div></div>
              </div>
            </button>
            <p className="mt-3 text-[11px] text-muted-foreground">Dataset : {best.dataset} · par {best.author.split("@")[0]} · {timeAgo(best.createdAt)}</p>
          </Card>
        )}

        {/* Entraînements en cours */}
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between text-sm font-medium">
            <span className="flex items-center gap-2"><GraduationCap className="h-4 w-4 text-muted-foreground" /> Entraînements</span>
            <button onClick={() => go("ops-finetuning")} className="inline-flex items-center gap-1 text-xs text-[hsl(var(--primary-soft))] hover:underline">
              Tout voir <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          <div className="space-y-2">
            {data.jobs.slice(0, 4).map((j) => (
              <div key={j.id} className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2 text-sm">
                {j.status === "running" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-emerald-500" />}
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{j.name}</span>
                <Pill meta={FT_STATUS_META[j.status]} className="px-1.5 py-0 text-[10px]" />
                {j.status === "running" && (
                  <div className="h-1 w-20 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-emerald-500" style={{ width: `${j.progressPct}%` }} />
                  </div>
                )}
                {j.accuracy != null && <span className="text-xs tabular-nums text-emerald-500">{j.accuracy}%</span>}
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Architecture recommandée : données → RAG / FT / Outils → Agent → boucle */}
      <Card className="p-5">
        <div className="mb-4 text-sm font-medium">Fine-tuning + RAG + Agents — l'architecture d'entreprise</div>
        <div className="flex flex-col items-center gap-2 text-center text-xs">
          <div className="rounded-md border border-border bg-secondary/40 px-4 py-2">Sources de données <span className="text-muted-foreground">(tickets, docs, CRM…)</span></div>
          <ArrowDown className="h-3.5 w-3.5 text-muted-foreground" />
          <button onClick={() => go("ft-dataprep")} className="rounded-md border border-border bg-secondary/40 px-4 py-2 transition-colors hover:bg-secondary">Préparation & nettoyage</button>
          <ArrowDown className="h-3.5 w-3.5 text-muted-foreground" />
          <div className="grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-md border border-cyan-500/40 bg-cyan-500/5 px-3 py-2">
              <div className="font-medium text-cyan-600 dark:text-cyan-400">RAG</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">connaissances à jour, sans réentraîner</div>
            </div>
            <button onClick={() => go("ops-finetuning")} className="rounded-md border border-[hsl(var(--accent-teal)/0.5)] bg-[hsl(var(--accent-teal)/0.06)] px-3 py-2 transition-colors hover:bg-[hsl(var(--accent-teal)/0.12)]">
              <div className="font-medium text-[hsl(var(--accent-teal))]">Fine-tuning</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">comportement, style, compétences</div>
            </button>
            <div className="rounded-md border border-violet-500/40 bg-violet-500/5 px-3 py-2">
              <div className="font-medium text-violet-600 dark:text-violet-400">Outils & Actions</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">CRM, ERP, API, workflows</div>
            </div>
          </div>
          <ArrowDown className="h-3.5 w-3.5 text-muted-foreground" />
          <div className="rounded-md border border-border bg-secondary/40 px-4 py-2 font-medium">Agent IA d'entreprise</div>
          <ArrowDown className="h-3.5 w-3.5 text-muted-foreground" />
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <button onClick={() => go("ft-monitoring")} className="rounded bg-secondary px-2 py-1 transition-colors hover:text-foreground">Monitoring</button>
            <ArrowRight className="h-3 w-3" />
            <span className="rounded bg-secondary px-2 py-1">Feedback</span>
            <ArrowRight className="h-3 w-3" />
            <span className="rounded bg-secondary px-2 py-1">Réentraînement continu</span>
          </div>
        </div>
        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
          Le RAG apporte des connaissances fraîches (Knowledge/RAG Center), le fine-tuning fixe le comportement, et vos agents (AI Workforce)
          combinent les deux avec les outils métiers. La boucle monitoring → feedback → réentraînement garde le système performant.
        </p>
      </Card>
    </div>
  );
}
