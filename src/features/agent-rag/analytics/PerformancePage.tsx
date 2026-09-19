import { useMemo } from "react";
import {
  QuestionIcon as HelpCircle,
  ChatIcon as MessageSquare,
  SparkleIcon as Sparkles,
} from "@phosphor-icons/react";
import { SectionCard, Empty, BarList } from "@/features/dashboard/hq/primitives";
import { useCategorical } from "@/features/crm/overview/vizPalette";
import { Funnel, type FunnelLink, type FunnelNode } from "./Funnel";
import { CoverageNote, RateCard, SegmentedBar, type Segment } from "./panels";
import { useOutcomeColors, useRatingScale, useSequential } from "./vizRamps";
import { CHANNEL_LABELS, OUTCOME_LABELS, RATING_LABELS, reasonLabel, reasonSlot, REASON_HINTS } from "./labels";
import { measured, pct, pointsDelta, nf, type AgentAnalytics } from "./useAgentAnalytics";

// Page Performance — ce que l'agent public abat, et ce qu'en pensent les gens.
//
// Quatre taux, une distribution de satisfaction, les motifs derrière les votes,
// et l'entonnoir qui relie le tout. Chaque taux affiche sa phrase « X sur Y » :
// un pourcentage seul est le meilleur moyen de faire dire à un tableau de bord
// ce qu'on veut entendre.

