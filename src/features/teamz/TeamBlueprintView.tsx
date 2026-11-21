import { useMemo, useState } from "react";
import {
  CaretDownIcon, CaretRightIcon, ClockIcon, CopyIcon, CheckIcon, LightningIcon, SparkleIcon, TargetIcon,
} from "@phosphor-icons/react";
import { AgentIdentity } from "@/components/AgentIdentity";
import { cn } from "@/lib/utils";
import { TeamConstellation } from "./TeamConstellation";
import { PlugChip, QualityRing } from "./ui";
import {
  composeMemberPrompt, describeCron, lintBlueprint, useAppLogos,
  type BlueprintLint, type TeamBlueprint, type TeamzMember,
} from "./api";
import "./teamz.css";

const LINK_WORD: Record<string, string> = { handoff: "→ passe la main à", consult: "↔ consulte", review: "↺ fait relire par" };

/** Un plan d'équipe, lisible et vérifiable : ce que chaque agent recevra
 *  comme prompt système est affiché tel quel, avec son score. */
export function TeamBlueprintView({ blueprint, lint, connected, compact = false, refined = [] }: {
  blueprint: TeamBlueprint;
  lint?: BlueprintLint;
  connected?: Set<string>;
  compact?: boolean;
  refined?: string[];
}) {
  const quality = useMemo(() => lint ?? lintBlueprint(blueprint), [lint, blueprint]);
  const logos = useAppLogos();
  const nameOf = (k: string) => blueprint.members.find((m) => m.key === k)?.name ?? k;
  const teamCtx = useMemo(() => ({
    name: blueprint.name, mission: blueprint.mission, playbook: blueprint.playbook,
    members: blueprint.members, links: blueprint.links,
  }), [blueprint]);

  return (
    <div className="min-w-0 space-y-5" style={{ ["--tz-accent" as string]: blueprint.accent }}>
      <div className="flex items-start gap-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-muted text-[22px]">
          {blueprint.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold tracking-tight">{blueprint.name}</h3>
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {blueprint.members.length} agents · {blueprint.links.length} liens A2A · {blueprint.routines.length} routine{blueprint.routines.length > 1 ? "s" : ""}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{blueprint.mission}</p>
        </div>
        <div className="flex flex-col items-center">
          <QualityRing score={quality.score} />
          <span className="mt-1 text-[10.5px] text-muted-foreground">qualité</span>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-secondary/20">
        <TeamConstellation
          nodes={blueprint.members.map((m) => ({ id: m.key, name: m.name, accent: m.accent, lead: m.lead }))}
          edges={blueprint.links.map((l) => ({ from: l.from, to: l.to, kind: l.kind }))}
          accent={blueprint.accent}
          height={compact ? 190 : 240}
        />
      </div>

      {!compact && blueprint.outcomes.length > 0 && (
        <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {blueprint.outcomes.map((o) => (
            <li key={o} className="flex min-w-0 items-start gap-2 text-[13px] text-muted-foreground">
              <TargetIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: blueprint.accent }} /> <span className="min-w-0">{o}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2">
        {blueprint.members.map((m) => (
          <MemberRow
            key={m.key} member={m} prompt={composeMemberPrompt(teamCtx, m)}
            score={quality.members.find((x) => x.key === m.key)?.score ?? 0}
            issues={quality.members.find((x) => x.key === m.key)?.issues ?? []}
            refined={refined.includes(m.name)}
            flow={blueprint.links.filter((l) => l.from === m.key).map((l) => `${LINK_WORD[l.kind] ?? l.kind} ${nameOf(l.to)}`)}
          />
        ))}
      </div>

      {quality.team.length > 0 && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-800 dark:text-amber-200">
          À surveiller : {quality.team.join(" · ")}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-2 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">Apps à brancher</div>
          <div className="flex flex-wrap gap-1.5">
            {blueprint.plugs.length === 0 && <span className="text-[12.5px] text-muted-foreground">Aucune</span>}
            {blueprint.plugs.map((p) => (
              <PlugChip key={p.slug} name={logos.get(p.slug)?.name ?? p.name} logo={logos.get(p.slug)?.logo} required={p.required} connected={connected?.has(p.slug)} title={p.why} />
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">Routines</div>
          {blueprint.routines.length === 0 && <span className="text-[12.5px] text-muted-foreground">Aucune</span>}
          <ul className="space-y-1">
            {blueprint.routines.map((r) => (
              <li key={r.label} className="flex items-start gap-2 text-[12.5px]">
                <ClockIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span><span className="font-medium">{r.label}</span> · {nameOf(r.owner)} · <span className="text-muted-foreground">{describeCron(r.cron)}</span></span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {!compact && blueprint.playbook.length > 0 && (
        <div>
          <div className="mb-2 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">Règles de l'équipe</div>
          <ul className="space-y-1">
            {blueprint.playbook.map((r) => <li key={r} className="text-[12.5px]">· {r}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function MemberRow({ member: m, prompt, score, issues, refined, flow }: {
  member: TeamzMember; prompt: string; score: number; issues: string[]; refined: boolean; flow: string[];
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card" style={{ ["--tz-accent" as string]: m.accent ?? "#8b7cf6" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-secondary/40 focus-visible:bg-secondary/40">
        {open ? <CaretDownIcon className="h-3.5 w-3.5 text-muted-foreground" /> : <CaretRightIcon className="h-3.5 w-3.5 text-muted-foreground" />}
        <AgentIdentity seed={m.name} size={30} interactive={false} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{m.name}</span>
            {m.lead && <span className="rounded-full px-1.5 text-[10px] font-medium text-white" style={{ background: m.accent ?? "#8b7cf6" }}>anime</span>}
            {refined && <span className="inline-flex items-center gap-0.5 rounded-full border border-border px-1.5 text-[10px] text-muted-foreground" title="Réécrit par le contrôle qualité"><SparkleIcon className="h-2.5 w-2.5" /> affiné</span>}
          </div>
          <div className="truncate text-[12px] text-muted-foreground">{m.role}{flow.length ? ` · ${flow.join(" · ")}` : ""}</div>
        </div>
        <span className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex">
          <LightningIcon className="h-3 w-3" /> {m.tools.length + (m.connectors?.length ?? 0)} outils
        </span>
        <span
          className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums",
            score >= 90 ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" : score >= 70 ? "bg-amber-500/12 text-amber-700 dark:text-amber-300" : "bg-red-500/12 text-red-700 dark:text-red-300")}
          title={issues.length ? issues.join(" · ") : "Rôle complet"}
        >
          {score}
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-3 pb-3 pt-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11.5px] text-muted-foreground">Prompt système · {prompt.length.toLocaleString("fr-FR")} caractères</span>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(prompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />} Copier
            </button>
          </div>
          <pre className="max-h-72 overflow-y-auto overflow-x-hidden scrollbar-hide break-words whitespace-pre-wrap rounded-lg bg-secondary/40 p-3 font-mono text-[11.5px] leading-relaxed">{prompt}</pre>
          {issues.length > 0 && <p className="mt-2 text-[11.5px] text-amber-700 dark:text-amber-300">À compléter : {issues.join(" · ")}</p>}
        </div>
      )}
    </div>
  );
}
