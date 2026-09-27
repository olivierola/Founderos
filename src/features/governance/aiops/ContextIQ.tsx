import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FunnelIcon as Funnel,
  CircleNotchIcon as Loader2,
  CheckIcon as Check,
  ArrowClockwiseIcon as Refresh,
  CaretDownIcon as CaretDown,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { StatTile, compact } from "./StatTile";

// ContextIQ — ce que la recherche documentaire a donné aux agents, et ce qui
// manquait.
//
// Le runtime (_shared/contextiq.ts) juge chaque contexte récupéré : notes des
// passages, couverture de la question, contradiction. Cet écran en tire trois
// choses, dans l'ordre de leur utilité :
//   1. les TROUS — les questions que la base ne couvre pas (à documenter)
//   2. les CONTRADICTIONS — des documents qui disent deux choses différentes
//   3. l'efficacité du filtre — combien de passages écartés, combien d'élargissements
//
// Le réglage lui-même vit dans « Jugement rapide » (usage rag_rerank) : un seul
// interrupteur, pas deux écrans qui se contredisent.

interface Row {
  id: number;
  surface: "public_agent" | "internal_agent";
  agent_id: string | null;
  question: string;
  mode: "shadow" | "on";
  applied: boolean;
  retrieved: number;
  kept: number;
  coverage: number | null;
  contradiction: number | null;
  widened: boolean;
  passages: Array<{ id: string; note: number | null; similarity: number; excerpt: string }>;
  latency_ms: number | null;
  resolved_at: string | null;
  created_at: string;
}

