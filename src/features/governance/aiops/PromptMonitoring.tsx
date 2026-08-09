import { useMemo, useState } from "react";
import { Eye, User, Wrench, DatabaseZap, ChevronRight, Copy, Check } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { Pill, Select } from "../ui";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import {
  useProjectAgents, timeAgo, usd, modelById,
  PROMPT_CATEGORY_META, OUTCOME_META, HOSTING_META, type PromptRecord,
} from "./data";
import { useRealPrompts, useRunTools, useRunPrompt, type RunPromptDetail } from "./db";

export function GovPromptMonitoringPage() {
  const { data: agents } = useProjectAgents();
  const roster = agents ?? [];
  const { prompts } = useRealPrompts(agents ?? []);

  const [agentFilter, setAgentFilter] = useState("all");
  const [catFilter, setCatFilter] = useState("all");
  const [outcomeFilter, setOutcomeFilter] = useState("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<PromptRecord | null>(null);
  // Real drill-down: which tools this specific run actually invoked, and the
  // exact request it was given.
  const toolsQ = useRunTools(sel ? sel.id : null);
  const promptQ = useRunPrompt(sel ? sel.id : null);
  const selTools = sel ? toolsQ.data?.tools ?? [] : [];
  const selData = sel ? toolsQ.data?.data ?? [] : [];

  const filtered = prompts.filter((p) =>
    (agentFilter === "all" || p.agentId === agentFilter) &&
    (catFilter === "all" || p.category === catFilter) &&
    (outcomeFilter === "all" || p.outcome === outcomeFilter) &&
    (q === "" || `${p.prompt} ${p.requester} ${p.agentName} ${p.labels.join(" ")}`.toLowerCase().includes(q.toLowerCase())),
  );

  const stats = useMemo(() => ({
    total: prompts.length,
    success: prompts.length ? Math.round((prompts.filter((p) => p.outcome === "success").length / prompts.length) * 100) : 0,
    humans: new Set(prompts.filter((p) => p.requester.includes("@")).map((p) => p.requester)).size,
  }), [prompts]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Surveillance des prompts"
        description="Chaque demande faite à un agent : qui l'a émise, sa catégorie, son résultat et les accès mobilisés — lue depuis vos runs réels."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Prompts (30 j)" value={String(stats.total)} icon={Eye} />
        <MetricCard label="Taux de succès" value={`${stats.success}%`} trend={stats.success >= 70 ? "up" : "down"} delta={stats.success >= 70 ? "sain" : "à surveiller"} />
        <MetricCard label="Demandeurs humains" value={String(stats.humans)} icon={User} hint="+ déclencheurs automatiques (cron, webhooks)" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un prompt, un demandeur, un label…" className="h-9 w-72" />
        <Select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className="h-9 w-40">
          <option value="all">Tous les agents</option>
          {roster.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} className="h-9 w-40">
          <option value="all">Toutes catégories</option>
          {Object.entries(PROMPT_CATEGORY_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </Select>
        <Select value={outcomeFilter} onChange={(e) => setOutcomeFilter(e.target.value)} className="h-9 w-36">
          <option value="all">Tous résultats</option>
          {Object.entries(OUTCOME_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
        </Select>
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />Live
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Eye} title="Aucun prompt" description="Aucune demande ne correspond aux filtres sélectionnés." />
      ) : (
        <Card className="divide-y divide-border/60 overflow-hidden">
          {filtered.map((p) => (
            <button
              key={p.id}
              onClick={() => setSel(p)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-muted/30"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.prompt}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Pill meta={PROMPT_CATEGORY_META[p.category]} />
                  <Pill meta={OUTCOME_META[p.outcome]} />
                  {p.labels.map((l) => (
                    <span key={l} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{l}</span>
                  ))}
                </div>
              </div>
              <div className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
                <span className="text-xs">{p.agentName}</span>
                <span className="text-[11px] text-muted-foreground">{p.requester}</span>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(p.ts)}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50" />
            </button>
          ))}
        </Card>
      )}

      {sel && (
        <DetailSheet
          onClose={() => setSel(null)}
          title={sel.prompt}
          subtitle={`${sel.agentName} · ${timeAgo(sel.ts)}`}
          icon={<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground"><Eye className="h-[18px] w-[18px]" /></div>}
        >
          <PromptText detail={promptQ.data} loading={promptQ.isLoading} />

          <DetailSection title="Demande">
            <DetailRow label="Catégorie"><Pill meta={PROMPT_CATEGORY_META[sel.category]} /></DetailRow>
            <DetailRow label="Résultat"><Pill meta={OUTCOME_META[sel.outcome]} /></DetailRow>
            <DetailRow label="Labels">
              <span className="flex flex-wrap justify-end gap-1">
                {sel.labels.map((l) => <span key={l} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{l}</span>)}
              </span>
            </DetailRow>
            <DetailRow label="Horodatage">{new Date(sel.ts).toLocaleString("fr-FR")}</DetailRow>
          </DetailSection>

          <DetailSection title="Qui → Quoi">
            <DetailRow label="Demandeur"><span className="inline-flex items-center gap-1.5"><User className="h-3.5 w-3.5 text-muted-foreground" />{sel.requester}</span></DetailRow>
            <DetailRow label="Agent">{sel.agentName}</DetailRow>
            <DetailRow label="Run"><span className="font-mono text-xs">{sel.runId}</span></DetailRow>
          </DetailSection>

          <DetailSection title="Modèle">
            {(() => { const m = modelById(sel.model); return m ? (
              <>
                <DetailRow label="Modèle">{m.label}</DetailRow>
                <DetailRow label="Hébergement"><Pill meta={HOSTING_META[m.hosting]} /></DetailRow>
                <DetailRow label="Fournisseur">{m.vendor} · {m.family}</DetailRow>
              </>
            ) : (
              <>
                <DetailRow label="Modèle"><code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{sel.model}</code></DetailRow>
                {sel.custom && <DetailRow label="Hébergement"><Pill meta={HOSTING_META.self_hosted} /></DetailRow>}
              </>
            ); })()}
          </DetailSection>

          <DetailSection title="Accès mobilisés">
            <div className="mb-2 flex flex-wrap gap-1">
              {selTools.length === 0 ? <span className="text-xs text-muted-foreground">{toolsQ.isLoading ? "Chargement des outils…" : "Aucun outil appelé"}</span> :
                selTools.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-[11px] text-blue-600 dark:text-blue-400">
                    <Wrench className="h-3 w-3" />{t}
                  </span>
                ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {selData.length === 0 ? <span className="text-xs text-muted-foreground">Aucune donnée accédée</span> :
                selData.map((d) => (
                  <span key={d} className="inline-flex items-center gap-1 rounded bg-cyan-500/10 px-1.5 py-0.5 text-[11px] text-cyan-600 dark:text-cyan-400">
                    <DatabaseZap className="h-3 w-3" />{d}
                  </span>
                ))}
            </div>
          </DetailSection>

          <DetailSection title="Tokens & coût">
            <DetailRow label="Tokens entrée">{sel.tokensIn.toLocaleString()}</DetailRow>
            <DetailRow label="Tokens sortie">{sel.tokensOut.toLocaleString()}</DetailRow>
            <DetailRow label="Coût"><span className="font-medium">{usd(sel.costUsd)}</span></DetailRow>
          </DetailSection>
        </DetailSheet>
      )}
    </div>
  );
}

/** The verbatim request the agent received, read back from its origin (mission
 *  brief, chat/room message, sub-agent subtask), plus the system-level
 *  instructions prepended to it. */
function PromptText({ detail, loading }: { detail?: RunPromptDetail; loading: boolean }) {
  const [copied, setCopied] = useState(false);
  const system = [detail?.persona, detail?.instructions].filter(Boolean).join("\n\n");

  const copy = async () => {
    if (!detail?.text) return;
    try {
      await navigator.clipboard.writeText(detail.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — the text stays selectable */ }
  };

  return (
    <DetailSection title="Prompt exact envoyé">
      {loading ? (
        <p className="text-xs text-muted-foreground">Chargement du prompt…</p>
      ) : (
        <>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">{detail?.sourceLabel}</span>
            {detail?.text && (
              <Button size="sm" variant="ghost" className="h-6 shrink-0 gap-1 px-2 text-[11px]" onClick={copy}>
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copié" : "Copier"}
              </Button>
            )}
          </div>
          {detail?.text ? (
            <pre className="scrollbar-slim max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/40 p-3 text-[12px] leading-relaxed">
              {detail.text}
            </pre>
          ) : (
            <p className="rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
              Aucun texte de demande n'a été conservé pour ce run (déclenchement automatique, ou conversation/mission supprimée depuis).
            </p>
          )}
          {detail?.missionTitle && <DetailRow label="Mission">{detail.missionTitle}</DetailRow>}
          {detail?.acceptance && <DetailRow label="Critères d'acceptation"><span className="whitespace-pre-wrap">{detail.acceptance}</span></DetailRow>}
          {detail?.deliverables?.length ? (
            <DetailRow label="Livrables attendus">
              <span className="flex flex-wrap justify-end gap-1">
                {detail.deliverables.map((d) => (
                  <span key={d} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{d}</span>
                ))}
              </span>
            </DetailRow>
          ) : null}
          {system && (
            <details className="mt-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
              <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                Instructions système de l'agent (préfixées à chaque demande)
              </summary>
              <pre className="scrollbar-slim mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted-foreground">
                {system}
              </pre>
            </details>
          )}
        </>
      )}
    </DetailSection>
  );
}
