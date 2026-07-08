import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { aiopsTabPath } from "@/lib/navigation";
import { Package, Rocket, Archive, History, Copy } from "lucide-react";
import { CubeIcon } from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pill } from "../ui";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import {
  timeAgo, modelById,
  VERSION_STATUS_META, FT_METHOD_META, type TunedVersion,
} from "./data";
import { useServersDb, useFtJobsDb, useFtVersionsDb } from "./db";

export function GovFtVersionsPage() {
  const navigate = useNavigate();
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const { servers } = useServersDb();
  const { jobs } = useFtJobsDb(servers);
  const { versions, rollback, clone } = useFtVersionsDb(servers);
  const [sel, setSel] = useState<TunedVersion | null>(null);

  const deployed = versions.filter((v) => v.status === "deployed").length;

  // Group by model name so the history reads as a lineage per model (v1 → vN).
  const families = useMemo(() => {
    const m = new Map<string, TunedVersion[]>();
    versions.forEach((v) => m.set(v.name, [...(m.get(v.name) ?? []), v]));
    return [...m.entries()];
  }, [versions]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Versions"
        description="Historique de vos modèles fine-tunés : lignée par modèle, dataset et hyperparamètres d'origine, résultats, auteur — rollback, clone, deploy."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Versions" value={String(versions.length)} icon={Package} />
        <MetricCard label="En production" value={String(deployed)} icon={Rocket} />
        <MetricCard label="Archivées" value={String(versions.filter((v) => v.status === "archived").length)} icon={Archive} />
      </div>

      {versions.length === 0 ? (
        <EmptyState icon={Package} title="Aucune version" description="Terminez un job d'entraînement pour produire une première version." />
      ) : (
        <div className="space-y-4">
          {families.map(([name, list]) => (
            <Card key={name} className="overflow-hidden">
              <div className="border-b border-border/60 px-5 py-3 font-mono text-sm font-medium">{name}</div>
              <div className="divide-y divide-border/60">
                {list.map((v) => (
                  <button key={v.id} onClick={() => setSel(v)} className="flex w-full items-center gap-3 px-5 py-3 text-left text-sm transition-colors hover:bg-muted/30">
                    <span className="w-10 shrink-0 font-mono text-xs font-semibold">{v.version}</span>
                    <Pill meta={VERSION_STATUS_META[v.status]} />
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {v.dataset} · par {v.author.split("@")[0]}
                    </span>
                    <span className="hidden shrink-0 text-xs tabular-nums sm:inline">
                      <span className="text-muted-foreground">acc </span>{v.accuracy}%
                    </span>
                    <span className="shrink-0 text-xs tabular-nums">
                      <span className={v.winRate >= 60 ? "text-emerald-500" : "text-amber-500"}>{v.winRate}%</span>
                      <span className="text-muted-foreground"> win</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(v.createdAt)}</span>
                  </button>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {sel && (() => {
        const job = jobs.find((j) => j.name === sel.jobName);
        return (
          <DetailSheet
            onClose={() => setSel(null)}
            title={`${sel.name} ${sel.version}`}
            subtitle={`par ${sel.author} · ${timeAgo(sel.createdAt)}`}
            icon={<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-violet-500"><CubeIcon weight="duotone" className="h-5 w-5" /></div>}
          >
            <DetailSection title="Résultats">
              <DetailRow label="Statut"><Pill meta={VERSION_STATUS_META[sel.status]} /></DetailRow>
              <DetailRow label="Accuracy">{sel.accuracy}%</DetailRow>
              <DetailRow label="Win-rate">{sel.winRate}%</DetailRow>
              <DetailRow label="Poids">{sel.sizeGB} GB</DetailRow>
            </DetailSection>

            <DetailSection title="Traçabilité">
              <DetailRow label="Auteur">{sel.author}</DetailRow>
              <DetailRow label="Créée">{new Date(sel.createdAt).toLocaleString("fr-FR")}</DetailRow>
              <DetailRow label="Job d'origine"><span className="font-mono text-xs">{sel.jobName}</span></DetailRow>
              <DetailRow label="Modèle de base">{modelById(sel.baseModel)?.label ?? sel.baseModel}</DetailRow>
              <DetailRow label="Dataset"><code className="rounded bg-secondary px-1.5 py-0.5 text-xs">{sel.dataset}</code></DetailRow>
            </DetailSection>

            {job && (
              <DetailSection title="Hyperparamètres d'origine">
                <DetailRow label="Méthode"><Pill meta={FT_METHOD_META[job.hp.method]} /></DetailRow>
                <DetailRow label="LR / batch">{job.hp.lr} · {job.hp.batchSize}</DetailRow>
                {job.hp.method !== "full" && <DetailRow label="LoRA rank / alpha">{job.hp.loraRank} / {job.hp.loraAlpha}</DetailRow>}
                <DetailRow label="Optimizer">{job.hp.optimizer} · {job.hp.scheduler}</DetailRow>
                <DetailRow label="Époques">{job.epochs}</DetailRow>
              </DetailSection>
            )}

            <DetailSection title="Actions">
              <div className="grid grid-cols-3 gap-2">
                <Button variant="outline" size="sm" disabled={sel.status !== "archived"} title="Repasser cette version en production"
                  onClick={() => { void rollback(sel); setSel(null); }}>
                  <History className="mr-1.5 h-3.5 w-3.5" />Rollback
                </Button>
                <Button variant="outline" size="sm" title="Relancer un entraînement à partir de cette version"
                  onClick={() => { void clone(sel, job?.hp ?? { method: "lora", lr: "2e-4", batchSize: 8, loraRank: 16, warmupPct: 5, maxSeqLen: 4096, weightDecay: "0.01", optimizer: "adamw", loraAlpha: 32, dropout: 0.05, scheduler: "cosine" }, servers[0]?.id ?? null); setSel(null); }}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />Clone
                </Button>
                <Button size="sm" disabled={sel.status === "deployed"} title="Déployer via l'onglet Déploiement"
                  onClick={() => navigate(aiopsTabPath(workspaceSlug, projectSlug, "ft-deployment"))}>
                  <Rocket className="mr-1.5 h-3.5 w-3.5" />Deploy
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Rollback réactive une version archivée · Clone crée un nouveau job d'entraînement (file d'attente) · Deploy ouvre l'onglet Déploiement.
              </p>
            </DetailSection>
          </DetailSheet>
        );
      })()}
    </div>
  );
}
