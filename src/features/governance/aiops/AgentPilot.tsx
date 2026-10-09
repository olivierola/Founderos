import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SteeringWheelIcon as Wheel,
  CircleNotchIcon as Loader2,
  ArrowClockwiseIcon as Refresh,
  CheckIcon as Check,
  EyeIcon as Eye,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { StatTile, compact } from "./StatTile";

// AgentPilot — comment les runs d'agents sont pilotés, ce qu'ils coûtent, et
// où ils échouent.
//
// Trois sources, toutes déjà écrites par le runtime :
//   internal_agent_runs    — statut, coût, erreur de chaque run
//   agentpilot_decisions   — les décisions de pilotage (modèle, boucles,
//                            escalade humaine, et chaque décision non triviale
//                            du contrôleur de boucle)
//   typesafe_judgements    — les jugements Jev des usages de pilotage
//                            (routage, outils, skills, recherche, fin de run)
//
// Les réglages ne vivent PAS ici : un seul endroit pour allumer/éteindre un
// usage (Gouvernance IA → Jugement rapide), sinon deux écrans finissent par se
// contredire.

const SINCE_DAYS = 30;

/** Les usages Jev qui pilotent un run, avec ce qu'ils décident. */
const PILOT_FEATURES: Array<{ feature: string; label: string; decides: string }> = [
  { feature: "agent_choice", label: "Routage entre agents", decides: "quel agent prend le message d'une room" },
  { feature: "model_choice", label: "Choix du modèle", decides: "rapide ou raisonnement, selon la tâche" },
  { feature: "tool_ranking", label: "Choix des outils", decides: "quelle famille d'outils passe devant" },
  { feature: "skill_ranking", label: "Choix des skills", decides: "quelles skills entrent dans le prompt" },
  { feature: "search_decision", label: "Décision de recherche", decides: "chercher ou produire" },
  { feature: "loop_watch", label: "Boucles déguisées", decides: "la même tentative reformulée" },
  { feature: "human_escalation", label: "Escalade vers l'humain", decides: "poser la question plutôt que replanifier" },
  { feature: "run_end", label: "Fin de run", decides: "le contrat de réussite est-il rempli" },
];

const KIND_LABEL: Record<string, string> = {
  model_choice: "Modèle",
  loop_watch: "Boucle",
  human_escalation: "Escalade",
  controller: "Contrôleur",
};

const CONTROLLER_LABEL: Record<string, string> = {
  replan: "replanification",
  finalize: "finalisation forcée",
  abort: "arrêt",
};

interface RunRow {
  id: string; agent_id: string | null; status: string | null;
  cost_usd: number | string | null; error_message: string | null; created_at: string;
}
interface DecisionRow {
  id: number; agent_id: string | null; run_id: string | null; kind: string; decision: string;
  applied: boolean; probability: number | null; detail: Record<string, unknown>; created_at: string;
}
interface JudgementRow {
  feature: string; applied: boolean; confidence: number | null; cost_cents: number | null; error: string | null;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const usd = (n: number) => `${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 3 : 2 })} $`;
const pct = (n: number) => `${Math.round(n * 100)} %`;

export function GovAgentPilotPage() {
  const { workspaceId } = useCurrentContext();
  const qc = useQueryClient();
  const since = useMemo(() => new Date(Date.now() - SINCE_DAYS * 24 * 3600_000).toISOString(), []);

  const { data, isLoading } = useQuery({
    queryKey: ["agentpilot", workspaceId],
    enabled: !!workspaceId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const [runs, decisions, judgements, agents] = await Promise.all([
        supabase.from("internal_agent_runs")
          .select("id, agent_id, status, cost_usd, error_message, created_at")
          .eq("workspace_id", workspaceId!).gte("created_at", since)
          .order("created_at", { ascending: false }).limit(3000),
        supabase.from("agentpilot_decisions")
          .select("id, agent_id, run_id, kind, decision, applied, probability, detail, created_at")
          .eq("workspace_id", workspaceId!).gte("created_at", since)
          .order("created_at", { ascending: false }).limit(2000),
        supabase.from("typesafe_judgements")
          .select("feature, applied, confidence, cost_cents, error")
          .eq("workspace_id", workspaceId!).gte("created_at", since)
          .in("feature", PILOT_FEATURES.map((f) => f.feature))
          .limit(5000),
        supabase.from("internal_agents").select("id, name").eq("workspace_id", workspaceId!),
      ]);
      return {
        runs: (runs.data ?? []) as RunRow[],
        decisions: (decisions.data ?? []) as DecisionRow[],
        judgements: (judgements.data ?? []) as JudgementRow[],
        names: new Map(((agents.data ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name])),
      };
    },
  });

