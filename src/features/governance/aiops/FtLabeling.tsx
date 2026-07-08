import { useMemo, useState } from "react";
import { Tags, Check, X, Bot, UserCheck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Pill } from "../ui";
import { LABEL_SETS, LABEL_QUEUE, timeAgo } from "./data";
import { useLabelTasksDb } from "./db";

const SET_TONE: Record<string, "blue" | "violet" | "amber" | "cyan"> = {
  Intent: "blue", Sentiment: "violet", "Priorité": "amber", "Département": "cyan",
};

export function GovFtLabelingPage() {
  const { tasks, validateOne } = useLabelTasksDb();

  // Validation queue — each decision persists into the first labeling task.
  const [queueIdx, setQueueIdx] = useState(0);
  const [validated, setValidated] = useState(0);
  const item = LABEL_QUEUE[queueIdx % LABEL_QUEUE.length];

  const totals = useMemo(() => ({
    docs: tasks.reduce((s, t) => s + t.total, 0),
    ai: tasks.reduce((s, t) => s + t.aiSuggested, 0),
    human: tasks.reduce((s, t) => s + t.humanValidated, 0),
  }), [tasks]);

  const next = () => { setQueueIdx((i) => i + 1); };
  const approve = () => { setValidated((v) => v + 1); validateOne(true); next(); };
  const correct = () => { validateOne(false); next(); };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Labeling"
        description="Enrichissez vos datasets supervisés : l'IA propose un label, un humain valide — intents, sentiment, priorité, département…"
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Documents" value={totals.docs.toLocaleString("fr-FR")} icon={Tags} />
        <MetricCard label="Labels proposés (IA)" value={totals.ai.toLocaleString("fr-FR")} icon={Bot} />
        <MetricCard label="Validés (humain)" value={(totals.human + validated).toLocaleString("fr-FR")} icon={UserCheck} />
      </div>

      {/* Jeux de labels disponibles */}
      <Card className="p-4">
        <div className="mb-3 text-sm font-medium">Jeux de labels</div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {LABEL_SETS.map((s) => (
            <div key={s.name} className="flex items-center gap-1.5">
              <span className="text-xs font-medium">{s.name} :</span>
              {s.values.map((v) => (
                <Pill key={v} meta={{ label: v, tone: SET_TONE[s.name] ?? "slate" }} className="px-1.5 py-0 text-[10px]" />
              ))}
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* File de validation — Document → IA propose → Humain valide */}
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between text-sm font-medium">
            <span>File de validation</span>
            <span className="text-[11px] font-normal text-muted-foreground">{validated} validé{validated > 1 ? "s" : ""} cette session</span>
          </div>
          <div className="rounded-md border border-border bg-muted/20 p-3 text-[13px] leading-relaxed">
            “{item.text}”
          </div>
          <div className="mt-3 space-y-2">
            {item.suggested.map((s) => (
              <div key={s.set} className="flex items-center gap-2 text-sm">
                <span className="w-24 shrink-0 text-xs text-muted-foreground">{s.set}</span>
                <Pill meta={{ label: s.value, tone: SET_TONE[s.set] ?? "slate" }} />
                <span className={cn("ml-auto text-[11px] tabular-nums", s.confidence >= 90 ? "text-emerald-500" : s.confidence >= 75 ? "text-amber-500" : "text-red-500")}>
                  {s.confidence}% confiance
                </span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex gap-2">
            <Button size="sm" className="flex-1" onClick={approve}><Check className="mr-1.5 h-3.5 w-3.5" />Valider les labels</Button>
            <Button size="sm" variant="outline" className="flex-1" onClick={correct}><X className="mr-1.5 h-3.5 w-3.5" />Corriger / passer</Button>
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Chaque validation enrichit le dataset — assez de labels validés et vous pouvez entraîner un classificateur automatique de tickets.
          </p>
        </Card>

        {/* Tâches de labeling par dataset */}
        <Card className="overflow-hidden">
          <div className="border-b border-border/60 px-5 py-3.5 text-sm font-medium">Datasets en cours de labeling</div>
          <div className="divide-y divide-border/60">
            {tasks.map((t) => {
              const pct = Math.round((t.humanValidated / t.total) * 100);
              return (
                <div key={t.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-medium">{t.dataset}</span>
                    {t.labelSets.map((ls) => <Pill key={ls} meta={{ label: ls, tone: SET_TONE[ls] ?? "slate" }} className="px-1.5 py-0 text-[10px]" />)}
                    <span className="ml-auto text-[11px] text-muted-foreground">{timeAgo(t.startedAt)}</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-[hsl(var(--accent-teal))]" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
                    <span>{t.humanValidated.toLocaleString("fr-FR")} / {t.total.toLocaleString("fr-FR")} validés ({pct}%)</span>
                    <span>accord IA↔humain : {t.agreementPct}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}
