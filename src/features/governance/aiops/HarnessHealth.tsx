import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowsClockwiseIcon as Retry,
  DatabaseIcon as Cache,
  CheckCircleIcon as Success,
  StackIcon as Ticks,
  CircleNotchIcon as Loader2,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

// La fiabilité du harnais des agents, mesurée : chaque tick écrit dans
// llm_usage.metadata ce qu'il a dû rattraper (relances, délais, sorties
// coupées, outils abandonnés, arguments refusés…) et ce que le cache a servi.
// Cette page en fait la somme, à côté de ce que les runs sont devenus — pour
// voir un fournisseur qui flanche avant qu'il ne fasse échouer des missions.

interface TickRow {
  created_at: string;
  model: string | null;
  prompt_tokens: number | null;
  metadata: {
    run_id?: string; tick?: number; cached_tokens?: number; stopped_for_time?: boolean; billed_usd?: number;
    harness?: Partial<Record<HarnessKey | "tools_changed" | "tool_calls" | "tool_errors" | "jev_tools", number | boolean>> & { tool_desc?: "compact" | "full" };
  } | null;
}
interface RunRow { id: string; status: string; error_message: string | null }

type HarnessKey =
  | "retries" | "request_timeouts" | "output_escalations" | "output_fits"
  | "tool_timeouts" | "invalid_args" | "persisted_outputs" | "toolset_resets" | "guardrail_denials"
  | "args_repaired" | "tools_aliased" | "streamed_rounds" | "early_tools" | "stream_interruptions" | "tool_stops"
  | "errors_diagnosed" | "auto_recovered";

const COUNTERS: Array<{ key: HarnessKey; label: string; hint: string; bad?: boolean }> = [
  { key: "retries", label: "Relances d'appel", hint: "Panne passagère, rafale (429), coupure réseau — rattrapées sans que le run ne le voie.", bad: true },
  { key: "request_timeouts", label: "Requêtes sans réponse", hint: "Coupées à l'échéance puis relancées au lieu de laisser mourir le tick.", bad: true },
  { key: "output_escalations", label: "Sorties relancées", hint: "Un appel d'outil coupé par la limite de sortie, refait avec plus de place." },
  { key: "output_fits", label: "Sorties ajustées", hint: "max_tokens réduit pour tenir dans la fenêtre plutôt que compacter." },
  { key: "tool_timeouts", label: "Outils abandonnés", hint: "Un outil encore en cours à la fin du tick : erreur lisible, tick sauvé.", bad: true },
  { key: "invalid_args", label: "Arguments refusés", hint: "Paramètre obligatoire absent ou valeur hors liste : refusé avant exécution." },
  { key: "persisted_outputs", label: "Sorties conservées", hint: "Résultats trop longs gardés en entier, relisibles avec read_tool_output." },
  { key: "toolset_resets", label: "Outils renouvelés", hint: "La liste d'outils a dû repartir de zéro (elle avait trop grossi) : un défaut de cache." },
  { key: "guardrail_denials", label: "Refus de garde-fous", hint: "Actions bloquées par les règles de l'espace (au plus haut par run).", bad: true },
  { key: "args_repaired", label: "Arguments réparés", hint: "Un nombre écrit en texte, un objet sérialisé, une casse d'enum : corrigé d'après le schéma au lieu de refuser l'appel." },
  { key: "tools_aliased", label: "Noms d'outil corrigés", hint: "Un nom venu d'ailleurs (bash, functions.x) redirigé vers l'outil de la boîte." },
  { key: "streamed_rounds", label: "Tours en flux", hint: "Réponses reçues token par token, affichées pendant qu'elles s'écrivent." },
  { key: "early_tools", label: "Outils lancés en avance", hint: "Partis pendant que le modèle écrivait encore la suite de sa réponse." },
  { key: "stream_interruptions", label: "Flux coupés", hint: "Réponse interrompue en cours : les appels complets ont été gardés, le reste rejoué.", bad: true },
  { key: "tool_stops", label: "Outils arrêtés", hint: "Signal d'arrêt envoyé (échéance, annulation), puis abandon après 5 s." },
  { key: "errors_diagnosed", label: "Erreurs diagnostiquées", hint: "Échecs d'outil dont la cause et l'ajustement ont été donnés à l'agent." },
  { key: "auto_recovered", label: "Lectures rattrapées", hint: "Une lecture en panne passagère, rejouée automatiquement avec succès." },
];

/** La mesure A/B des descriptions d'outils (AGENT_TOOL_DESC_MODE=ab) : par variante. */
interface DescVariant { ticks: number; runs: Set<string>; calls: number; errors: number; invalid: number; repaired: number; prompt: number }

const PERIODS = [{ days: 1, label: "24 h" }, { days: 7, label: "7 j" }, { days: 30, label: "30 j" }];

