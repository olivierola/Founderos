import { useMemo, useState } from "react";
import { Fingerprint, Wrench, DatabaseZap, PenLine, Globe } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { Pill, Select } from "../ui";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import { Pill as SamplePill } from "../ui";
import {
  useProjectAgents, timeAgo,
  ACCESS_ACTION_META, ACCESS_STATUS_META, type AccessAction, type AccessLog,
} from "./data";
import { useRealAccessLogs } from "./db";

const ACTION_ICON: Record<AccessAction, typeof Wrench> = {
  tool_call: Wrench, data_read: DatabaseZap, data_write: PenLine, external_call: Globe,
};

export function GovAccessLogsPage() {
  const { data: agents } = useProjectAgents();
  const roster = agents ?? [];
  const { logs } = useRealAccessLogs(agents ?? []);

  const [agentFilter, setAgentFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<AccessLog | null>(null);

  const filtered = logs.filter((l) =>
    (agentFilter === "all" || l.agentId === agentFilter) &&
    (actionFilter === "all" || l.action === actionFilter) &&
    (q === "" || `${l.target} ${l.detail} ${l.agentName}`.toLowerCase().includes(q.toLowerCase())),
  );

  const stats = useMemo(() => ({
    total: logs.length,
    writes: logs.filter((l) => l.action === "data_write").length,
    denied: logs.filter((l) => l.status === "denied").length,
  }), [logs]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accès des agents"
        description="Trace complète de ce que chaque agent a utilisé : outils appelés, données lues, données écrites, appels externes — lue depuis les événements réels de vos runs."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Événements (30 j)" value={String(stats.total)} icon={Fingerprint} />
        <MetricCard label="Écritures de données" value={String(stats.writes)} icon={PenLine} />
        <MetricCard label="Accès refusés" value={String(stats.denied)} hint="bloqués par un guardrail ou une permission" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une ressource, un outil…" className="h-9 w-64" />
        <Select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className="h-9 w-44">
          <option value="all">Tous les agents</option>
          {roster.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className="h-9 w-44">
          <option value="all">Tous les types</option>
          {Object.entries(ACCESS_ACTION_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">{filtered.length} événement{filtered.length > 1 ? "s" : ""}</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Fingerprint} title="Aucun événement" description="Aucun accès ne correspond aux filtres sélectionnés." />
      ) : (
        <Card className="divide-y divide-border/60 overflow-hidden">
          {filtered.map((l) => {
            const Icon = ACTION_ICON[l.action];
            return (
              <button key={l.id} onClick={() => setSel(l)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted/30">
                <div className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                  l.action === "data_write" ? "bg-amber-500/10 text-amber-500" :
                  l.action === "data_read" ? "bg-cyan-500/10 text-cyan-500" :
                  l.action === "external_call" ? "bg-violet-500/10 text-violet-500" :
                  "bg-blue-500/10 text-blue-500",
                )}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="rounded bg-secondary px-1.5 py-0.5 text-xs">{l.target}</code>
                    <Pill meta={ACCESS_ACTION_META[l.action]} />
                    <Pill meta={ACCESS_STATUS_META[l.status]} />
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {l.agentName} · {l.detail} · <span className="font-mono">{l.runId}</span>
                  </div>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(l.ts)}</span>
              </button>
            );
          })}
        </Card>
      )}

      {sel && (
        <DetailSheet
          onClose={() => setSel(null)}
          title={sel.target}
          subtitle={`${ACCESS_ACTION_META[sel.action].label} · ${timeAgo(sel.ts)}`}
          icon={(() => { const I = ACTION_ICON[sel.action]; return (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground"><I className="h-[18px] w-[18px]" /></div>
          ); })()}
        >
          <DetailSection title="Événement">
            <DetailRow label="Type"><Pill meta={ACCESS_ACTION_META[sel.action]} /></DetailRow>
            <DetailRow label="Statut"><Pill meta={ACCESS_STATUS_META[sel.status]} /></DetailRow>
            <DetailRow label="Cible"><code className="rounded bg-secondary px-1.5 py-0.5 text-xs">{sel.target}</code></DetailRow>
            <DetailRow label="Détail">{sel.detail}</DetailRow>
            <DetailRow label="Horodatage">{new Date(sel.ts).toLocaleString("fr-FR")}</DetailRow>
          </DetailSection>
          <DetailSection title="Contexte d'exécution">
            <DetailRow label="Agent">{sel.agentName}</DetailRow>
            <DetailRow label="Run"><span className="font-mono text-xs">{sel.runId}</span></DetailRow>
          </DetailSection>
          {sel.status !== "ok" && (
            <DetailSection title="Pourquoi ?">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {sel.status === "denied"
                  ? "Cet accès a été refusé par un guardrail ou une permission manquante. Consultez l'onglet Guardrails pour la règle correspondante, ou accordez l'accès dans la configuration de l'agent."
                  : "L'appel a échoué côté fournisseur ou ressource. Le run a appliqué sa stratégie de retry — vérifiez les Incidents ops si l'erreur persiste."}
              </p>
            </DetailSection>
          )}
        </DetailSheet>
      )}
    </div>
  );
}
