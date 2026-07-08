import { useMemo, useState } from "react";
import { ServerCrash, Server, Flame } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pill, Select } from "../ui";
import { SEVERITY_META } from "../shared";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import {
  timeAgo,
  INFRA_KIND_META, OPS_STATUS_META, type InfraIncident, type InfraKind,
} from "./data";
import { useServersDb, useInfraIncidentsDb } from "./db";

const REMEDIATION: Record<InfraKind, string> = {
  gpu_oom: "Réduire la taille de batch ou le contexte max du modèle ; envisager la quantisation (AWQ/GPTQ) ou un GPU plus grand.",
  disk_full: "Purger les checkpoints anciens et activer une rotation automatique ; surveiller /var/models avec une alerte à 80%.",
  network_latency: "Rapprocher l'agent de son backend (même région) ou activer un cache de réponses pour les requêtes répétitives.",
  service_down: "Vérifier les logs vLLM et le watchdog ; configurer la bascule cloud automatique comme filet de sécurité permanent.",
  overheat: "Contrôler la ventilation/le refroidissement du châssis ; plafonner la puissance GPU (nvidia-smi -pl) en attendant.",
  driver_crash: "Épingler la version de driver validée et tester les mises à jour CUDA sur un serveur de staging d'abord.",
};

export function GovOpsInfraIncidentsPage() {
  const { servers } = useServersDb();
  const { incidents, setStatus } = useInfraIncidentsDb(servers);

  const [serverFilter, setServerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sel, setSel] = useState<InfraIncident | null>(null);

  const filtered = incidents.filter((i) =>
    (serverFilter === "all" || i.serverId === serverFilter) &&
    (statusFilter === "all" || i.status === statusFilter),
  );

  const stats = useMemo(() => ({
    open: incidents.filter((i) => i.status !== "resolved").length,
    critical: incidents.filter((i) => i.severity === "critical" || i.severity === "high").length,
    servers: new Set(incidents.filter((i) => i.status !== "resolved").map((i) => i.serverId)).size,
  }), [incidents]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Incidents infrastructure"
        description="Santé de vos serveurs d'inférence : OOM GPU, disques, réseau, surchauffe — avec cause et impact sur le service."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Incidents ouverts" value={String(stats.open)} icon={ServerCrash} />
        <MetricCard label="Sévérité haute+" value={String(stats.critical)} icon={Flame} />
        <MetricCard label="Serveurs affectés" value={String(stats.servers)} icon={Server} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={serverFilter} onChange={(e) => setServerFilter(e.target.value)} className="h-9 w-44">
          <option value="all">Tous les serveurs</option>
          {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-9 w-40">
          <option value="all">Tous statuts</option>
          {Object.entries(OPS_STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">{filtered.length} incident{filtered.length > 1 ? "s" : ""}</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={ServerCrash} title="Aucun incident infra" description="Vos serveurs tournent sans accroc sur la période." />
      ) : (
        <div className="space-y-2">
          {filtered.map((i) => (
            <Card key={i.id} className="cursor-pointer p-4 transition-colors hover:bg-muted/30" onClick={() => setSel(i)}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{i.serverName}</span>
                <Pill meta={INFRA_KIND_META[i.kind]} />
                <Pill meta={SEVERITY_META[i.severity]} />
                <Pill meta={OPS_STATUS_META[i.status]} />
                <span className="ml-auto text-xs text-muted-foreground">{timeAgo(i.ts)}</span>
              </div>
              <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                <p><span className="font-medium text-foreground/80">Cause :</span> {i.cause}</p>
                <p><span className="font-medium text-foreground/80">Impact :</span> {i.impact}</p>
              </div>
            </Card>
          ))}
        </div>
      )}

      {sel && (
        <DetailSheet
          onClose={() => setSel(null)}
          title={`${sel.serverName} — ${INFRA_KIND_META[sel.kind].label}`}
          subtitle={timeAgo(sel.ts)}
        >
          <DetailSection title="Incident">
            <DetailRow label="Serveur">{sel.serverName}</DetailRow>
            <DetailRow label="Type"><Pill meta={INFRA_KIND_META[sel.kind]} /></DetailRow>
            <DetailRow label="Sévérité"><Pill meta={SEVERITY_META[sel.severity]} /></DetailRow>
            <DetailRow label="Statut"><Pill meta={OPS_STATUS_META[sel.status]} /></DetailRow>
            <DetailRow label="Horodatage">{new Date(sel.ts).toLocaleString("fr-FR")}</DetailRow>
          </DetailSection>
          <DetailSection title="Cause">
            <p className="text-[13px] leading-relaxed">{sel.cause}</p>
          </DetailSection>
          <DetailSection title="Impact">
            <p className="text-[13px] leading-relaxed">{sel.impact}</p>
          </DetailSection>
          <DetailSection title="Remédiation suggérée">
            <p className="text-xs leading-relaxed text-muted-foreground">{REMEDIATION[sel.kind]}</p>
          </DetailSection>
          {sel.status !== "resolved" && (
            <DetailSection title="Actions">
              <div className="grid grid-cols-2 gap-2">
                {sel.status === "open" && (
                  <Button size="sm" variant="outline" onClick={() => { void setStatus(sel, "investigating"); setSel(null); }}>Prendre en charge</Button>
                )}
                <Button size="sm" onClick={() => { void setStatus(sel, "resolved"); setSel(null); }}>Marquer résolu</Button>
              </div>
            </DetailSection>
          )}
        </DetailSheet>
      )}
    </div>
  );
}
