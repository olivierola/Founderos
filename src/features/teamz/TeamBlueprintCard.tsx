import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CaretDownIcon, CaretRightIcon, CheckCircleIcon, RocketLaunchIcon } from "@phosphor-icons/react";
import { AgentIdentity } from "@/components/AgentIdentity";
import { Button } from "@/components/ui/button";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { TeamBlueprintView } from "./TeamBlueprintView";
import { TeamAssembly } from "./TeamAssembly";
import { TeamConstellation } from "./TeamConstellation";
import { QualityRing } from "./ui";
import {
  deployTeam, lintBlueprint, useConnectedApps,
  type BlueprintLint, type DeployResponse, type DeployedAgent, type TeamBlueprint,
} from "./api";
import "./teamz.css";

/** Ce que portent l'artefact `team_blueprint` du panneau et le bloc d'une room. */
export interface TeamBlueprintCardData {
  blueprint_id?: string | null;
  blueprint?: TeamBlueprint;
  lint?: BlueprintLint;
  refined?: string[];
  origin?: string;
  based_on?: string | null;
  service_id?: string | null;
  deployed?: {
    team_id: string; team_name: string; service_id: string; agents: DeployedAgent[];
    missing_plugs: string[]; routines: Array<{ label: string; owner: string; next_run_at: string }>;
    kickoff_run_id: string | null; url: string | null;
  } | null;
}

/** La carte d'une équipe dans une conversation : le plan, son score, et le
 *  bouton qui la fait naître — avec l'assemblage animé, sur place. */
export function TeamBlueprintCard({ data }: { data: TeamBlueprintCardData }) {
  const bp = data.blueprint;
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { projectId } = useCurrentContext();
  const dashboardId = location.pathname.match(/\/service\/([0-9a-f-]{36})/i)?.[1] ?? data.deployed?.service_id ?? data.service_id ?? null;
  const connected = useConnectedApps(projectId, dashboardId);
  const [open, setOpen] = useState(false);
  const [kickoff, setKickoff] = useState(false);
  const [assembling, setAssembling] = useState(false);
  const [result, setResult] = useState<DeployResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!bp || !Array.isArray(bp.members)) return null;
  const lint = data.lint ?? lintBlueprint(bp);
  const deployed = data.deployed ?? null;

  const deploy = async () => {
    if (!dashboardId) { setError("Ouvrez un service pour y déployer l'équipe."); return; }
    setAssembling(true);
    setError(null);
    try {
      const res = await deployTeam(dashboardId, { blueprintId: data.blueprint_id ?? null, blueprint: data.blueprint_id ? null : bp, kickoff });
      setResult(res);
      await qc.invalidateQueries({ queryKey: ["service_dashboards"] });
      await qc.invalidateQueries({ queryKey: ["sd_panel_agents", dashboardId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (assembling) {
    return (
      <div className="mt-3 rounded-2xl border border-border bg-card p-4">
        <TeamAssembly
          blueprint={bp} result={result} error={error} onRetry={deploy}
          actions={result?.url ? <Button size="sm" variant="outline" onClick={() => navigate(result.url!)}>Ouvrir les équipes</Button> : undefined}
        />
      </div>
    );
  }

  return (
    <div className="tz-card mt-3 p-4" style={{ ["--tz-accent" as string]: bp.accent }} data-live={!!deployed}>
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted text-xl">{bp.emoji}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14.5px] font-semibold">{deployed?.team_name ?? bp.name}</span>
            {deployed && <CheckCircleIcon className="h-4 w-4 text-emerald-500" weight="fill" />}
          </div>
          <div className="truncate text-[12px] text-muted-foreground">
            {bp.members.length} agents · {bp.links.length} liens A2A · ≈ {bp.hours_saved_per_week} h / semaine
          </div>
        </div>
        <QualityRing score={lint.score} size={44} />
      </div>

      {deployed ? (
        <TeamConstellation
          nodes={deployed.agents.map((a) => ({ id: a.key, name: a.name, accent: a.accent, lead: a.lead }))}
          edges={bp.links.map((l) => ({ from: l.from, to: l.to, kind: l.kind }))}
          accent={bp.accent} height={180} className="mt-2"
        />
      ) : (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {bp.members.map((m) => (
            <span key={m.key} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/60 py-0.5 pl-0.5 pr-2.5 text-[12px]" title={m.role}>
              <AgentIdentity seed={m.name} size={20} interactive={false} />
              <span className="font-medium">{m.name}</span>
              <span className="max-w-[140px] truncate text-muted-foreground">{m.role}</span>
            </span>
          ))}
        </div>
      )}

      <button type="button" onClick={() => setOpen((o) => !o)} className="mt-3 inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
        {open ? <CaretDownIcon className="h-3 w-3" /> : <CaretRightIcon className="h-3 w-3" />} {open ? "Masquer" : "Voir"} les rôles, les prompts et le flux
      </button>
      {open && <div className="mt-3"><TeamBlueprintView blueprint={bp} lint={lint} connected={connected} refined={data.refined} compact /></div>}

      {!deployed && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <input type="checkbox" checked={kickoff} onChange={(e) => setKickoff(e.target.checked)} disabled={!bp.kickoff} />
            Lancer aussi la mission de démarrage
          </label>
          <div className="flex items-center gap-2">
            {error && <span className="text-[12px] text-red-600">{error}</span>}
            <Button size="sm" onClick={deploy} className="text-white hover:opacity-90" style={{ background: bp.accent }}>
              <RocketLaunchIcon className="h-3.5 w-3.5" weight="fill" /> Déployer l'équipe
            </Button>
          </div>
        </div>
      )}
      {deployed?.url && (
        <div className="mt-3 flex justify-end border-t border-border/70 pt-3">
          <Button size="sm" variant="outline" onClick={() => navigate(deployed.url!)}>Voir l'équipe au travail</Button>
        </div>
      )}
    </div>
  );
}