  const runs = data?.runs ?? [];
  const decisions = data?.decisions ?? [];
  const agentName = (id: string | null) => (id && data?.names.get(id)) || "agent supprimé";

  const kpis = useMemo(() => {
    const done = runs.filter((r) => r.status === "succeeded" || r.status === "failed");
    const failed = runs.filter((r) => r.status === "failed").length;
    const cost = runs.reduce((n, r) => n + (Number(r.cost_usd) || 0), 0);
    const models = decisions.filter((d) => d.kind === "model_choice");
    return {
      runs: runs.length,
      failRate: done.length ? failed / done.length : null,
      avgCost: runs.length ? cost / runs.length : null,
      replans: decisions.filter((d) => d.kind === "controller" && d.decision === "replan").length,
      escalations: decisions.filter((d) => d.kind === "human_escalation" && d.applied).length,
      heavyShare: models.length ? models.filter((d) => d.decision === "heavy").length / models.length : null,
    };
  }, [runs, decisions]);

  const perAgent = useMemo(() => {
    const out = new Map<string, { runs: number; failed: number; done: number; cost: number; replans: number; escalations: number; aborts: number }>();
    const row = (id: string) => out.get(id) ?? { runs: 0, failed: 0, done: 0, cost: 0, replans: 0, escalations: 0, aborts: 0 };
    for (const r of runs) {
      if (!r.agent_id) continue;
      const a = row(r.agent_id);
      a.runs++;
      if (r.status === "failed") a.failed++;
      if (r.status === "failed" || r.status === "succeeded") a.done++;
      a.cost += Number(r.cost_usd) || 0;
      out.set(r.agent_id, a);
    }
    for (const d of decisions) {
      if (!d.agent_id) continue;
      const a = row(d.agent_id);
      if (d.kind === "controller" && d.decision === "replan") a.replans++;
      if (d.kind === "controller" && d.decision === "abort") a.aborts++;
      if (d.kind === "human_escalation" && d.applied) a.escalations++;
      out.set(d.agent_id, a);
    }
    return [...out.entries()].map(([id, a]) => ({ id, ...a })).sort((x, y) => y.cost - x.cost);
  }, [runs, decisions]);

  const perFeature = useMemo(() => {
    const out = new Map<string, { calls: number; applied: number; conf: number[]; cost: number; errors: number }>();
    for (const j of data?.judgements ?? []) {
      const a = out.get(j.feature) ?? { calls: 0, applied: 0, conf: [], cost: 0, errors: 0 };
      a.calls++;
      if (j.applied) a.applied++;
      if (j.error) a.errors++;
      if (j.confidence != null) a.conf.push(Number(j.confidence));
      a.cost += Number(j.cost_cents) || 0;
      out.set(j.feature, a);
    }
    return out;
  }, [data?.judgements]);

