import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  CpuIcon as Cpu,
  ShieldWarningIcon as ShieldAlert,
  GitPullRequestIcon as GitPullRequestArrow,
  SirenIcon as Siren,
  ShieldCheckIcon as ShieldCheck,
  ClipboardTextIcon as ClipboardCheck,
  ArrowRightIcon as ArrowRight,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card } from "@/components/ui/card";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import {
  useEnsureSystemsSynced, useAiSystems, useRisks, useApprovals, useIncidents,
  useControls, useDataAssets, useAuditEvents,
  RISK_TIER_META, riskScore, type RiskTier, type AiSystem,
} from "./shared";
import { Pill } from "./ui";

const TIER_ORDER: RiskTier[] = ["unacceptable", "high", "limited", "minimal"];
const TIER_BAR: Record<RiskTier, string> = {
  unacceptable: "bg-red-500", high: "bg-orange-500", limited: "bg-amber-500", minimal: "bg-emerald-500",
};

export function GovernanceDashboard() {
  useEnsureSystemsSynced();
  const { workspace, project } = useCurrentContext();
  const base = workspace && project ? `/app/${workspace.slug}/${project.slug}/governance` : "";

  const { data: systems } = useAiSystems();
  const { data: risks } = useRisks();
  const { data: approvals } = useApprovals();
  const { data: incidents } = useIncidents();
  const { data: controls } = useControls();
  const { data: dataAssets } = useDataAssets();
  const { data: events } = useAuditEvents();

  const s = systems ?? [];
  const openRisks = (risks ?? []).filter((r) => r.status === "open" || r.status === "mitigating");
  const pendingApprovals = (approvals ?? []).filter((a) => a.status === "pending");
  const openIncidents = (incidents ?? []).filter((i) => i.status === "open" || i.status === "investigating");

  const coverage = useMemo(() => {
    const applicable = (controls ?? []).filter((c) => c.status !== "not_applicable");
    const done = applicable.filter((c) => c.status === "implemented").length;
    return applicable.length ? Math.round((done / applicable.length) * 100) : 0;
  }, [controls]);

  const tierCounts = useMemo(() => {
    const counts: Record<RiskTier, number> = { unacceptable: 0, high: 0, limited: 0, minimal: 0 };
    for (const sys of s) counts[sys.risk_tier]++;
    return counts;
  }, [s]);

  const attention = useMemo(() => {
    const out: { label: string; tone: "red" | "orange"; to: string }[] = [];
    const highUnapproved = s.filter((x): x is AiSystem =>
      (x.risk_tier === "high" || x.risk_tier === "unacceptable") && x.status !== "approved" && x.status !== "retired");
    if (highUnapproved.length) out.push({ label: `${highUnapproved.length} système(s) à risque élevé non approuvé(s)`, tone: "red", to: `${base}/registry` });
    const critRisks = (risks ?? []).filter((r) => (r.status === "open" || r.status === "mitigating") && riskScore(r.likelihood, r.impact) >= 15);
    if (critRisks.length) out.push({ label: `${critRisks.length} risque(s) critique(s) ouvert(s)`, tone: "red", to: `${base}/risks` });
    const critIncidents = (incidents ?? []).filter((i) => i.severity === "critical" && i.status !== "closed" && i.status !== "resolved");
    if (critIncidents.length) out.push({ label: `${critIncidents.length} incident(s) critique(s) actif(s)`, tone: "red", to: `${base}/incidents` });
    if (pendingApprovals.length) out.push({ label: `${pendingApprovals.length} validation(s) en attente`, tone: "orange", to: `${base}/approvals` });
    const piiNoBasis = (dataAssets ?? []).filter((a) => a.contains_pii && !a.lawful_basis);
    if (piiNoBasis.length) out.push({ label: `${piiNoBasis.length} actif(s) PII sans base légale`, tone: "orange", to: `${base}/data-assets` });
    return out;
  }, [s, risks, incidents, pendingApprovals, dataAssets, base]);

  const highRisk = s.filter((x) => x.risk_tier === "high" || x.risk_tier === "unacceptable").length;

  return (
    <div className="space-y-6">
      <PageHeader title="Gouvernance IA & données"
        description="Posture de gouvernance : garder l'IA utile, contrôlable et digne de confiance à l'échelle de l'entreprise." />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Systèmes IA" value={String(s.length)} icon={Cpu} />
        <MetricCard label="Risque élevé" value={String(highRisk)} icon={ShieldAlert} />
        <MetricCard label="Risques ouverts" value={String(openRisks.length)} icon={ShieldAlert} />
        <MetricCard label="À valider" value={String(pendingApprovals.length)} icon={GitPullRequestArrow} />
        <MetricCard label="Incidents ouverts" value={String(openIncidents.length)} icon={Siren} />
        <MetricCard label="Couverture contrôles" value={`${coverage}%`} icon={ClipboardCheck} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Risk-tier distribution */}
        <Card className="p-5 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Répartition par niveau de risque</h3>
            <Link to={`${base}/registry`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              Registre <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {s.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun système enregistré pour l'instant.</p>
          ) : (
            <div className="space-y-3">
              <div className="flex h-2.5 overflow-hidden rounded-full bg-secondary">
                {TIER_ORDER.map((t) => tierCounts[t] > 0 && (
                  <div key={t} className={TIER_BAR[t]} style={{ width: `${(tierCounts[t] / s.length) * 100}%` }} />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {TIER_ORDER.map((t) => (
                  <div key={t} className="flex items-center gap-1.5 text-xs">
                    <span className={`h-2.5 w-2.5 rounded-full ${TIER_BAR[t]}`} />
                    <span className="text-muted-foreground">{RISK_TIER_META[t].label}</span>
                    <span className="font-medium">{tierCounts[t]}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* Needs attention */}
        <Card className="p-5">
          <h3 className="mb-4 text-sm font-semibold">Points d'attention</h3>
          {attention.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="h-4 w-4" /> Rien à signaler
            </div>
          ) : (
            <ul className="space-y-2">
              {attention.map((a, i) => (
                <li key={i}>
                  <Link to={a.to} className="flex items-center justify-between gap-2 rounded-md border p-2.5 text-xs hover:bg-secondary/50">
                    <span className="flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 rounded-full ${a.tone === "red" ? "bg-red-500" : "bg-orange-500"}`} />
                      {a.label}
                    </span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Recent activity */}
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Activité récente</h3>
          <Link to={`${base}/audit`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            Journal complet <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
        {(events ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune activité de gouvernance enregistrée.</p>
        ) : (
          <ul className="space-y-2">
            {(events ?? []).slice(0, 6).map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">
                  <span className="font-medium">{e.actor_name ?? "Système"}</span>{" "}
                  <span className="text-muted-foreground">· {e.action}</span>{" "}
                  {e.entity_label && <span className="font-medium">{e.entity_label}</span>}
                </span>
                <time className="shrink-0 text-muted-foreground">{new Date(e.created_at).toLocaleDateString("fr-FR")}</time>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {highRisk > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border p-4 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Systèmes à risque élevé :</span>
          {s.filter((x) => x.risk_tier === "high" || x.risk_tier === "unacceptable").slice(0, 8).map((x) => (
            <span key={x.id} className="inline-flex items-center gap-1.5">
              <Pill meta={RISK_TIER_META[x.risk_tier]} /> {x.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
