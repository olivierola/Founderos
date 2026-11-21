import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircleIcon, CircleNotchIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { AgentIdentity } from "@/components/AgentIdentity";
import { cn } from "@/lib/utils";
import { ConnectorCards } from "@/features/ai-agent/ConnectorCards";
import { TeamConstellation } from "./TeamConstellation";
import { CountUp, Stat } from "./ui";
import { composeMemberPrompt, describeCron, type DeployResponse, type TeamBlueprint } from "./api";
import "./teamz.css";

// L'assemblage d'une équipe, en direct. La requête de déploiement part tout de
// suite ; pendant qu'elle crée les agents un à un, l'écran montre ce qui se
// passe vraiment : chaque agent se matérialise, le début de SON prompt
// s'écrit, ses compteurs montent, puis le flux de l'équipe se dessine. Les
// coches « créé » n'apparaissent qu'avec la réponse du serveur — l'animation
// ne promet rien que la base n'ait confirmé.

const STEP_MS = 700;

export function TeamAssembly({ blueprint, result, error, onRetry, actions }: {
  blueprint: TeamBlueprint;
  /** La réponse du déploiement, quand elle est arrivée. */
  result: DeployResponse | null;
  error: string | null;
  onRetry?: () => void;
  /** Les suites possibles, une fois l'équipe prête. */
  actions?: ReactNode;
}) {
  const members = blueprint.members;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (shown >= members.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 250 : STEP_MS);
    return () => clearTimeout(t);
  }, [shown, members.length]);

  const allShown = shown >= members.length;
  const done = allShown && !!result;
  const createdByKey = useMemo(() => new Map((result?.agents ?? []).map((a) => [a.key, a])), [result]);
  const teamCtx = useMemo(() => ({
    name: blueprint.name, mission: blueprint.mission, playbook: blueprint.playbook, members, links: blueprint.links,
  }), [blueprint, members]);
  const prompts = useMemo(() => members.map((m) => composeMemberPrompt(teamCtx, m)), [members, teamCtx]);
  const totalChars = prompts.reduce((n, p) => n + p.length, 0);
  const visible = useMemo(() => new Set(members.slice(0, shown).map((m) => m.key)), [members, shown]);
  const progress = Math.round(((Math.min(shown, members.length) + (result ? 1 : 0)) / (members.length + 1)) * 100);

  return (
    <div className="space-y-5" style={{ ["--tz-accent" as string]: blueprint.accent }}>
      <div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            {error ? <WarningCircleIcon className="h-4 w-4 text-red-500" weight="fill" />
              : done ? <CheckCircleIcon className="h-4 w-4 text-emerald-500" weight="fill" />
              : <CircleNotchIcon className="h-4 w-4 animate-spin" style={{ color: blueprint.accent }} />}
            <span className={cn(!done && !error && "tz-shimmer")}>
              {error ? "L'assemblage s'est interrompu"
                : done ? `« ${result!.team.name} » est opérationnelle`
                : allShown ? "Câblage du flux A2A et des routines…"
                : `Assemblage de l'équipe « ${blueprint.name} »…`}
            </span>
          </div>
          <span className="text-[12px] tabular-nums text-muted-foreground">{progress} %</span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-secondary">
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${progress}%`, background: blueprint.accent }} />
        </div>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        {members.map((m, i) => {
          if (i >= shown) return <div key={m.key} className="h-[118px] rounded-xl border border-dashed border-border/70" />;
          const created = createdByKey.get(m.key);
          return (
            <div key={m.key} className="tz-materialize relative overflow-hidden rounded-xl border border-border bg-card p-3" style={{ ["--tz-accent" as string]: m.accent ?? blueprint.accent }}>
              <div className="flex items-center gap-2.5">
                <span className="relative">
                  {!created && !error && <span className="tz-live-ring" />}
                  <AgentIdentity seed={created?.name ?? m.name} size={34} interactive={false} state={created ? "default" : "working"} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13.5px] font-semibold">{created?.name ?? m.name}</span>
                    {m.lead && <span className="rounded-full px-1.5 text-[10px] font-medium text-white" style={{ background: m.accent ?? blueprint.accent }}>anime</span>}
                  </div>
                  <div className="truncate text-[11.5px] text-muted-foreground">{m.role}</div>
                </div>
                {created
                  ? <CheckCircleIcon className="h-[18px] w-[18px] text-emerald-500" weight="fill" />
                  : !error && <CircleNotchIcon className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              </div>
              <Typewriter text={prompts[i].split("\n").slice(3, 6).join(" ")} />
              <div className="mt-1.5 flex gap-3 text-[10.5px] text-muted-foreground">
                <span><CountUp value={prompts[i].length} duration={900} /> car. de prompt</span>
                <span><CountUp value={m.tools.length + (m.connectors?.length ?? 0)} duration={700} /> outils</span>
              </div>
            </div>
          );
        })}
      </div>

      {allShown && (
        <div className="relative rounded-2xl border border-border bg-secondary/20">
          <TeamConstellation
            nodes={members.map((m) => ({ id: m.key, name: createdByKey.get(m.key)?.name ?? m.name, accent: m.accent, lead: m.lead }))}
            edges={blueprint.links.map((l) => ({ from: l.from, to: l.to, kind: l.kind }))}
            accent={blueprint.accent}
            drawIn={!done}
            height={230}
          />
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-[13px] text-red-700 dark:text-red-300">
          {error}
          {onRetry && <button type="button" onClick={onRetry} className="ml-2 font-medium underline underline-offset-2">Réessayer</button>}
        </div>
      )}

      {done && result && (
        <div className="tz-materialize space-y-4 rounded-2xl border border-border bg-card p-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="agents créés"><CountUp value={result.agents.length} /></Stat>
            <Stat label="caractères de prompts" hint="Chaque agent reçoit un prompt système complet : mission, méthode, équipe, flux, limites.">
              <CountUp value={totalChars} duration={1400} />
            </Stat>
            <Stat label="liens de travail A2A"><CountUp value={result.team.links?.length ?? blueprint.links.length} /></Stat>
            <Stat label="h gagnées / semaine (estimation)" hint="Estimation déclarée par le modèle d'équipe ou calculée : ~4 tâches par membre et par semaine × durée humaine d'une tâche, plus les routines.">
              ≈ <CountUp value={blueprint.hours_saved_per_week} />
            </Stat>
          </div>
          {result.routines.length > 0 && (
            <div className="text-[12.5px] text-muted-foreground">
              Routines planifiées : {result.routines.map((r) => `${r.label} (${r.owner}, prochaine ${new Date(r.next_run_at).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit" })})`).join(" · ")}
            </div>
          )}
          {result.routines.length === 0 && blueprint.routines.length > 0 && (
            <div className="text-[12.5px] text-muted-foreground">
              Routines proposées : {blueprint.routines.map((r) => `${r.label}, ${describeCron(r.cron)}`).join(" · ")}
            </div>
          )}
          {result.kickoffRunId && (
            <div className="flex items-center gap-2 text-[13px]">
              <span className="relative inline-flex h-2 w-2"><span className="tz-live-ring" /><span className="h-2 w-2 rounded-full" style={{ background: blueprint.accent }} /></span>
              La mission de démarrage est lancée : l'animateur répartit déjà le travail.
            </div>
          )}
          {result.notes.length > 0 && <div className="text-[12px] text-amber-700 dark:text-amber-300">{result.notes.join(" · ")}</div>}
          {result.missingPlugs.length > 0 && (
            <div>
              <div className="text-[12.5px] font-medium">Branchez ces apps : l'équipe entière les reçoit d'un coup.</div>
              <ConnectorCards proposal={{
                agent_ids: result.agents.map((a) => a.id),
                items: result.missingPlugs.map((slug) => ({ slug, name: blueprint.plugs.find((p) => p.slug === slug)?.name ?? slug, reason: blueprint.plugs.find((p) => p.slug === slug)?.why ?? "", status: "not_connected" })),
              }} />
            </div>
          )}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
    </div>
  );
}

/** Le début du prompt d'un agent, écrit sous les yeux. */
function Typewriter({ text, speed = 4 }: { text: string; speed?: number }) {
  const clean = text.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 170);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setN(clean.length); return; }
    if (n >= clean.length) return;
    const t = setTimeout(() => setN((x) => Math.min(clean.length, x + speed)), 16);
    return () => clearTimeout(t);
  }, [n, clean, speed]);
  return (
    <p className={cn("mt-2 line-clamp-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground", n < clean.length && "tz-caret")}>
      {clean.slice(0, n)}
    </p>
  );
}
