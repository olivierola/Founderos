// AI Headquarters — the project-wide cockpit over the whole AI workforce.
// The page owns the framing (hero, live state, navigation); every statistic
// comes from the shared HQ cockpit, which a single service dashboard reuses on
// its own scope (see ServiceDashboardTabs → DashboardStatsTab).
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bot, FolderKanban, ChevronRight, Sparkles, Activity, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { MODULE_PROJECT_CONFIGS } from "@/lib/module-project-config";
import type { RangeKey } from "@/features/crm/overview/crmStats";
import { useHqData, useHqRefresh, HqCockpit } from "./hq/Cockpit";

export function AiHqDashboard() {
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const { projectId } = useCurrentContext();
  const [range, setRange] = useState<RangeKey>("30d");

  const { raw, isLoading, isFetching, hasAgents } = useHqData(projectId);
  const refresh = useHqRefresh();
  const base = `/app/${workspaceSlug}/${projectSlug}`;

  const running = raw.runs.filter((r) => r.status === "running" || r.status === "queued").length;
  const pending = raw.approvals.filter((a) => a.status === "pending").length;

  const { data: moduleProjects } = useQuery({
    queryKey: ["hq_module_projects", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("module_projects")
        .select("id, module_slug, project_type, name, status")
        .eq("project_id", projectId!).neq("status", "archived")
        .order("updated_at", { ascending: false }).limit(30);
      return (data ?? []) as Array<{ id: string; module_slug: string; name: string; status: string }>;
    },
  });

  const deptGroups = Object.entries(
    (moduleProjects ?? []).reduce<Record<string, { id: string; name: string }[]>>((acc, mp) => {
      (acc[mp.module_slug] ??= []).push(mp);
      return acc;
    }, {}),
  );

  return (
    <div className="space-y-5 px-6 py-6">
      <HqHero running={running} pending={pending} agents={raw.agents.filter((a) => !a.is_archived).length}
        onHire={() => navigate(`${base}/agent`)} />

      {!isLoading && !hasAgents ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center">
          <Bot className="mx-auto h-10 w-10 text-muted-foreground/30" />
          <p className="mt-3 text-sm font-medium">Aucun agent pour l'instant</p>
          <p className="mt-1 text-xs text-muted-foreground">Créez votre première équipe IA — les statistiques se remplissent dès le premier run.</p>
          <Button size="sm" className="mt-4" onClick={() => navigate(`${base}/agent`)}>Créer un agent</Button>
        </div>
      ) : (
        <HqCockpit
          raw={raw}
          isLoading={isLoading}
          isFetching={isFetching}
          range={range}
          onRangeChange={setRange}
          onRefresh={refresh}
          header={
            <div>
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <Activity className="h-4 w-4 text-muted-foreground" /> Analyse & gouvernance
              </h2>
              <p className="text-[11px] text-muted-foreground">
                Performance, coût, outils, connaissances et santé de la force de travail
              </p>
            </div>
          }
          onOpenAgent={(id) => navigate(`${base}/agent/internal/${id}/chat`)}
          onOpenService={(id) => navigate(`${base}/service/${id}`)}
          onOpenCollection={(id) => navigate(`${base}/agent/knowledge/${id}`)}
        />
      )}

      {deptGroups.length > 0 && (
        <div>
          <h2 className="mb-2.5 flex items-center gap-1.5 text-sm font-semibold">
            <FolderKanban className="h-4 w-4 text-muted-foreground" /> Projets par module
          </h2>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {deptGroups.map(([slug, projects]) => (
              <button key={slug} onClick={() => navigate(`${base}/${slug}`)}
                className="flex items-center gap-3 rounded-xl border border-border/70 bg-card p-3 text-left transition-colors hover:bg-secondary/30">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{MODULE_PROJECT_CONFIGS[slug]?.label ?? slug}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {projects.length} projet{projects.length > 1 ? "s" : ""} actif{projects.length > 1 ? "s" : ""}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HqHero({ running, pending, agents, onHire }: {
  running: number; pending: number; agents: number; onHire: () => void;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card px-5 py-4 shadow-sm">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full bg-primary opacity-[0.12] blur-3xl" />
      <div className="relative flex flex-wrap items-center gap-4">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Sparkles className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold tracking-tight">AI Headquarters</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Votre force de travail IA en un coup d'œil — agents, services, outils, connaissances et décisions.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <HeroChip icon={Bot} label={`${agents} agent${agents > 1 ? "s" : ""}`} />
          {running > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              {running} en cours
            </span>
          )}
          {pending > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              {pending} à valider
            </span>
          )}
          <Button size="sm" variant="outline" className="rounded-full" onClick={onHire}>
            <Bot className="mr-1.5 h-3.5 w-3.5" /> Recruter un agent
          </Button>
        </div>
      </div>
    </div>
  );
}

function HeroChip({ icon: Icon, label }: { icon: typeof Building2; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
      <Icon className="h-3.5 w-3.5" /> {label}
    </span>
  );
}