  // Échecs regroupés par cause : la première ligne du message d'erreur. Douze
  // runs tombés sur le même 401 sont UN problème de connecteur.
  const failures = useMemo(() => {
    const groups = new Map<string, { cause: string; count: number; last: string; agents: Set<string> }>();
    for (const r of runs) {
      if (r.status !== "failed") continue;
      const cause = (r.error_message ?? "Sans message d'erreur").split("\n")[0].slice(0, 160);
      const g = groups.get(cause) ?? { cause, count: 0, last: r.created_at, agents: new Set<string>() };
      g.count++;
      if (r.created_at > g.last) g.last = r.created_at;
      if (r.agent_id) g.agents.add(r.agent_id);
      groups.set(cause, g);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  }, [runs]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="AgentPilot"
        description="Comment vos agents sont pilotés pendant un run : quel modèle ils prennent, quand ils tournent en rond, quand ils vous posent la question plutôt que d'insister, et ce que ça coûte."
        actions={
          <Button variant="outline" size="sm" className="gap-1.5"
            onClick={() => qc.invalidateQueries({ queryKey: ["agentpilot", workspaceId] })}>
            <Refresh className="h-3.5 w-3.5" /> Rafraîchir
          </Button>
        }
      />

      {isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile label="Runs" value={compact(kpis.runs)} hint={`${SINCE_DAYS} derniers jours`} />
            <StatTile label="Taux d'échec" value={kpis.failRate == null ? "—" : pct(kpis.failRate)}
              alert={kpis.failRate != null && kpis.failRate >= 0.1 ? "au-dessus de 10 %" : null} hint="runs terminés" />
            <StatTile label="Coût moyen d'un run" value={kpis.avgCost == null ? "—" : usd(kpis.avgCost)} hint="estimé, tous modèles" />
            <StatTile label="Boucles cassées" value={compact(kpis.replans)} hint="replanifications du contrôleur" />
            <StatTile label="Questions posées" value={compact(kpis.escalations)} hint="escalades vers l'humain" />
            <StatTile label="Part du raisonneur" value={kpis.heavyShare == null ? "—" : pct(kpis.heavyShare)} hint="parmi les choix de modèle jugés" />
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="border-b border-border/60 px-4 py-2.5">
                <div className="text-[13px] font-medium">Par agent</div>
                <div className="text-[11.5px] text-muted-foreground">Classés par coût. Un agent qui replanifie souvent a une consigne ou un outil à revoir.</div>
              </div>
              {perAgent.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">Aucun run sur la période.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-border/40 text-left text-[11px] text-muted-foreground">
                        <th className="px-4 py-2 font-normal">Collaborateur</th>
                        <th className="px-3 py-2 text-right font-normal">Runs</th>
                        <th className="px-3 py-2 text-right font-normal">Échecs</th>
                        <th className="px-3 py-2 text-right font-normal">Coût total</th>
                        <th className="px-3 py-2 text-right font-normal">Coût moyen</th>
                        <th className="px-3 py-2 text-right font-normal">Replanifications</th>
                        <th className="px-3 py-2 text-right font-normal">Questions</th>
                        <th className="px-4 py-2 text-right font-normal">Arrêts</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/30 tabular-nums">
                      {perAgent.slice(0, 25).map((a) => (
                        <tr key={a.id}>
                          <td className="max-w-[220px] truncate px-4 py-2 font-medium">{agentName(a.id)}</td>
                          <td className="px-3 py-2 text-right">{a.runs}</td>
                          <td className="px-3 py-2 text-right">{a.done ? pct(a.failed / a.done) : "—"}</td>
                          <td className="px-3 py-2 text-right">{usd(a.cost)}</td>
                          <td className="px-3 py-2 text-right">{a.runs ? usd(a.cost / a.runs) : "—"}</td>
                          <td className="px-3 py-2 text-right">{a.replans}</td>
                          <td className="px-3 py-2 text-right">{a.escalations}</td>
                          <td className="px-4 py-2 text-right">{a.aborts}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="border-b border-border/60 px-4 py-2.5">
                <div className="text-[13px] font-medium">Décisions du pilote</div>
                <div className="text-[11.5px] text-muted-foreground">
                  Chaque usage se règle dans Gouvernance IA → Jugement rapide. « Appliquées » : la décision a changé le run ; le reste est de l'observation.
                </div>
              </div>
              <div className="divide-y divide-border/40">
                {PILOT_FEATURES.map((f) => {
                  const s = perFeature.get(f.feature);
                  const conf = s?.conf.length ? s.conf.reduce((a, b) => a + b, 0) / s.conf.length : null;
                  return (
                    <div key={f.feature} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[12px]">
                      <div className="min-w-0 flex-1">
                        <span className="font-medium">{f.label}</span>
                        <span className="ml-2 text-[11.5px] text-muted-foreground">{f.decides}</span>
                      </div>
                      {s ? (
                        <span className="flex flex-wrap items-center gap-x-4 text-[11.5px] text-muted-foreground tabular-nums">
                          <span>{compact(s.calls)} jugement{s.calls > 1 ? "s" : ""}</span>
                          <span>{compact(s.applied)} appliqué{s.applied > 1 ? "s" : ""}</span>
                          {conf != null && <span>confiance {conf.toFixed(2)}</span>}
                          <span>{(s.cost / 100).toFixed(4)} €</span>
                          {s.errors > 0 && <span>{s.errors} en erreur</span>}
                        </span>
                      ) : (
                        <span className="text-[11.5px] text-muted-foreground/70">aucun jugement</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardContent className="p-0">
                <div className="border-b border-border/60 px-4 py-2.5 text-[13px] font-medium">Journal du pilote</div>
                {decisions.length === 0 ? (
                  <div className="flex items-start gap-2 px-4 py-6 text-[12px] text-muted-foreground">
                    <Wheel className="mt-0.5 h-4 w-4 shrink-0" />
                    Aucune décision sur la période. Les décisions du contrôleur de boucle apparaissent dès qu'un run replanifie ; les jugements Jev,
                    dès qu'un usage AgentPilot passe en Observation ou en Actif.
                  </div>
                ) : (
                  <div className="divide-y divide-border/40">
                    {decisions.slice(0, 30).map((d) => <DecisionLine key={d.id} d={d} agent={agentName(d.agent_id)} />)}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-0">
                <div className="border-b border-border/60 px-4 py-2.5 text-[13px] font-medium">Causes d'échec</div>
                {failures.length === 0 ? (
                  <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">Aucun run en échec sur la période.</div>
                ) : (
                  <div className="divide-y divide-border/40">
                    {failures.map((g) => (
                      <div key={g.cause} className="px-4 py-2.5 text-[12px]">
                        <div className="flex items-baseline gap-3">
                          <span className="shrink-0 font-semibold">{g.count}×</span>
                          <span className="min-w-0 flex-1 break-words">{g.cause}</span>
                        </div>
                        <div className="mt-0.5 pl-8 text-[11px] text-muted-foreground">
                          {[...g.agents].slice(0, 3).map(agentName).join(", ")} · dernier le {when(g.last)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function DecisionLine({ d, agent }: { d: DecisionRow; agent: string }) {
  const reason = typeof d.detail?.reason === "string" ? d.detail.reason : null;
  const label = d.kind === "controller"
    ? CONTROLLER_LABEL[d.decision] ?? d.decision
    : d.kind === "model_choice"
    ? (d.decision === "heavy" ? "modèle de raisonnement" : "modèle rapide")
    : d.decision;
  return (
    <div className="px-4 py-2 text-[11.5px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-20 shrink-0 text-muted-foreground">{KIND_LABEL[d.kind] ?? d.kind}</span>
        <span className="font-medium">{label}</span>
        {d.probability != null && <span className="text-muted-foreground">p = {Number(d.probability).toFixed(2)}</span>}
        {d.applied
          ? <span className="flex items-center gap-1 text-muted-foreground"><Check className="h-3 w-3" /> appliquée</span>
          : <span className="flex items-center gap-1 text-muted-foreground"><Eye className="h-3 w-3" /> observation</span>}
        <span className="ml-auto shrink-0 text-muted-foreground/70">{when(d.created_at)}</span>
      </div>
      <div className={cn("mt-0.5 truncate pl-[5.75rem] text-muted-foreground")} title={reason ?? undefined}>
        {agent}{reason ? `, ${reason}` : ""}
      </div>
    </div>
  );
}
