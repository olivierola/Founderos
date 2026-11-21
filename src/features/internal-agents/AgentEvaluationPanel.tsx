import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CircleNotchIcon as Loader2,
  CheckCircleIcon as Check,
  XCircleIcon as XCircle,
  ThumbsUpIcon as ThumbsUp,
  ThumbsDownIcon as ThumbsDown,
  GraduationCapIcon as GraduationCap,
  ArrowRightIcon as ArrowRight,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

/**
 * L'évaluation d'un collaborateur, à côté de sa conversation : est-ce qu'il
 * fait bien son travail ? Rien n'est déclaré à la main, tout se LIT dans ce
 * qu'il a déjà produit :
 *
 *   · ses runs — aboutis, en échec, durée, coût ;
 *   · les retours humains — 👍 / 👎 posés sur ses messages en room ;
 *   · les reprises — les remarques que l'auto-apprentissage (0288) a lues
 *     comme des corrections. Une reprise est un défaut constaté par un humain :
 *     c'est le signal le plus honnête qu'on ait, plus que le statut d'un run,
 *     qui « réussit » aussi quand le résultat est faux.
 *
 * Le score combine les trois sur la période. Il sert à comparer l'agent à
 * lui-même d'une période sur l'autre, pas à le classer contre un autre.
 */

type Period = 7 | 30 | 90;

interface Run { id: string; status: string; cost_usd: number | null; started_at: string | null; finished_at: string | null; created_at: string; error_message: string | null }
interface Learning { id: string; status: string; target_file: string; lesson: string; feedback: string; created_at: string }

const POSITIVE = ["👍", "❤️", "🎉", "🔥", "✅", "👏", "😍"];
const NEGATIVE = ["👎", "😕", "😞", "❌", "🤔", "😡"];

