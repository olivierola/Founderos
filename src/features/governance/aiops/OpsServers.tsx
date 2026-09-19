import { useEffect, useState } from "react";
import {
  HardDrivesIcon as Server,
  CpuIcon as Cpu,
  PulseIcon as Activity,
  RocketLaunchIcon as Rocket,
  CloudIcon as Cloud,
  PlayIcon as Play,
  SquareIcon as Square,
  TrashIcon as Trash2,
  ArrowsClockwiseIcon as RefreshCw,
  LightningIcon as Zap,
} from "@phosphor-icons/react";
import { HardDrivesIcon, CircuitryIcon } from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Pill } from "../ui";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import {
  usd, modelById,
  SERVER_STATUS_META, HOSTING_META, type PrivateServer, type Deployment,
} from "./data";
import { useServersDb, useAgentDeploymentsDb } from "./db";
import { ProvidersPanel } from "./ProvidersPanel";
import { useInfraActions, useCostReconciler } from "./infra";

/** Load bar — the fill color IS the state: calm below 60%, amber to 85%, red above. */
function LoadBar({ label, pct }: { label: string; pct: number }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("font-medium tabular-nums", pct >= 85 ? "text-red-500" : pct >= 60 ? "text-amber-500" : "text-foreground")}>{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", pct >= 85 ? "bg-red-500" : pct >= 60 ? "bg-amber-500" : "bg-[hsl(var(--accent-teal))]")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ServerCard({ s, onClick }: { s: PrivateServer; onClick: () => void }) {
  return (
    <Card className="cursor-pointer p-4 transition-colors hover:bg-muted/30" onClick={onClick}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[hsl(var(--accent-teal)/0.14)] text-[hsl(var(--accent-teal))]">
            <HardDrivesIcon weight="duotone" className="h-5 w-5" />
          </div>
          <div>
            <div className="font-medium">{s.name}</div>
            <div className="text-[11px] text-muted-foreground">{s.region} · {s.gpu}</div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Pill meta={SERVER_STATUS_META[s.status]} />
          {s.source === "runpod" && <Pill meta={{ label: "Loué · RunPod", tone: "violet" }} className="px-1.5 py-0 text-[10px]" />}
          {s.source === "ovh" && <Pill meta={{ label: "OVHcloud", tone: "cyan" }} className="px-1.5 py-0 text-[10px]" />}
          {s.source === "aws" && <Pill meta={{ label: "AWS · simulé", tone: "blue" }} className="px-1.5 py-0 text-[10px]" />}
        </div>
      </div>

      {(s.source === "runpod" || s.source === "ovh" || s.source === "aws") && (
        <div className="mt-2 flex flex-wrap gap-1">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{s.gpuCount}× · {s.cloudType === "community" ? "Community" : "Secure"}</span>
          {s.quantization && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">quant {s.quantization}</span>}
          {s.dockerImage && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{s.dockerImage.replace("vllm/", "").replace(":latest", "")}</span>}
        </div>
      )}

      <div className="mt-4 space-y-2.5">
        <LoadBar label="GPU" pct={s.gpuPct} />
        <LoadBar label="CPU" pct={s.cpuPct} />
        <LoadBar label="RAM" pct={s.ramPct} />
      </div>

      <div className="mt-4 flex flex-wrap gap-1">
        {s.installedModels.map((id) => {
          const m = modelById(id);
          return m ? (
            <span key={id} className="inline-flex items-center gap-1 rounded bg-violet-500/10 px-1.5 py-0.5 text-[11px] text-violet-600 dark:text-violet-400">
              <CircuitryIcon weight="duotone" className="h-3 w-3" />{m.label}
            </span>
          ) : null;
        })}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border/60 pt-3 text-center">
        <div><div className="text-sm font-semibold tabular-nums">{s.reqPerMin}</div><div className="text-[10px] text-muted-foreground">req/min</div></div>
        <div><div className="text-sm font-semibold tabular-nums">{s.uptimePct}%</div><div className="text-[10px] text-muted-foreground">uptime 30 j</div></div>
        <div><div className="text-sm font-semibold tabular-nums">{usd(s.costPerDay)}</div><div className="text-[10px] text-muted-foreground">/ jour</div></div>
      </div>
    </Card>
  );
}

export function GovOpsServersPage() {
  const { servers } = useServersDb();
  const { deployments, hasAgents } = useAgentDeploymentsDb(servers);
  const infra = useInfraActions();
  // Persist real billing segments while paid pods run on this page too.
  useCostReconciler(servers);

  const online = servers.filter((s) => s.status === "online").length;
  const rented = servers.filter((s) => s.source === "runpod" || s.source === "ovh" || s.source === "aws");
  const selfHosted = deployments.filter((d) => d.target !== "cloud").length;
  const infraDay = servers.reduce((s, x) => s + x.costPerDay, 0);
  const [sel, setSel] = useState<{ kind: "server"; s: PrivateServer } | { kind: "deploy"; d: Deployment } | null>(null);
  const [podBusy, setPodBusy] = useState(false);

  // Poll real rented compute for status (only while some is non-terminal).
  const pending = rented.filter((s) => {
    const d = s.desiredStatus ?? "";
    if (["STOPPED", "EXITED"].includes(d)) return false;
    return s.status !== "online";
  });
  const pendingSig = pending.map((s) => s.id).join(",");
  useEffect(() => {
    if (pending.length === 0) return;
    const t = setInterval(() => { pending.forEach((s) => void infra.sync(s.id)); }, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSig]);

  const selServer = sel?.kind === "server" ? (servers.find((s) => s.id === sel.s.id) ?? sel.s) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Serveurs & déploiements"
        description="Vos serveurs d'inférence — endpoints cloud de vos modèles ou GPU loués (RunPod, OVHcloud, AWS) — leur charge, coût, et où chaque agent est déployé."
      />

      <ProvidersPanel />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Serveurs en ligne" value={`${online}/${servers.length}`} icon={Server} />
        <MetricCard label="GPU loués (cloud)" value={String(rented.length)} icon={Zap} />
        <MetricCard label="Agents auto-hébergés" value={`${selfHosted}/${deployments.length}`} icon={Cpu} hint="le reste tourne sur des APIs cloud" />
        <MetricCard label="Coût infra / jour" value={usd(infraDay)} icon={Activity} />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {servers.map((s) => <ServerCard key={s.id} s={s} onClick={() => setSel({ kind: "server", s })} />)}
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border/60 px-5 py-3.5 text-sm font-medium">
          <Rocket className="h-4 w-4 text-muted-foreground" /> Déploiements d'agents
          {!hasAgents && <span className="text-xs font-normal text-muted-foreground">— recrutez des agents (AI Workforce) pour les voir ici</span>}
        </div>
        <div className="divide-y divide-border/60">
          {deployments.map((d) => {
            const m = modelById(d.model);
            const server = servers.find((s) => s.id === d.target);
            return (
              <button key={d.agentId} onClick={() => setSel({ kind: "deploy", d })} className="flex w-full items-center gap-3 px-5 py-3 text-left text-sm transition-colors hover:bg-muted/30">
                <span className="w-40 truncate font-medium">{d.agentName}</span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
                  {d.target === "cloud"
                    ? <><Cloud className="h-3.5 w-3.5" /> API cloud</>
                    : <><Server className="h-3.5 w-3.5" /> {server?.name ?? d.target}</>}
                  <span className="text-border">·</span>
                  <span className="truncate text-foreground/80">{m?.label ?? d.model}</span>
                  {m && <Pill meta={HOSTING_META[m.hosting]} className="px-1.5 py-0 text-[10px]" />}
                </span>
                <span className={cn("rounded-full px-2 py-0.5 text-[11px]", d.env === "prod" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-secondary text-muted-foreground")}>
                  {d.env}
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      {selServer && (
        <DetailSheet
          onClose={() => setSel(null)}
          title={selServer.name}
          subtitle={`${selServer.region} · ${selServer.gpu}`}
          icon={<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--accent-teal)/0.14)] text-[hsl(var(--accent-teal))]"><HardDrivesIcon weight="duotone" className="h-5 w-5" /></div>}
        >
          {(selServer.source === "runpod" || selServer.source === "ovh" || selServer.source === "aws") && (
            <DetailSection title={selServer.source === "ovh" ? "Instance OVHcloud (réelle)" : selServer.source === "aws" ? "Instance AWS (simulée)" : "Pod RunPod (réel)"}>
              <DetailRow label={selServer.source === "runpod" ? "Pod" : "Instance"}><span className="font-mono text-xs">{selServer.podId}</span></DetailRow>
              <DetailRow label="État souhaité">{selServer.desiredStatus ?? "—"}</DetailRow>
              <DetailRow label="GPU">{selServer.gpuCount}× · {selServer.cloudType === "community" ? "Community" : "Secure"}{selServer.quantization ? ` · quant ${selServer.quantization}` : ""}</DetailRow>
              <DetailRow label="Coût horaire">{usd(selServer.hourlyUsd)} / h</DetailRow>
              {selServer.accruedCostUsd > 0 && (
                <DetailRow label="Facturé (cumul)">{selServer.accruedHours.toFixed(1)} h · {usd(selServer.accruedCostUsd)}</DetailRow>
              )}
              {selServer.servedModel && <DetailRow label="Modèle servi"><span className="truncate font-mono text-[11px]">{selServer.servedModel}</span></DetailRow>}
              {selServer.endpointUrl ? <DetailRow label="Endpoint"><span className="truncate font-mono text-[11px]">{selServer.endpointUrl}</span></DetailRow>
                : <DetailRow label="Endpoint">simulé / en cours de provision</DetailRow>}
              <div className="mt-3 grid grid-cols-4 gap-2">
                <Button size="sm" variant="outline" disabled={podBusy} onClick={async () => { setPodBusy(true); try { await infra.sync(selServer.id); } finally { setPodBusy(false); } }}><RefreshCw className="h-3.5 w-3.5" /></Button>
                {selServer.status === "offline"
                  ? <Button size="sm" variant="outline" disabled={podBusy} onClick={async () => { setPodBusy(true); try { await infra.start(selServer.id); } finally { setPodBusy(false); } }}><Play className="mr-1 h-3.5 w-3.5" />Start</Button>
                  : <Button size="sm" variant="outline" disabled={podBusy} onClick={async () => { setPodBusy(true); try { await infra.stop(selServer.id); } finally { setPodBusy(false); } }}><Square className="mr-1 h-3.5 w-3.5" />Stop</Button>}
                <Button size="sm" variant="outline" className="col-span-2 text-red-500" disabled={podBusy} onClick={async () => { if (!confirm("Terminer et supprimer ce pod ? (facturation arrêtée)")) return; setPodBusy(true); try { await infra.terminate(selServer.id); setSel(null); } finally { setPodBusy(false); } }}><Trash2 className="mr-1 h-3.5 w-3.5" />Terminer</Button>
              </div>
            </DetailSection>
          )}
          <DetailSection title="État">
            <DetailRow label="Statut"><Pill meta={SERVER_STATUS_META[selServer.status]} /></DetailRow>
            <DetailRow label="GPU">{selServer.gpuPct}%</DetailRow>
            <DetailRow label="CPU">{selServer.cpuPct}%</DetailRow>
            <DetailRow label="RAM">{selServer.ramPct}%</DetailRow>
            <DetailRow label="Débit">{selServer.reqPerMin} req/min</DetailRow>
            <DetailRow label="Uptime 30 j">{selServer.uptimePct}%</DetailRow>
            <DetailRow label="Coût">{usd(selServer.costPerDay)} / jour</DetailRow>
          </DetailSection>
          <DetailSection title="Modèles installés">
            <div className="flex flex-wrap gap-1">
              {selServer.installedModels.length === 0 ? <span className="text-xs text-muted-foreground">Aucun</span> :
                selServer.installedModels.map((id) => {
                  const m = modelById(id);
                  return <span key={id} className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[11px] text-violet-600 dark:text-violet-400">{m?.label ?? id}{m?.sizeGB ? ` · ${m.sizeGB} GB` : ""}</span>;
                })}
            </div>
          </DetailSection>
          <DetailSection title="Agents déployés ici">
            {deployments.filter((d) => d.target === selServer.id).length === 0
              ? <p className="text-xs text-muted-foreground">Aucun agent sur ce serveur.</p>
              : deployments.filter((d) => d.target === selServer.id).map((d) => (
                  <DetailRow key={d.agentId} label={d.agentName}>{modelById(d.model)?.label ?? d.model} · {d.env}</DetailRow>
                ))}
          </DetailSection>
        </DetailSheet>
      )}

      {sel?.kind === "deploy" && (() => { const m = modelById(sel.d.model); const server = servers.find((s) => s.id === sel.d.target); return (
        <DetailSheet onClose={() => setSel(null)} title={sel.d.agentName} subtitle="Déploiement d'agent">
          <DetailSection title="Cible">
            <DetailRow label="Hébergement">{sel.d.target === "cloud" ? <Pill meta={HOSTING_META.cloud} /> : <Pill meta={HOSTING_META.self_hosted} />}</DetailRow>
            <DetailRow label="Backend">{sel.d.target === "cloud" ? "API cloud" : server?.name ?? sel.d.target}</DetailRow>
            {server && <DetailRow label="Région">{server.region}</DetailRow>}
            <DetailRow label="Environnement">{sel.d.env}</DetailRow>
          </DetailSection>
          <DetailSection title="Modèle">
            {m ? (
              <>
                <DetailRow label="Modèle">{m.label}</DetailRow>
                <DetailRow label="Fournisseur">{m.vendor} · {m.family}</DetailRow>
                <DetailRow label="Contexte">{m.ctx}</DetailRow>
                {m.price && <DetailRow label="Prix">{m.price} / Mtok</DetailRow>}
                {m.sizeGB && <DetailRow label="Poids">{m.sizeGB} GB</DetailRow>}
              </>
            ) : <p className="text-xs text-muted-foreground">{sel.d.model}</p>}
          </DetailSection>
        </DetailSheet>
      ); })()}
    </div>
  );
}