const COVERAGE = [
  { label: "aucune", tone: "bg-red-500/10 text-red-700 dark:text-red-300" },
  { label: "partielle", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  { label: "suffisante", tone: "bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  { label: "complète", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
];

const CONTRADICTION_THRESHOLD = 0.7;

type Surface = "all" | "public_agent" | "internal_agent";

/** Regroupe les reformulations triviales d'une même question. Volontairement
 *  simple : casse, ponctuation, espaces. Un regroupement « par le sens »
 *  demanderait un appel de plus pour un écran de lecture. */
const normalize = (q: string) =>
  q.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

const when = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function GovContextIQPage() {
  const { workspaceId } = useCurrentContext();
  const qc = useQueryClient();
  const [surface, setSurface] = useState<Surface>("all");
  const [resolving, setResolving] = useState<string | null>(null);

  const { data: rows, isLoading } = useQuery({
    queryKey: ["contextiq", workspaceId],
    enabled: !!workspaceId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      const { data } = await supabase.from("contextiq_assessments")
        .select("id, surface, agent_id, question, mode, applied, retrieved, kept, coverage, contradiction, widened, passages, latency_ms, resolved_at, created_at")
        .eq("workspace_id", workspaceId!)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(2000);
      return (data ?? []) as Row[];
    },
  });

  const { data: agentNames } = useQuery({
    queryKey: ["contextiq_agents", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const [pub, int] = await Promise.all([
        supabase.from("rag_agents").select("id, name").eq("workspace_id", workspaceId!),
        supabase.from("internal_agents").select("id, name").eq("workspace_id", workspaceId!),
      ]);
      const out = new Map<string, string>();
      for (const a of [...(pub.data ?? []), ...(int.data ?? [])] as Array<{ id: string; name: string }>) out.set(a.id, a.name);
      return out;
    },
  });

  const filtered = useMemo(
    () => (rows ?? []).filter((r) => surface === "all" || r.surface === surface),
    [rows, surface],
  );

  const kpis = useMemo(() => {
    const judged = filtered.filter((r) => r.coverage != null);
    const answerable = judged.filter((r) => (r.coverage ?? 0) >= 2).length;
    const dropped = filtered.reduce((n, r) => n + Math.max(0, r.retrieved - r.kept), 0);
    return {
      total: filtered.length,
      answerableRate: judged.length ? answerable / judged.length : null,
      gaps: filtered.filter((r) => r.coverage != null && r.coverage <= 1 && !r.resolved_at).length,
      contradictions: filtered.filter((r) => (r.contradiction ?? 0) >= CONTRADICTION_THRESHOLD).length,
      droppedAvg: filtered.length ? dropped / filtered.length : null,
      widened: filtered.filter((r) => r.widened).length,
    };
  }, [filtered]);

  // Les trous, regroupés par question : la même question posée douze fois est
  // UN document manquant, pas douze.
  const gaps = useMemo(() => {
    const groups = new Map<string, { question: string; ids: number[]; worst: number; last: string; agents: Set<string> }>();
    for (const r of filtered) {
      if (r.coverage == null || r.coverage > 1 || r.resolved_at) continue;
      const key = normalize(r.question);
      const g = groups.get(key) ?? { question: r.question, ids: [], worst: 3, last: r.created_at, agents: new Set<string>() };
      g.ids.push(r.id);
      g.worst = Math.min(g.worst, r.coverage);
      if (r.created_at > g.last) g.last = r.created_at;
      if (r.agent_id) g.agents.add(r.agent_id);
      groups.set(key, g);
    }
    return [...groups.entries()]
      .map(([key, g]) => ({ key, ...g }))
      .sort((a, b) => b.ids.length - a.ids.length || a.worst - b.worst);
  }, [filtered]);

  const contradictions = useMemo(
    () => filtered.filter((r) => (r.contradiction ?? 0) >= CONTRADICTION_THRESHOLD).slice(0, 15),
    [filtered],
  );

  async function resolve(key: string, ids: number[]) {
    setResolving(key);
    try {
      const { data: auth } = await supabase.auth.getUser();
      await supabase.from("contextiq_assessments")
        .update({ resolved_at: new Date().toISOString(), resolved_by: auth.user?.id ?? null })
        .in("id", ids);
      qc.invalidateQueries({ queryKey: ["contextiq", workspaceId] });
    } finally {
      setResolving(null);
    }
  }

  const agentName = (id: string | null) => (id && agentNames?.get(id)) || "agent";

  return (
    <div className="space-y-6">
      <PageHeader
        title="ContextIQ"
        description="Ce que la recherche documentaire a réellement donné à vos agents : les questions que votre base ne couvre pas, les documents qui se contredisent, et les passages écartés avant d'atteindre le modèle."
        actions={
          <Button variant="outline" size="sm" className="gap-1.5"
            onClick={() => qc.invalidateQueries({ queryKey: ["contextiq", workspaceId] })}>
            <Refresh className="h-3.5 w-3.5" /> Rafraîchir
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
          {([["all", "Tous les agents"], ["public_agent", "Agents publics"], ["internal_agent", "Agents internes"]] as Array<[Surface, string]>).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setSurface(k)}
              className={cn("rounded-md px-2.5 py-1.5 text-[11.5px] transition-colors",
                surface === k ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {label}
            </button>
          ))}
        </div>
        <span className="text-[11.5px] text-muted-foreground">30 derniers jours</span>
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (rows ?? []).length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex items-start gap-3 p-5 text-[12.5px] leading-relaxed text-muted-foreground">
            <Funnel className="mt-0.5 h-4 w-4 shrink-0 text-purple-500" />
            <span>
              Aucune évaluation pour l'instant. ContextIQ se règle dans <strong className="text-foreground">Gouvernance IA → Jugement rapide</strong>,
              usage « ContextIQ — filtre de contexte RAG ». En <strong className="text-foreground">Observation</strong>, chaque recherche est
              évaluée et journalisée ici sans rien changer aux réponses : c'est suffisant pour voir apparaître les trous de votre base.
            </span>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatTile label="Recherches évaluées" value={compact(kpis.total)} hint="30 derniers jours" />
            <StatTile label="Questions couvertes" value={kpis.answerableRate == null ? "—" : `${Math.round(kpis.answerableRate * 100)} %`}
              hint="couverture suffisante ou complète" />
            <StatTile label="Trous à traiter" value={compact(kpis.gaps)} alert={kpis.gaps > 0 ? "à documenter" : null} hint="aucun en attente" />
            <StatTile label="Contradictions" value={compact(kpis.contradictions)} alert={kpis.contradictions > 0 ? "documents à réconcilier" : null} hint="aucune détectée" />
            <StatTile label="Passages écartés" value={kpis.droppedAvg == null ? "—" : kpis.droppedAvg.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} hint="en moyenne par recherche" />
            <StatTile label="Recherches élargies" value={compact(kpis.widened)} hint="couverture faible au 1er passage" />
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="border-b border-border/60 px-4 py-2.5">
                <div className="text-[13px] font-medium">Trous documentaires</div>
                <div className="text-[11.5px] text-muted-foreground">
                  Les questions pour lesquelles vos documents ne donnaient pas (ou pas assez) la réponse. Ajoutez le document manquant, puis marquez la question traitée.
                </div>
              </div>
              {gaps.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">Aucun trou sur la période.</div>
              ) : (
                <div className="divide-y divide-border/40">
                  {gaps.slice(0, 30).map((g) => (
                    <div key={g.key} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-[12px]">
                      <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", COVERAGE[g.worst].tone)}>
                        {COVERAGE[g.worst].label}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium" title={g.question}>{g.question}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {g.ids.length}× · {[...g.agents].slice(0, 2).map(agentName).join(", ") || "—"} · {when(g.last)}
                      </span>
                      <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11.5px]"
                        disabled={resolving === g.key} onClick={() => resolve(g.key, g.ids)}>
                        {resolving === g.key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Traité
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="border-b border-border/60 px-4 py-2.5">
                <div className="text-[13px] font-medium">Contradictions détectées</div>
                <div className="text-[11.5px] text-muted-foreground">
                  Des passages récupérés ensemble qui donnent des informations incompatibles (prix, délai, procédure). Un seul des deux documents est à jour.
                </div>
              </div>
              {contradictions.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">Aucune contradiction sur la période.</div>
              ) : (
                <div className="divide-y divide-border/40">
                  {contradictions.map((r) => <AssessmentRow key={r.id} row={r} agent={agentName(r.agent_id)} />)}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              <div className="border-b border-border/60 px-4 py-2.5 text-[13px] font-medium">Dernières recherches</div>
              <div className="divide-y divide-border/40">
                {filtered.slice(0, 25).map((r) => <AssessmentRow key={r.id} row={r} agent={agentName(r.agent_id)} />)}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/** Une évaluation, dépliable sur les passages gardés et leur note. */
function AssessmentRow({ row, agent }: { row: Row; agent: string }) {
  const [open, setOpen] = useState(false);
  const cov = row.coverage != null ? COVERAGE[row.coverage] : null;
  return (
    <div className="px-4 py-2 text-[11.5px]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left">
        <CaretDown className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        {cov
          ? <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", cov.tone)}>{cov.label}</span>
          : <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">non jugée</span>}
        <span className="min-w-0 flex-1 truncate font-medium">{row.question}</span>
        <span className="shrink-0 text-muted-foreground">
          {agent} · {row.kept}/{row.retrieved} passages
          {row.widened && " · élargie"}
          {(row.contradiction ?? 0) >= CONTRADICTION_THRESHOLD && " · contradiction"}
          {row.mode === "shadow" && " · observation"}
        </span>
        <span className="shrink-0 text-muted-foreground/70">{when(row.created_at)}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 pl-6">
          {row.passages.length === 0 && <div className="text-muted-foreground">Aucun passage gardé.</div>}
          {row.passages.map((p, i) => (
            <div key={p.id ?? i} className="rounded-md bg-muted/40 px-2.5 py-1.5">
              <div className="mb-0.5 flex gap-3 text-[10.5px] text-muted-foreground">
                <span>[{i + 1}]</span>
                {p.note != null && <span>note {p.note}/3</span>}
                <span>similarité {Number(p.similarity).toFixed(2)}</span>
              </div>
              <div className="line-clamp-3 text-[11.5px] leading-relaxed">{p.excerpt}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
