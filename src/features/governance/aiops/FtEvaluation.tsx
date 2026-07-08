import { useMemo, useState } from "react";
import { ClipboardCheck, TrendingUp, Loader2, ArrowDown } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Pill } from "../ui";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import { timeAgo, modelById, type EvalRun, type EvalCriterion } from "./data";
import { useServersDb, useFtEvalsDb } from "./db";

/** Paired horizontal bars: base (muted) vs affiné (teal). Handles unit, custom
 *  scale, and lower-is-better metrics (loss, hallucinations, latence, coût). */
function CriterionBars({ c }: { c: EvalCriterion }) {
  const scale = c.scale ?? 100;
  const delta = Math.round((c.tuned - c.base) * 100) / 100;
  const improved = c.lowerIsBetter ? delta < 0 : delta > 0;
  const fmt = (v: number) => `${v}${c.unit === "$" ? " $" : c.unit ?? ""}`;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span>{c.label}{c.lowerIsBetter && <span className="ml-1 text-[10px] text-muted-foreground">(↓ mieux)</span>}</span>
        <span className={cn("tabular-nums font-medium", improved ? "text-emerald-500" : "text-red-500")}>
          {delta > 0 ? "+" : ""}{delta}{c.unit === "$" ? " $" : c.unit ?? ""}
        </span>
      </div>
      <div className="space-y-1">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-muted-foreground/40" style={{ width: `${Math.min(100, (c.base / scale) * 100)}%` }} />
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-[hsl(var(--accent-teal))]" style={{ width: `${Math.min(100, (c.tuned / scale) * 100)}%` }} />
        </div>
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>base {fmt(c.base)}</span><span>affiné {fmt(c.tuned)}</span>
      </div>
    </div>
  );
}

export function GovFtEvaluationPage() {
  const { servers } = useServersDb();
  const { evals } = useFtEvalsDb(servers);
  const [sel, setSel] = useState<EvalRun | null>(null);

  const done = evals.filter((e) => e.status === "done");
  const avgWin = done.length ? Math.round(done.reduce((s, e) => s + e.winRate, 0) / done.length) : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Évaluation"
        description="Performance avant / après fine-tuning : Accuracy, Loss, F1, BLEU, ROUGE, hallucinations, latence et coût par token."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Évaluations" value={String(evals.length)} icon={ClipboardCheck} />
        <MetricCard label="Win-rate moyen" value={`${avgWin}%`} icon={TrendingUp} trend={avgWin >= 60 ? "up" : "flat"} hint="modèle affiné préféré au modèle de base" />
        <MetricCard label="En cours" value={String(evals.length - done.length)} />
      </div>

      {evals.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="Aucune évaluation" description="Terminez un job d'entraînement pour lancer une évaluation avant/après." />
      ) : (
        <div className="mb-1 flex items-center gap-4 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-5 rounded-full bg-muted-foreground/40" /> modèle de base</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-5 rounded-full bg-[hsl(var(--accent-teal))]" /> modèle affiné</span>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {evals.map((e) => (
          <Card key={e.id} className="cursor-pointer p-4 transition-colors hover:bg-muted/30" onClick={() => setSel(e)}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 truncate font-mono text-sm font-medium">
                  <span className="truncate text-muted-foreground">{modelById(e.baseModel)?.label ?? e.baseModel}</span>
                  <ArrowDown className="h-3 w-3 shrink-0 -rotate-90 text-muted-foreground" />
                  <span className="truncate">{e.tunedModel}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{e.samples} échantillons · {timeAgo(e.ts)}</div>
              </div>
              {e.status === "running"
                ? <span className="inline-flex items-center gap-1 text-xs text-blue-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />en cours</span>
                : <Pill meta={{ label: `${e.winRate}% win`, tone: e.winRate >= 60 ? "emerald" : "amber" }} />}
            </div>
            <div className="mt-3 space-y-3">
              {e.criteria.slice(0, 3).map((c) => <CriterionBars key={c.label} c={c} />)}
            </div>
            <div className="mt-2 text-[11px] text-muted-foreground">{e.criteria.length - 3} autres métriques — cliquer pour le détail</div>
          </Card>
        ))}
      </div>

      {sel && (
        <DetailSheet
          onClose={() => setSel(null)}
          title={sel.name}
          subtitle={`${sel.samples} échantillons · ${timeAgo(sel.ts)}`}
          icon={<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground"><ClipboardCheck className="h-[18px] w-[18px]" /></div>}
        >
          <DetailSection title="Comparaison">
            <DetailRow label="Modèle de base">{modelById(sel.baseModel)?.label ?? sel.baseModel}</DetailRow>
            <DetailRow label="Modèle affiné"><span className="font-mono text-xs">{sel.tunedModel}</span></DetailRow>
            <DetailRow label="Win-rate">
              <span className={cn("font-semibold", sel.winRate >= 60 ? "text-emerald-500" : "text-amber-500")}>{sel.winRate}%</span>
            </DetailRow>
            <DetailRow label="Échantillons">{sel.samples}</DetailRow>
          </DetailSection>
          <DetailSection title={`Métriques (${sel.criteria.length})`}>
            <div className="space-y-4">
              {sel.criteria.map((c) => <CriterionBars key={c.label} c={c} />)}
            </div>
          </DetailSection>
          <DetailSection title={`Benchmark automatique — ${sel.benchmark.questions} questions`}>
            <div className="overflow-hidden rounded-md border border-border/60">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/30 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Mesure</th>
                    <th className="px-3 py-2 text-right font-medium">Base</th>
                    <th className="px-3 py-2 text-right font-medium">Affiné</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  <tr>
                    <td className="px-3 py-2">Réponses correctes</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{sel.benchmark.baseCorrect}/{sel.benchmark.questions}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-emerald-500">{sel.benchmark.tunedCorrect}/{sel.benchmark.questions}</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2">Temps moyen</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{sel.benchmark.baseAvgMs} ms</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{sel.benchmark.tunedAvgMs} ms</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2">Hallucinations</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{sel.benchmark.baseHalluc}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{sel.benchmark.tunedHalluc}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Winner : <span className="font-medium text-foreground">{sel.benchmark.tunedCorrect >= sel.benchmark.baseCorrect ? "modèle affiné" : "modèle de base"}</span> — même jeu de questions envoyé aux deux modèles, réponses jugées automatiquement.
            </p>
          </DetailSection>
          <DetailSection title="Lecture">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Accuracy/F1 mesurent la justesse ; BLEU/ROUGE la proximité aux références ; les hallucinations sont vérifiées par un juge LLM avec accès aux sources.
              La latence et le coût/token chutent car le modèle affiné (petit, auto-hébergé) remplace un grand modèle généraliste.
            </p>
          </DetailSection>
        </DetailSheet>
      )}
    </div>
  );
}
