import { useMemo, useState } from "react";
import { Cloud, HardDrive, Check, Download } from "lucide-react";
import { CircuitryIcon, CloudCheckIcon } from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { Pill, Select } from "../ui";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import {
  useProjectAgents, usd,
  CLOUD_MODELS, SELF_HOSTED_MODELS, HOSTING_META, type ModelInfo,
} from "./data";
import { useServersDb, useModelStateDb, useRealPrompts } from "./db";
import { RegisteredModels } from "./RegisteredModels";

export function GovOpsModelsPage() {
  const { servers } = useServersDb();
  const { enabledCloud: enabled, installs, enableCloud, disableCloud, install: installDb } = useModelStateDb(servers);
  const { data: agents } = useProjectAgents();
  // Real per-model usage from actual agent runs.
  const { prompts } = useRealPrompts(agents ?? []);
  const [sel, setSel] = useState<ModelInfo | null>(null);
  const [installTarget, setInstallTarget] = useState<Record<string, string>>({});

  const toggleCloud = (id: string) => { void (enabled.has(id) ? disableCloud(id) : enableCloud(id)); };

  const serversWithModel = (modelId: string) =>
    servers.filter((s) => installs.some((i) => i.serverId === s.id && i.modelId === modelId && i.status === "installed"));
  const installingOn = (modelId: string) =>
    installs.filter((i) => i.modelId === modelId && i.status === "installing");

  const install = (m: ModelInfo) => {
    const target = installTarget[m.id] ?? servers[0]?.id;
    if (!target) return;
    void installDb(m.id, target);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Modèles"
        description="Choisissez les modèles de votre workforce : ajoutez vos propres APIs cloud ou endpoints, utilisez les APIs prêtes à l'emploi, ou des modèles open-source sur vos serveurs privés."
      />

      {/* ── Your own registered models (cloud key / custom endpoint) ── */}
      <RegisteredModels />

      {/* ── Cloud APIs ── */}
      <div>
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Cloud className="h-4 w-4 text-[hsl(var(--accent-teal))]" /> APIs cloud
          <span className="text-xs font-normal text-muted-foreground">— facturation au token, aucun serveur requis</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {CLOUD_MODELS.map((m) => {
            const on = enabled.has(m.id);
            return (
              <Card key={m.id} onClick={() => setSel(m)} className={cn("cursor-pointer p-4 transition-[opacity,background-color] hover:bg-muted/30", !on && "opacity-70")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[hsl(var(--accent-teal)/0.14)] text-[hsl(var(--accent-teal))]">
                      <CloudCheckIcon weight="duotone" className="h-[18px] w-[18px]" />
                    </div>
                    <div>
                      <div className="text-sm font-medium">{m.label}</div>
                      <div className="text-[11px] text-muted-foreground">{m.vendor} · {m.family}</div>
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleCloud(m.id); }}
                    className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-[hsl(var(--accent-teal))]" : "bg-muted")}
                    aria-pressed={on} aria-label={`Activer ${m.label}`}
                  >
                    <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", on ? "left-[18px]" : "left-0.5")} />
                  </button>
                </div>
                <div className="mt-3 flex items-center gap-3 border-t border-border/60 pt-2.5 text-[11px] text-muted-foreground">
                  <span>ctx {m.ctx}</span>
                  <span>{m.price} / Mtok</span>
                  <Pill meta={HOSTING_META.cloud} className="ml-auto px-1.5 py-0 text-[10px]" />
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      {/* ── Self-hosted ── */}
      <div>
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <HardDrive className="h-4 w-4 text-violet-500" /> Modèles propriétaires
          <span className="text-xs font-normal text-muted-foreground">— open-source, installés sur vos serveurs (poids locaux, zéro dépense API)</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {SELF_HOSTED_MODELS.map((m) => {
            const hosts = serversWithModel(m.id);
            const installing = installingOn(m.id);
            const isInstalled = hosts.length > 0;
            return (
              <Card key={m.id} onClick={() => setSel(m)} className="cursor-pointer p-4 transition-colors hover:bg-muted/30">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-violet-500/10 text-violet-500">
                      <CircuitryIcon weight="duotone" className="h-[18px] w-[18px]" />
                    </div>
                    <div>
                      <div className="text-sm font-medium">{m.label}</div>
                      <div className="text-[11px] text-muted-foreground">{m.vendor} · {m.family} · {m.sizeGB} GB</div>
                    </div>
                  </div>
                  <Pill meta={HOSTING_META.self_hosted} className="px-1.5 py-0 text-[10px]" />
                </div>

                {installing.length > 0 ? (
                  <div className="mt-3 border-t border-border/60 pt-2.5">
                    <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                      <span>Téléchargement des poids…</span>
                      <span className="tabular-nums">{installing[0].progressPct}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-violet-500 transition-all duration-700" style={{ width: `${installing[0].progressPct}%` }} />
                    </div>
                  </div>
                ) : isInstalled ? (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2.5">
                    {hosts.map((s) => (
                      <span key={s.id} className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                        <Check className="h-3 w-3" />{s.name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2 border-t border-border/60 pt-2.5" onClick={(e) => e.stopPropagation()}>
                    <Select
                      value={installTarget[m.id] ?? servers[0]?.id ?? ""}
                      onChange={(e) => setInstallTarget((prev) => ({ ...prev, [m.id]: e.target.value }))}
                      className="h-8 flex-1 text-xs"
                    >
                      {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                    <Button size="sm" variant="outline" className="h-8" onClick={() => install(m)}>
                      <Download className="mr-1.5 h-3.5 w-3.5" />Installer
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      {sel && (() => {
        const used = prompts.filter((p) => p.model === sel.id);
        const spend = used.reduce((s, p) => s + p.costUsd, 0);
        const hosts = serversWithModel(sel.id);
        return (
          <DetailSheet
            onClose={() => setSel(null)}
            title={sel.label}
            subtitle={`${sel.vendor} · ${sel.family}`}
            icon={
              <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
                sel.hosting === "cloud" ? "bg-[hsl(var(--accent-teal)/0.14)] text-[hsl(var(--accent-teal))]" : "bg-violet-500/10 text-violet-500")}>
                {sel.hosting === "cloud" ? <CloudCheckIcon weight="duotone" className="h-5 w-5" /> : <CircuitryIcon weight="duotone" className="h-5 w-5" />}
              </div>
            }
          >
            <DetailSection title="Modèle">
              <DetailRow label="Hébergement"><Pill meta={HOSTING_META[sel.hosting]} /></DetailRow>
              <DetailRow label="Famille">{sel.family}</DetailRow>
              <DetailRow label="Fournisseur">{sel.vendor}</DetailRow>
              <DetailRow label="Contexte">{sel.ctx}</DetailRow>
              {sel.price && <DetailRow label="Prix API">{sel.price} / Mtok</DetailRow>}
              {sel.sizeGB && <DetailRow label="Poids">{sel.sizeGB} GB</DetailRow>}
            </DetailSection>

            <DetailSection title="Usage (30 j)">
              <DetailRow label="Prompts servis">{used.length}</DetailRow>
              <DetailRow label="Dépense">{usd(spend)}</DetailRow>
              <DetailRow label="Agents">{new Set(used.map((p) => p.agentName)).size}</DetailRow>
            </DetailSection>

            {sel.hosting === "self_hosted" ? (
              <DetailSection title="Installé sur">
                {hosts.length === 0 ? <p className="text-xs text-muted-foreground">Pas encore installé — choisissez un serveur depuis la carte.</p> :
                  hosts.map((s) => <DetailRow key={s.id} label={s.name}>{s.region}</DetailRow>)}
              </DetailSection>
            ) : (
              <DetailSection title="Activation">
                <DetailRow label="État">{enabled.has(sel.id) ? "Activé pour la workforce" : "Désactivé"}</DetailRow>
              </DetailSection>
            )}
          </DetailSheet>
        );
      })()}
    </div>
  );
}
