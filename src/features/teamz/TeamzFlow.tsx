import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CircleNotchIcon, RocketLaunchIcon, SparkleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { gatherTeam } from "@/features/service-dashboards/live/teams";
import { TeamBlueprintView } from "./TeamBlueprintView";
import { TeamAssembly } from "./TeamAssembly";
import {
  blueprintFromTemplate, deployTeam, designTeam, lintBlueprint, useConnectedApps,
  type DeployResponse, type DesignResponse, type TeamBlueprint, type TeamzTemplate,
} from "./api";
import "./teamz.css";

export type TeamzRequest =
  | { kind: "template"; template: TeamzTemplate }
  | { kind: "architect"; brief: string };

type Stage = "thinking" | "preview" | "assembling";

/** Ce que l'architecte fait, dit dans l'ordre où il le fait. */
const THINKING = [
  "Lecture du besoin",
  "Choix des rôles",
  "Rédaction des prompts",
  "Câblage des passations",
  "Planification des routines",
  "Contrôle qualité",
];

export function TeamzDialog({ request, dashboardId, dashboardName, onClose }: {
  request: TeamzRequest | null;
  dashboardId: string;
  dashboardName: string;
  onClose: () => void;
}) {
  const open = !!request;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="block max-h-[92vh] max-w-3xl overflow-y-auto overflow-x-hidden p-0 scrollbar-hide">
        {request && <TeamzFlowBody key={request.kind === "template" ? request.template.key : request.brief} request={request} dashboardId={dashboardId} dashboardName={dashboardName} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function TeamzFlowBody({ request, dashboardId, dashboardName, onClose }: {
  request: TeamzRequest; dashboardId: string; dashboardName: string; onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { workspaceId, projectId } = useCurrentContext();
  const connected = useConnectedApps(projectId, dashboardId);
  const [stage, setStage] = useState<Stage>(request.kind === "architect" ? "thinking" : "preview");
  const [design, setDesign] = useState<DesignResponse | null>(null);
  const [blueprint, setBlueprint] = useState<TeamBlueprint | null>(request.kind === "template" ? blueprintFromTemplate(request.template) : null);
  const [kickoff, setKickoff] = useState(true);
  const [routines, setRoutines] = useState(true);
  const [result, setResult] = useState<DeployResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  // L'architecte part dès l'ouverture : la réflexion EST le spectacle.
  useEffect(() => {
    if (request.kind !== "architect" || started.current) return;
    started.current = true;
    designTeam(dashboardId, request.brief)
      .then((d) => { setDesign(d); setBlueprint(d.blueprint); setStage("preview"); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [request, dashboardId]);

  const deploy = async () => {
    if (!blueprint) return;
    setStage("assembling");
    setError(null);
    setResult(null);
    try {
      const res = await deployTeam(dashboardId, {
        blueprintId: design?.blueprint_id ?? null,
        templateKey: request.kind === "template" ? request.template.key : null,
        // Un plan conçu mais non enregistré (table absente) part tel quel.
        blueprint: design && !design.blueprint_id ? blueprint : null,
        kickoff, routines,
      });
      setResult(res);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["service_dashboards"] }),
        qc.invalidateQueries({ queryKey: ["sd_agents", dashboardId] }),
        qc.invalidateQueries({ queryKey: ["sd_panel_agents", dashboardId] }),
        qc.invalidateQueries({ queryKey: ["sd_schedules", dashboardId] }),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const gather = async () => {
    if (!result || !workspaceId || !projectId) return;
    const roomId = await gatherTeam(result.team, { id: dashboardId, name: dashboardName }, workspaceId, projectId, user?.id ?? null);
    onClose();
    if (roomId && result.url) navigate(result.url.replace(/\/teamz$/, `/room/${roomId}`));
  };

  return (
    <div className="min-w-0 p-6 pr-12">
      <DialogTitle className="sr-only">Équipes</DialogTitle>
      {stage === "thinking" && <ArchitectThinking brief={request.kind === "architect" ? request.brief : ""} error={error} onClose={onClose} />}

      {stage === "preview" && blueprint && (
        <div className="space-y-5">
          {design && (
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              <SparkleIcon className="h-3.5 w-3.5" style={{ color: blueprint.accent }} weight="fill" />
              {design.origin === "fallback"
                ? "Teamz du catalogue la plus proche de votre demande"
                : `Conçue pour vous${design.refined.length ? ` · ${design.refined.length} rôle${design.refined.length > 1 ? "s" : ""} affiné${design.refined.length > 1 ? "s" : ""}` : ""}`}
            </div>
          )}
          <TeamBlueprintView blueprint={blueprint} lint={design?.lint ?? lintBlueprint(blueprint)} connected={connected} refined={design?.refined} />
          <div className="space-y-2 rounded-2xl border border-border p-3.5">
            <Toggle on={kickoff} onChange={setKickoff} label="Lancer la mission de démarrage" hint={blueprint.kickoff ? blueprint.kickoff.title : "Aucune dans ce plan"} disabled={!blueprint.kickoff} />
            <Toggle on={routines} onChange={setRoutines} label="Planifier les routines" hint={blueprint.routines.length ? `${blueprint.routines.length} routine${blueprint.routines.length > 1 ? "s" : ""}` : "Aucune dans ce plan"} disabled={!blueprint.routines.length} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-muted-foreground">Service : {dashboardName}</span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>Annuler</Button>
              <Button onClick={deploy} style={{ background: blueprint.accent }} className="text-white hover:opacity-90">
                <RocketLaunchIcon className="h-4 w-4" weight="fill" /> Déployer l'équipe
              </Button>
            </div>
          </div>
        </div>
      )}

      {stage === "assembling" && blueprint && (
        <TeamAssembly
          blueprint={blueprint}
          result={result}
          error={error}
          onRetry={deploy}
          actions={result ? (
            <>
              <Button size="sm" onClick={gather}>Réunir l'équipe dans une room</Button>
              {result.url && <Button size="sm" variant="outline" onClick={() => { onClose(); navigate(result.url!.replace(/\/teamz$/, "/live")); }}>La voir au Live Space</Button>}
              <Button size="sm" variant="ghost" onClick={onClose}>Terminer</Button>
            </>
          ) : undefined}
        />
      )}
    </div>
  );
}

function ArchitectThinking({ brief, error, onClose }: { brief: string; error: string | null; onClose: () => void }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (error || step >= THINKING.length - 1) return;
    const t = setTimeout(() => setStep((s) => s + 1), 5200 + step * 900);
    return () => clearTimeout(t);
  }, [step, error]);
  return (
    <div className="space-y-5">
      <div>
        <div className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">Conception</div>
        <p className="mt-2 rounded-xl border border-border bg-secondary/30 px-3 py-2.5 text-[14px] italic">« {brief} »</p>
      </div>
      <ol className="space-y-2.5">
        {THINKING.map((s, i) => (
          <li key={s} className={cn("flex items-center gap-2.5 text-[13.5px] transition-opacity", i > step && "opacity-35")}>
            {i < step
              ? <CheckIcon className="h-4 w-4 text-emerald-500" weight="bold" />
              : i === step && !error ? <CircleNotchIcon className="h-4 w-4 animate-spin text-[hsl(var(--primary-soft))]" />
              : <span className="h-4 w-4 rounded-full border border-border" />}
            <span className={cn(i === step && !error && "tz-shimmer font-medium")}>{s}</span>
          </li>
        ))}
      </ol>
      {error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-[13px] text-red-700 dark:text-red-300">
          {error}
          <button type="button" onClick={onClose} className="ml-2 font-medium underline underline-offset-2">Fermer</button>
        </div>
      ) : null}
    </div>
  );
}

function Toggle({ on, onChange, label, hint, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; hint: string; disabled?: boolean }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3", disabled && "cursor-not-allowed opacity-50")}>
      <button
        type="button" role="switch" aria-checked={on && !disabled} disabled={disabled}
        onClick={() => onChange(!on)}
        className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full p-0 transition-colors", on && !disabled ? "bg-[hsl(var(--primary-soft))]" : "bg-secondary")}
      >
        <span className={cn("absolute left-0 top-0.5 block h-4 w-4 rounded-full bg-white shadow transition-transform", on && !disabled ? "translate-x-[18px]" : "translate-x-0.5")} />
      </button>
      <span>
        <span className="block text-[13.5px] font-medium">{label}</span>
        <span className="block text-[12px] text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
