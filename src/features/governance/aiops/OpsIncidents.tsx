import { useMemo, useState } from "react";
import { Siren, Clock, CircleX } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Card } from "@/components/ui/card";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { Pill, Select } from "../ui";
import { SEVERITY_META } from "../shared";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import {
  useProjectAgents, timeAgo, fmtDuration,
  INCIDENT_KIND_META, OPS_STATUS_META, type OpsIncident, type IncidentKind,
} from "./data";
import { useRealRunIncidents } from "./db";

// Suggested next step per incident kind — shown in the detail sheet.
const REMEDIATION: Record<IncidentKind, string> = {
  run_failure: "Relancer le run avec les mêmes entrées ; si l'échec persiste, inspecter l'étape fautive dans la timeline du run et corriger l'outil ou l'instruction concernée.",
  timeout: "Réduire la longueur de la chaîne d'outils, augmenter le budget temps du run, ou découper la mission en sous-tâches.",
  tool_error: "Vérifier le quota et l'état du fournisseur d'API ; ajouter un fallback ou un retry exponentiel sur cet outil.",
  guardrail_block: "Comportement attendu — vérifier dans Guardrails si la règle est correctement calibrée, ou accorder l'accès si légitime.",
  rate_limit: "Espacer les requêtes concurrentes, activer la mise en file, ou répartir la charge sur un second modèle.",
  hallucination: "Renforcer l'ancrage (RAG/outils), abaisser la température, ou exiger des citations de sources dans l'instruction.",
};

export function GovOpsIncidentsPage() {
  const { data: agents } = useProjectAgents();
  const { incidents } = useRealRunIncidents(agents ?? []);

  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sel, setSel] = useState<OpsIncident | null>(null);

  const filtered = incidents.filter((i) =>
    (kindFilter === "all" || i.kind === kindFilter) &&
    (statusFilter === "all" || i.status === statusFilter),
  );

  const stats = useMemo(() => ({
    open: incidents.filter((i) => i.status !== "resolved").length,
    failures: incidents.filter((i) => i.kind === "run_failure" || i.kind === "timeout").length,
    critical: incidents.filter((i) => i.severity === "critical" || i.severity === "high").length,
  }), [incidents]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Incidents & runs échoués"
        description="Surveillance des échecs d'exécution : runs échoués, timeouts, erreurs d'outils, blocages guardrail — depuis vos runs réels."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Incidents ouverts" value={String(stats.open)} icon={Siren} />
        <MetricCard label="Runs échoués / timeouts" value={String(stats.failures)} icon={CircleX} />
        <MetricCard label="Sévérité haute+" value={String(stats.critical)} hint="incidents high ou critical (30 j)" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className="h-9 w-44">
          <option value="all">Tous les types</option>
          {Object.entries(INCIDENT_KIND_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </Select>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-9 w-40">
          <option value="all">Tous statuts</option>
          {Object.entries(OPS_STATUS_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">{filtered.length} incident{filtered.length > 1 ? "s" : ""}</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Siren} title="Aucun incident" description="Rien à signaler sur la période — vos agents tournent proprement." />
      ) : (
        <div className="space-y-2">
          {filtered.map((i) => (
            <Card key={i.id} className="cursor-pointer p-4 transition-colors hover:bg-muted/30" onClick={() => setSel(i)}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{i.title}</span>
                    <Pill meta={INCIDENT_KIND_META[i.kind]} />
                    <Pill meta={SEVERITY_META[i.severity]} />
                    <Pill meta={OPS_STATUS_META[i.status]} />
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground/80">Cause :</span> {i.cause}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                    <span>{i.agentName}</span>
                    <span className="font-mono">{i.runId}</span>
                    <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{fmtDuration(i.durationMs)}</span>
                    <span>{timeAgo(i.ts)}</span>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {sel && (
        <DetailSheet
          onClose={() => setSel(null)}
          title={sel.title}
          subtitle={`${INCIDENT_KIND_META[sel.kind].label} · ${timeAgo(sel.ts)}`}
        >
          <DetailSection title="Incident">
            <DetailRow label="Type"><Pill meta={INCIDENT_KIND_META[sel.kind]} /></DetailRow>
            <DetailRow label="Sévérité"><Pill meta={SEVERITY_META[sel.severity]} /></DetailRow>
            <DetailRow label="Statut"><Pill meta={OPS_STATUS_META[sel.status]} /></DetailRow>
            <DetailRow label="Horodatage">{new Date(sel.ts).toLocaleString("fr-FR")}</DetailRow>
            <DetailRow label="Durée du run">{fmtDuration(sel.durationMs)}</DetailRow>
          </DetailSection>
          <DetailSection title="Contexte">
            <DetailRow label="Agent">{sel.agentName}</DetailRow>
            <DetailRow label="Run"><span className="font-mono text-xs">{sel.runId}</span></DetailRow>
          </DetailSection>
          <DetailSection title="Cause">
            <p className="text-[13px] leading-relaxed">{sel.cause}</p>
          </DetailSection>
          <DetailSection title="Remédiation suggérée">
            <p className="text-xs leading-relaxed text-muted-foreground">{REMEDIATION[sel.kind]}</p>
          </DetailSection>
        </DetailSheet>
      )}
    </div>
  );
}