export function HarnessHealthPage() {
  const { workspaceId } = useCurrentContext();
  const [days, setDays] = useState(7);
  const since = useMemo(() => new Date(Date.now() - days * 86_400_000).toISOString(), [days]);

  const { data: ticks, isLoading } = useQuery({
    queryKey: ["harness_ticks", workspaceId, days],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase.from("llm_usage")
        .select("created_at, model, prompt_tokens, metadata")
        .eq("workspace_id", workspaceId!)
        .in("feature", ["internal-agent-chat", "internal-agent-mission"])
        .gte("created_at", since)
        .not("metadata->tick", "is", null)
        .order("created_at", { ascending: false })
        .limit(5000);
      return (data ?? []) as TickRow[];
    },
  });
  const { data: runs } = useQuery({
    queryKey: ["harness_runs", workspaceId, days],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_runs")
        .select("id, status, error_message")
        .eq("workspace_id", workspaceId!)
        .gte("started_at", since)
        .limit(5000);
      return (data ?? []) as RunRow[];
    },
  });

  const stats = useMemo(() => {
    const rows = ticks ?? [];
    let prompt = 0, cached = 0, billed = 0, stopped = 0, toolsChanged = 0;
    const totals = Object.fromEntries(COUNTERS.map((c) => [c.key, 0])) as Record<HarnessKey, number>;
    const denialsByRun = new Map<string, number>();
    const models = new Map<string, number>();
    const variants: Record<"compact" | "full", DescVariant> = {
      compact: { ticks: 0, runs: new Set(), calls: 0, errors: 0, invalid: 0, repaired: 0, prompt: 0 },
      full: { ticks: 0, runs: new Set(), calls: 0, errors: 0, invalid: 0, repaired: 0, prompt: 0 },
    };
    for (const r of rows) {
      const m = r.metadata ?? {};
      prompt += Number(r.prompt_tokens) || 0;
      cached += Number(m.cached_tokens) || 0;
      billed += Number(m.billed_usd) || 0;
      if (m.stopped_for_time) stopped++;
      const h = m.harness ?? {};
      if (h.tools_changed) toolsChanged++;
      for (const c of COUNTERS) {
        if (c.key === "guardrail_denials") continue;
        totals[c.key] += Number(h[c.key]) || 0;
      }
      if (m.run_id) denialsByRun.set(m.run_id, Math.max(denialsByRun.get(m.run_id) ?? 0, Number(h.guardrail_denials) || 0));
      const model = r.model || "?";
      models.set(model, (models.get(model) ?? 0) + 1);
      const v = h.tool_desc ? variants[h.tool_desc] : null;
      if (v) {
        v.ticks++;
        if (m.run_id) v.runs.add(m.run_id);
        v.calls += Number(h.tool_calls) || 0;
        v.errors += Number(h.tool_errors) || 0;
        v.invalid += Number(h.invalid_args) || 0;
        v.repaired += Number(h.args_repaired) || 0;
        v.prompt += Number(r.prompt_tokens) || 0;
      }
    }
    totals.guardrail_denials = [...denialsByRun.values()].reduce((s, n) => s + n, 0);
    const runRows = runs ?? [];
    const done = runRows.filter((r) => r.status === "succeeded").length;
    const failed = runRows.filter((r) => r.status === "failed");
    const finished = runRows.filter((r) => ["succeeded", "failed", "cancelled", "awaiting_input"].includes(r.status)).length;
    const statusById = new Map(runRows.map((r) => [r.id, r.status]));
    const ab = (["compact", "full"] as const).map((k) => {
      const v = variants[k];
      const ended = [...v.runs].filter((id) => ["succeeded", "failed", "cancelled", "awaiting_input"].includes(statusById.get(id) ?? ""));
      const ok = ended.filter((id) => statusById.get(id) === "succeeded").length;
      return {
        key: k, ticks: v.ticks, runs: v.runs.size, calls: v.calls,
        errorRate: v.calls ? v.errors / v.calls : null,
        invalidRate: v.calls ? v.invalid / v.calls : null,
        repairRate: v.calls ? v.repaired / v.calls : null,
        promptPerTick: v.ticks ? v.prompt / v.ticks : null,
        successRate: ended.length ? ok / ended.length : null,
      };
    });
    const reasons = new Map<string, number>();
    for (const r of failed) {
      const key = (r.error_message ?? "sans message").replace(/\s+/g, " ").replace(/\{.*$/, "").slice(0, 90).trim();
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    return {
      ticks: rows.length, runsWithTicks: denialsByRun.size,
      cacheRatio: prompt ? cached / prompt : null, billed, stopped, toolsChanged,
      totals,
      models: [...models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
      successRate: finished ? done / finished : null, finished, failed: failed.length,
      reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
      ab,
    };
  }, [ticks, runs]);

  const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)} %`);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fiabilité du harnais"
        description="Ce que la boucle des agents a rattrapé (relances, délais, sorties coupées, outils abandonnés), ce que le cache a servi, et ce que les runs sont devenus."
      />

      <div className="flex gap-1">
        {PERIODS.map((p) => (
          <button
            key={p.days}
            onClick={() => setDays(p.days)}
            className={cn(
              "h-8 rounded-lg px-2.5 text-[13px] transition-colors",
              days === p.days ? "bg-muted/80 font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard label="Ticks" value={String(stats.ticks)} icon={Ticks} hint={`${stats.runsWithTicks} runs · ${stats.stopped} arrêtés à l'échéance`} />
            <MetricCard label="Entrée servie par le cache" value={pct(stats.cacheRatio)} icon={Cache} hint={`${stats.toolsChanged} ticks avec une liste d'outils changée`} />
            <MetricCard label="Runs réussis" value={pct(stats.successRate)} icon={Success} hint={`${stats.finished} terminés · ${stats.failed} en échec`} />
            <MetricCard label="Relances" value={String(stats.totals.retries)} icon={Retry} hint={stats.billed > 0 ? `${stats.billed.toFixed(2)} $ facturés (coût réel)` : "appels de modèle repris"} />
          </div>

          <Card className="p-5">
            <div className="mb-3 text-sm font-semibold">Rattrapages</div>
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
              {COUNTERS.map((c) => {
                const n = stats.totals[c.key];
                return (
                  <div key={c.key} className="flex items-start gap-3">
                    <span className={cn(
                      "min-w-[44px] rounded-lg px-2 py-1 text-center text-sm font-semibold tabular-nums",
                      n === 0 ? "bg-muted text-muted-foreground" : c.bad ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-primary/15 text-primary",
                    )}>{n}</span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{c.label}</div>
                      <div className="text-[11.5px] leading-snug text-muted-foreground">{c.hint}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="p-5">
            <div className="mb-1 text-sm font-semibold">Descriptions d'outils : compactes ou complètes</div>
            <p className="mb-3 text-[11.5px] text-muted-foreground">
              La moitié des runs reçoit des descriptions coupées à 140 caractères, l'autre moitié les descriptions entières. Les erreurs sont rapportées aux appels d'outil.
            </p>
            {stats.ab.every((v) => v.ticks === 0) ? (
              <p className="text-xs text-muted-foreground">Pas encore de ticks mesurés sur la période.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px] tabular-nums">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="py-1.5 pr-4 font-medium">Variante</th>
                      <th className="py-1.5 pr-4 font-medium">Runs</th>
                      <th className="py-1.5 pr-4 font-medium">Appels</th>
                      <th className="py-1.5 pr-4 font-medium">Erreurs d'outil</th>
                      <th className="py-1.5 pr-4 font-medium">Arguments refusés</th>
                      <th className="py-1.5 pr-4 font-medium">Arguments réparés</th>
                      <th className="py-1.5 pr-4 font-medium">Tokens par tick</th>
                      <th className="py-1.5 font-medium">Runs réussis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.ab.map((v) => (
                      <tr key={v.key} className="border-t border-border/60">
                        <td className="py-1.5 pr-4 font-medium">{v.key === "compact" ? "Compactes" : "Complètes"}</td>
                        <td className="py-1.5 pr-4">{v.runs}</td>
                        <td className="py-1.5 pr-4">{v.calls}</td>
                        <td className="py-1.5 pr-4">{pct(v.errorRate)}</td>
                        <td className="py-1.5 pr-4">{pct(v.invalidRate)}</td>
                        <td className="py-1.5 pr-4">{pct(v.repairRate)}</td>
                        <td className="py-1.5 pr-4">{v.promptPerTick == null ? "—" : Math.round(v.promptPerTick).toLocaleString("fr-FR")}</td>
                        <td className="py-1.5">{pct(v.successRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <div className="mb-1 text-sm font-semibold">Modèles choisis</div>
              <p className="mb-3 text-[11.5px] text-muted-foreground">Le modèle qui a réellement répondu, par tick — le routage par palier et par critère en action.</p>
              {stats.models.length === 0 ? (
                <p className="text-xs text-muted-foreground">Aucun tick sur la période.</p>
              ) : (
                <div className="space-y-1.5">
                  {stats.models.map(([model, n]) => (
                    <div key={model} className="flex items-center gap-2 text-[12.5px]">
                      <span className="min-w-0 flex-1 truncate font-mono">{model}</span>
                      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((n / stats.ticks) * 100)}%` }} />
                      </div>
                      <span className="w-10 text-right tabular-nums text-muted-foreground">{n}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card className="p-5">
              <div className="mb-1 text-sm font-semibold">Causes d'échec</div>
              <p className="mb-3 text-[11.5px] text-muted-foreground">Les messages d'erreur des runs échoués, regroupés.</p>
              {stats.reasons.length === 0 ? (
                <p className="text-xs text-muted-foreground">Aucun échec sur la période.</p>
              ) : (
                <div className="space-y-2">
                  {stats.reasons.map(([why, n]) => (
                    <div key={why} className="flex items-start gap-2 text-[12.5px]">
                      <span className="min-w-[28px] rounded-md bg-destructive/10 px-1.5 text-center font-semibold tabular-nums text-destructive">{n}</span>
                      <span className="min-w-0 flex-1 text-muted-foreground">{why}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