export function AgentEvaluationPanel({ agentId, onOpenLearnings }: {
  agentId: string;
  /** Mène au journal d'apprentissage (Fichiers → Apprentissage). */
  onOpenLearnings?: () => void;
}) {
  const [period, setPeriod] = useState<Period>(30);
  const since = useMemo(() => new Date(Date.now() - period * 86400_000).toISOString(), [period]);
  const prevSince = useMemo(() => new Date(Date.now() - 2 * period * 86400_000).toISOString(), [period]);

  const { data, isLoading } = useQuery({
    queryKey: ["agent_evaluation", agentId, period],
    queryFn: async () => {
      const [runsRes, learnRes, msgsRes] = await Promise.all([
        supabase.from("internal_agent_runs")
          .select("id, status, cost_usd, started_at, finished_at, created_at, error_message")
          .eq("agent_id", agentId).gte("created_at", prevSince).order("created_at", { ascending: false }).limit(1000),
        supabase.from("internal_agent_learnings")
          .select("id, status, target_file, lesson, feedback, created_at")
          .eq("agent_id", agentId).gte("created_at", prevSince).order("created_at", { ascending: false }).limit(500),
        supabase.from("service_room_messages")
          .select("id, created_at").eq("agent_id", agentId).eq("author_kind", "agent")
          .gte("created_at", since).limit(1000),
      ]);
      const msgIds = ((msgsRes.data ?? []) as Array<{ id: string }>).map((m) => m.id);
      let reactions: Array<{ emoji: string }> = [];
      // Par paquets : une liste d'ids trop longue dépasse la taille d'URL.
      for (let i = 0; i < msgIds.length; i += 150) {
        const { data: r } = await supabase.from("service_room_message_reactions")
          .select("emoji").in("message_id", msgIds.slice(i, i + 150));
        reactions = reactions.concat((r ?? []) as Array<{ emoji: string }>);
      }
      return {
        runs: (runsRes.data ?? []) as Run[],
        // La table n'existe qu'après 0288 : sans elle, aucune reprise.
        learnings: (learnRes.error ? [] : learnRes.data ?? []) as Learning[],
        reactions,
      };
    },
  });

  const m = useMemo(() => {
    if (!data) return null;
    const cur = (iso: string) => iso >= since;
    const runs = data.runs.filter((r) => cur(r.created_at));
    const prevRuns = data.runs.filter((r) => !cur(r.created_at));
    const learnings = data.learnings.filter((l) => cur(l.created_at) && l.status !== "skipped");
    const prevLearnings = data.learnings.filter((l) => !cur(l.created_at) && l.status !== "skipped");

    const rate = (rs: Run[]) => {
      const done = rs.filter((r) => r.status === "succeeded" || r.status === "failed");
      return done.length ? rs.filter((r) => r.status === "succeeded").length / done.length : null;
    };
    const durations = runs
      .filter((r) => r.status === "succeeded" && r.started_at && r.finished_at)
      .map((r) => (new Date(r.finished_at!).getTime() - new Date(r.started_at!).getTime()) / 1000)
      .filter((s) => s > 0)
      .sort((a, b) => a - b);
    const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;
    const cost = runs.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
    const pos = data.reactions.filter((r) => POSITIVE.includes(r.emoji)).length;
    const neg = data.reactions.filter((r) => NEGATIVE.includes(r.emoji)).length;

    const success = rate(runs);
    const prevSuccess = rate(prevRuns);
    const correctionRate = runs.length ? learnings.length / runs.length : 0;
    const prevCorrectionRate = prevRuns.length ? prevLearnings.length / prevRuns.length : null;
    const satisfaction = pos + neg ? pos / (pos + neg) : null;

    // 50 % fiabilité, 30 % absence de reprises, 20 % satisfaction. Un signal
    // absent ne pénalise pas : son poids se reporte sur les autres.
    const parts: Array<[number, number]> = [];
    if (success != null) parts.push([success, 0.5]);
    if (runs.length) parts.push([Math.max(0, 1 - correctionRate * 2), 0.3]);
    if (satisfaction != null) parts.push([satisfaction, 0.2]);
    const w = parts.reduce((s, [, x]) => s + x, 0);
    const score = w ? Math.round((parts.reduce((s, [v, x]) => s + v * x, 0) / w) * 100) : null;

    const byFile = new Map<string, number>();
    for (const l of learnings) byFile.set(l.target_file, (byFile.get(l.target_file) ?? 0) + 1);

    return {
      runs: runs.length, success, prevSuccess, median, cost, pos, neg, satisfaction,
      corrections: learnings.length, correctionRate, prevCorrectionRate, byFile,
      recentCorrections: learnings.slice(0, 5),
      failures: runs.filter((r) => r.status === "failed").slice(0, 5),
      score,
    };
  }, [data, since]);

  return (
    <div className="flex h-full flex-col overflow-y-auto px-4 py-3 text-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Évaluation</h3>
        <div className="flex gap-0.5 rounded-full bg-muted p-0.5">
          {([7, 30, 90] as Period[]).map((p) => (
            <button key={p} type="button" onClick={() => setPeriod(p)}
              className={cn("rounded-full px-2 py-0.5 text-[11px]", period === p ? "bg-background font-medium shadow-sm" : "text-muted-foreground")}>
              {p} j
            </button>
          ))}
        </div>
      </div>

      {isLoading || !m ? (
        <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : m.runs === 0 ? (
        <p className="pt-10 text-center text-xs text-muted-foreground">Aucune activité sur les {period} derniers jours : rien à évaluer.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-4 rounded-xl border border-border/70 p-3">
            <div className={cn(
              "flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-lg font-semibold tabular-nums",
              m.score == null ? "bg-muted text-muted-foreground"
                : m.score >= 80 ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : m.score >= 60 ? "bg-amber-500/15 text-amber-700 dark:text-amber-500"
                : "bg-red-500/15 text-red-700 dark:text-red-400",
            )}>
              {m.score ?? "–"}
            </div>
            <p className="text-xs text-muted-foreground">
              Score sur {period} jours : fiabilité des runs, reprises par l'utilisateur et réactions dans les rooms.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Stat label="Runs aboutis" value={pct(m.success)} delta={diff(m.success, m.prevSuccess)} hint={`${m.runs} run(s)`} />
            <Stat label="Reprises / run" value={m.correctionRate.toFixed(2)} delta={diff(m.prevCorrectionRate, m.correctionRate)} hint={`${m.corrections} reprise(s)`} />
            <Stat label="Satisfaction" value={pct(m.satisfaction)} hint={
              <span className="inline-flex items-center gap-1.5">
                <ThumbsUp className="h-3 w-3" /> {m.pos} <ThumbsDown className="ml-1 h-3 w-3" /> {m.neg}
              </span>
            } />
            <Stat label="Durée médiane" value={m.median == null ? "–" : fmtDuration(m.median)} hint={`${m.cost.toFixed(2)} $ sur la période`} />
          </div>

          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Ce que l'utilisateur a corrigé</h4>
              {onOpenLearnings && m.corrections > 0 && (
                <button type="button" onClick={onOpenLearnings} className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                  Journal <ArrowRight className="h-3 w-3" />
                </button>
              )}
            </div>
            {m.corrections === 0 ? (
              <p className="text-xs text-muted-foreground">Aucune reprise sur la période.</p>
            ) : (
              <>
                <p className="mb-1.5 text-[11px] text-muted-foreground">
                  {[...m.byFile].map(([f, n]) => `${n} sur ${f}.md`).join(" · ")}
                </p>
                <ul className="space-y-1.5">
                  {m.recentCorrections.map((l) => (
                    <li key={l.id} className="rounded-lg border border-border/70 px-2.5 py-1.5">
                      <p className="flex items-start gap-1.5 text-xs"><GraduationCap className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />{l.lesson}</p>
                      <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">« {l.feedback} »</p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Derniers échecs</h4>
            {m.failures.length === 0 ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="h-3.5 w-3.5 text-emerald-600" /> Aucun échec sur la période.</p>
            ) : (
              <ul className="space-y-1.5">
                {m.failures.map((r) => (
                  <li key={r.id} className="flex items-start gap-1.5 text-xs">
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    <span className="min-w-0">
                      <span className="text-muted-foreground">{new Date(r.created_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })} · </span>
                      <span className="line-clamp-2">{r.error_message || "Erreur sans message"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint, delta }: { label: string; value: string; hint?: React.ReactNode; delta?: number | null }) {
  return (
    <div className="rounded-xl border border-border/70 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-base font-semibold tabular-nums">{value}</span>
        {delta != null && Math.abs(delta) >= 0.01 && (
          <span className={cn("text-[10px] tabular-nums", delta > 0 ? "text-emerald-600" : "text-red-600")}>
            {delta > 0 ? "▲" : "▼"} {Math.round(Math.abs(delta) * 100)} pt
          </span>
        )}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

const pct = (v: number | null) => (v == null ? "–" : `${Math.round(v * 100)} %`);
/** Positive = better. For corrections, pass (previous, current) so fewer reads as progress. */
const diff = (a: number | null, b: number | null) => (a == null || b == null ? null : a - b);
const fmtDuration = (s: number) => (s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