export function PerformancePage({ data, agentName }: { data: AgentAnalytics; agentName: string }) {
  const t = data.totals;
  const prev = data.previous;
  const cat = useCategorical();
  const ratingScale = useRatingScale();
  const outcomeColors = useOutcomeColors();
  const seq = useSequential();

  const mes = measured(t);
  const prevMes = Math.max(0, prev.total); // la période précédente n'expose pas son non-mesuré
  const automation = pct(t.resolved, mes);
  const involvement = pct(t.involved, t.total);
  const resolution = pct(t.resolved, t.involved);
  const cxScore = pct(t.rated_positive, t.rated);

  const ratingSegments: Segment[] = useMemo(() => {
    const byScore = new Map(data.ratings.map((r) => [r.score, r.n]));
    return [5, 4, 3, 2, 1].map((score) => ({
      key: `r${score}`,
      label: `${score} — ${RATING_LABELS[score]}`,
      value: byScore.get(score) ?? 0,
      color: ratingScale[score - 1],
    }));
  }, [data.ratings, ratingScale]);

  const reasonSegments = (rows: { reason: string; n: number }[]): Segment[] =>
    rows.map((r) => ({
      key: r.reason,
      label: reasonLabel(r.reason),
      value: r.n,
      color: cat[Math.min(reasonSlot(r.reason), cat.length - 1)],
      hint: REASON_HINTS[r.reason],
    }));

  // ── Entonnoir ────────────────────────────────────────────────────────────
  const { stages, links } = useMemo(() => {
    const channels = data.channels.filter((c) => c.n > 0);
    const notInvolved = Math.max(0, t.total - t.involved);

    const stage0: FunnelNode[] = channels.map((c) => ({
      key: `ch:${c.channel}`,
      label: CHANNEL_LABELS[c.channel] ?? c.channel,
      value: c.n,
      color: seq[3],
    }));
    const stage1: FunnelNode[] = [
      { key: "inv:yes", label: "Agent impliqué", value: t.involved, color: seq[3] },
      { key: "inv:no", label: "Sans échange", value: notInvolved, color: outcomeColors.unknown },
    ];
    const stage2: FunnelNode[] = [
      { key: "out:resolved", label: OUTCOME_LABELS.resolved, value: t.resolved, color: outcomeColors.resolved },
      { key: "out:escalated", label: OUTCOME_LABELS.escalated, value: t.escalated, color: outcomeColors.escalated },
      { key: "out:unresolved", label: OUTCOME_LABELS.unresolved, value: t.unresolved, color: outcomeColors.unresolved },
      { key: "out:abandoned", label: OUTCOME_LABELS.abandoned, value: t.abandoned, color: outcomeColors.abandoned },
    ];
    const stage3: FunnelNode[] = [
      { key: "cx:positive", label: "CX positif", value: t.rated_positive, color: ratingScale[4] },
      { key: "cx:neutral", label: "CX neutre", value: t.rated_neutral, color: ratingScale[2] },
      { key: "cx:negative", label: "CX négatif", value: t.rated_negative, color: ratingScale[0] },
      { key: "cx:unrated", label: "Sans vote", value: Math.max(0, t.involved - t.rated), color: outcomeColors.unknown },
    ];

    const l: FunnelLink[] = [];
    for (const c of channels) {
      if (c.involved > 0) l.push({ from: `ch:${c.channel}`, to: "inv:yes", value: c.involved });
      const off = c.n - c.involved;
      if (off > 0) l.push({ from: `ch:${c.channel}`, to: "inv:no", value: off });
    }
    for (const o of ["resolved", "escalated", "unresolved", "abandoned"] as const) {
      if (t[o] > 0) l.push({ from: "inv:yes", to: `out:${o}`, value: t[o] });
    }
    // Dernier étage : uniquement le tableau croisé réel (issue × vote).
    for (const row of data.outcome_cx) {
      if (row.outcome === "unknown" || row.n <= 0) continue;
      l.push({ from: `out:${row.outcome}`, to: `cx:${row.cx}`, value: row.n });
    }
    return { stages: [stage0, stage1, stage2, stage3], links: l };
  }, [data, t, seq, outcomeColors, ratingScale]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ── Automatisation ── */}
        <div className="space-y-4">
          <RateCard
            title="Taux d'automatisation"
            hint="Part des conversations mesurées que l'agent a menées jusqu'à une réponse appuyée sur sa base ou sur un outil."
            sentence={<>{nf.format(t.resolved)} conversations résolues par {agentName} sur {nf.format(mes)} mesurées</>}
            value={automation}
            delta={pointsDelta(automation, pct(prev.resolved, prevMes))}
            part={t.resolved}
            total={mes}
            color={outcomeColors.resolved}
            footer={<CoverageNote measuredCount={mes} total={t.total} />}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <RateCard
              title="Taux d'implication"
              hint="Conversations où l'agent a réellement répondu, sur l'ensemble des conversations ouvertes."
              sentence={<>L'agent est intervenu dans {nf.format(t.involved)} des {nf.format(t.total)} conversations ouvertes</>}
              value={involvement}
              delta={pointsDelta(involvement, pct(prev.involved, prev.total))}
              part={t.involved}
              total={t.total}
              color={seq[2]}
            />
            <RateCard
              title="Taux de résolution"
              hint="Parmi les conversations où l'agent est intervenu, celles qui se terminent par une réponse fondée."
              sentence={<>{nf.format(t.resolved)} résolues sur {nf.format(t.involved)} où l'agent est intervenu</>}
              value={resolution}
              delta={pointsDelta(resolution, pct(prev.resolved, prev.involved))}
              part={t.resolved}
              total={t.involved}
              color={outcomeColors.resolved}
            />
          </div>
        </div>

        {/* ── Satisfaction ── */}
        <div className="space-y-4">
          <RateCard
            title="Score CX"
            hint="Part de votes 4 ou 5 parmi les conversations notées. Les conversations sans vote ne sont comptées ni pour ni contre."
            sentence={<>{nf.format(t.rated_positive)} votes positifs (4 ou 5) sur {nf.format(t.rated)} votes reçus</>}
            value={cxScore}
            delta={pointsDelta(cxScore, pct(prev.rated_positive, prev.rated))}
            part={t.rated_positive}
            total={t.rated}
            color={ratingScale[4]}
            footer={<div className="pt-1"><SegmentedBar segments={ratingSegments} columns={2} /></div>}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SectionCard title="Motifs des avis positifs" subtitle="Conversations notées 4 ou 5" icon={<Sparkles className="h-3.5 w-3.5" />}>
              <SegmentedBar segments={reasonSegments(data.reasons_positive)} columns={1}
                emptyLabel="Aucun vote positif sur la période." />
            </SectionCard>
            <SectionCard title="Motifs des avis négatifs" subtitle="Conversations notées 1 ou 2" icon={<HelpCircle className="h-3.5 w-3.5" />}>
              <SegmentedBar segments={reasonSegments(data.reasons_negative)} columns={1}
                emptyLabel="Aucun vote négatif sur la période." />
            </SectionCard>
          </div>
        </div>
      </div>

      <SectionCard
        title="Entonnoir de performance"
        subtitle="Du canal d'entrée jusqu'au vote — chaque flux est un comptage, jamais une répartition au prorata."
      >
        {t.total === 0
          ? <Empty label="Aucune conversation sur la période." />
          : <Funnel stages={stages} links={links} height={360} />}
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Pourquoi ça n'aboutit pas" subtitle="Motifs des conversations non résolues, escaladées ou sans réponse">
          <BarList
            labelWidth="w-40"
            emptyLabel="Rien à signaler sur la période."
            rows={data.reasons_unresolved.map((r) => ({
              key: r.reason,
              label: reasonLabel(r.reason),
              value: r.n,
              color: cat[Math.min(reasonSlot(r.reason), cat.length - 1)],
              caption: `${nf.format(r.n)} conv.`,
            }))}
          />
        </SectionCard>
        <SectionCard title="Questions les plus posées" subtitle="Premiers mots des questions reçues" icon={<MessageSquare className="h-3.5 w-3.5" />}>
          <BarList
            labelWidth="w-56"
            emptyLabel="Aucune question sur la période."
            rows={data.questions.map((q, i) => ({
              key: `${i}-${q.question}`,
              label: q.question,
              value: q.n,
              color: seq[2],
              caption: `${nf.format(q.n)}×`,
            }))}
          />
        </SectionCard>
      </div>
    </div>
  );
}
