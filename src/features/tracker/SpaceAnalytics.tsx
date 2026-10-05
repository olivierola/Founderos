import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CaretDownIcon, ChartBarIcon, SuitcaseSimpleIcon } from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ProjectLogo } from "./LogoPicker";
import { DashboardIllustration } from "./illustrations";
import { EmptyState, PageHeader, Tabs } from "./ui";
import { RadarChart, type RadarAxis } from "./analytics/RadarChart";
import {
  IssuesTab, MembersTab, ProjectsTab,
} from "./analytics/tabs";
import { AgentsAnalyticsTab } from "./analytics/AgentsTab";
import {
  HEALTH, fetchAnalytics, fetchAnalyticsMembers,
  fetchIssues, fetchMembers,
  fetchPages, fetchProgress, fetchProjects, fetchViews, type PjProject,
} from "./model";

/**
 * Les analytics du service.
 *
 * Sept onglets, et le premier — Overview — répond à une question que les six
 * autres ne posent pas : le service utilise-t-il l'outil de façon ÉQUILIBRÉE ?
 * D'où le radar à côté du tableau. Le tableau donne les nombres, le radar donne
 * la silhouette : un service qui empile des work items sans jamais ouvrir de
 * cycle a une forme reconnaissable au premier coup d'œil, qu'aucune colonne de
 * chiffres ne rend aussi vite.
 */

type Tab = "overview" | "projects" | "users" | "agents" | "issues";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "projects", label: "Projets" },
  { key: "users", label: "Membres" },
  // Les agents JUSTE APRÈS les membres : ce sont les deux moitiés de « qui
  // travaille ici », et les éloigner l'une de l'autre ferait chercher la
  // seconde ailleurs. C'est l'ancien onglet Dashboard de l'Assistant, rebâti
  // sur les primitives d'Analytics.
  { key: "agents", label: "Agents" },
  { key: "issues", label: "Work items" },
];

export function SpaceAnalytics({ dashboardId }: { dashboardId: string }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [scope, setScope] = useState<string | null>(null);

  const { data: projects } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    queryFn: () => fetchProjects(dashboardId),
  });

  // Les quatre agrégats viennent des RPC de 0227 : une requête chacun, là où le
  // client en faisait six PAR PROJET.
  const { data: analytics } = useQuery({
    queryKey: ["pj_analytics", dashboardId],
    queryFn: () => fetchAnalytics(dashboardId),
  });
  const { data: memberRows } = useQuery({
    queryKey: ["pj_analytics_members", dashboardId],
    queryFn: () => fetchAnalyticsMembers(dashboardId),
  });

  const all = projects ?? [];
  const scoped = scope ? all.filter((p) => p.id === scope) : all;
  const current = all.find((p) => p.id === scope) ?? null;

  const { data: members } = useQuery({
    queryKey: ["pj_members", all[0]?.workspace_id],
    enabled: all.length > 0,
    queryFn: () => fetchMembers(all[0].workspace_id),
  });

  const scopedRows = scope
    ? (analytics ?? []).filter((r) => r.pj_project_id === scope)
    : analytics ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader icon={<ChartBarIcon className="h-4 w-4" />} title="Analytics" />

      <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
        {/* Onglets segmentés : ce sont sept DÉCOUPES du même jeu de données,
            interchangeables — contrairement aux onglets de cycle, qui marquent
            une chronologie et sont donc soulignés. */}
        <Tabs value={tab} onChange={setTab} options={TABS} />

        <div className="flex-1" />

        <Popover>
          <PopoverTrigger asChild>
            <button className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-12 hover:bg-muted">
              <SuitcaseSimpleIcon className="h-4 w-4 text-muted-foreground" />
              {current?.name ?? "Tous les projets"}
              <CaretDownIcon className="h-3 w-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-1" align="end">
            <ScopeOption active={!scope} onSelect={() => setScope(null)} label="Tous les projets" />
            {all.map((p) => (
              <ScopeOption
                key={p.id} active={scope === p.id} onSelect={() => setScope(p.id)}
                label={p.name} logo={p.logo_props} identifier={p.identifier}
              />
            ))}
          </PopoverContent>
        </Popover>
      </div>

      {/* Pas de conteneur centré ni de marges latérales : les tables ont
          jusqu'à dix colonnes, et les brider à une largeur de lecture les
          rendrait horizontalement défilantes sur un écran qui a la place. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
        {!all.length ? (
          <EmptyState
            illustration={<DashboardIllustration className="w-full" />}
            title="Aucun projet à analyser"
            hint="Les statistiques se construisent à partir des projets du service : répartitions, tendances, charge par personne. Il en faut au moins un."
          />
        ) : tab === "overview" ? (
          <OverviewTab dashboardId={dashboardId} projects={scoped} allProjects={all} />
        ) : tab === "projects" ? (
          <ProjectsTab rows={scopedRows} />
        ) : tab === "users" ? (
          <MembersTab rows={memberRows ?? []} members={members ?? []} />
        ) : tab === "agents" ? (
          <AgentsAnalyticsTab
            dashboardId={dashboardId} projects={all} scopeProjectId={scope}
          />
        ) : (
          <IssuesTab rows={scopedRows} />
        )}
      </div>
    </div>
  );
}

function ScopeOption({
  active, onSelect, label, logo, identifier,
}: {
  active: boolean; onSelect: () => void; label: string;
  logo?: Record<string, unknown> | null; identifier?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-12",
        active ? "bg-muted font-medium" : "hover:bg-muted",
      )}
    >
      {logo !== undefined
        ? <ProjectLogo logo={logo} fallback={identifier} size={14} />
        : <span className="w-3.5" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({
  dashboardId, projects, allProjects,
}: { dashboardId: string; projects: PjProject[]; allProjects: PjProject[] }) {
  const ids = projects.map((p) => p.id).join(",");

  const { data: totals } = useQuery({
    queryKey: ["pj_analytics_totals", dashboardId, ids],
    enabled: projects.length > 0,
    queryFn: async () => {
      // Une passe par projet, en parallèle. Les agréger en SQL demanderait une
      // vue de plus pour une page consultée occasionnellement ; le coût réel
      // est celui d'un chargement, pas d'un board qu'on garde ouvert.
      const per = await Promise.all(projects.map(async (p) => {
        const [issues, pages, views] = await Promise.all([
          fetchIssues({ pjProjectId: p.id }),
          fetchPages(p.id),
          fetchViews(p.id),
        ]);
        return {
          issues: issues.length,
          pages: pages.length, views: views.length,
        };
      }));

      return per.reduce((acc, x) => ({
        issues: acc.issues + x.issues,
        pages: acc.pages + x.pages,
        views: acc.views + x.views,
      }), { issues: 0, pages: 0, views: 0 });
    },
  });

  const { data: members } = useQuery({
    queryKey: ["pj_members", projects[0]?.workspace_id],
    enabled: projects.length > 0,
    queryFn: () => fetchMembers(projects[0].workspace_id),
  });

  const t = totals ?? { issues: 0, pages: 0, views: 0 };
  const memberCount = members?.length ?? 0;

  const rows: { label: string; value: number }[] = [
    { label: "Work items", value: t.issues },
    { label: "Membres", value: memberCount },
    { label: "Pages", value: t.pages },
    { label: "Vues", value: t.views },
  ];

  const ceiling = Math.max(1, ...rows.map((x) => x.value));
  const axes: RadarAxis[] = rows.map((r) => ({ label: r.label, value: r.value, max: ceiling }));

  return (
    // Pas de `max-w` : l'onglet Overview a trois colonnes, et les brider
    // laissait une bande vide à droite sur un écran large.
    <div className="space-y-8">
      <section>
        <h2 className="pb-3 text-18 font-semibold tracking-tight">Vue d&apos;ensemble</h2>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Membres" value={memberCount} />
          <Stat label="Projets" value={allProjects.length} />
          <Stat label="Work items" value={t.issues} />
          <Stat label="Pages" value={t.pages} />
          <Stat label="Vues" value={t.views} />
        </div>
      </section>

      <section className="grid gap-8 lg:grid-cols-[1fr_1fr_280px]">
        <div>
          <h3 className="pb-1 text-14 font-medium">Répartition</h3>
          <p className="pb-3 text-11 text-muted-foreground">
            La forme dit si l&apos;outil est utilisé de façon équilibrée.
          </p>
          <RadarChart axes={axes} />
        </div>

        <div>
          <h3 className="pb-1 text-14 font-medium">Synthèse</h3>
          <p className="pb-3 text-11 text-muted-foreground">
            {projects.length === allProjects.length
              ? "Tous les projets"
              : projects.map((p) => p.name).join(", ")}
          </p>
          <table className="w-full text-13">
            <thead>
              <tr className="border-b border-border text-11 text-muted-foreground">
                <th className="pb-2 text-left font-medium">Dimension</th>
                <th className="pb-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-b border-border/40 last:border-0">
                  <td className="py-2.5">{r.label}</td>
                  <td className="py-2.5 text-right tabular-nums">{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="pb-3 text-14 font-medium">Projets actifs</h3>
          <ul className="space-y-1">
            {allProjects.map((p) => <ActiveProjectRow key={p.id} project={p} />)}
          </ul>
        </div>
      </section>
    </div>
  );
}

/**
 * Une tuile de chiffre. Le libellé au-dessus et petit, la valeur en dessous et
 * grande : c'est la valeur qu'on balaie, l'étiquette ne se lit que sur celle
 * qui accroche l'œil.
 */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-12 text-muted-foreground">{label}</p>
      <p className="pt-1 text-24 font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function ActiveProjectRow({ project }: { project: PjProject }) {
  const { data: progress } = useQuery({
    queryKey: ["pj_progress", project.id],
    queryFn: () => fetchProgress(project.id),
  });

  const total = progress?.total ?? 0;
  const percent = total ? Math.round(((progress?.completed ?? 0) / total) * 100) : 0;
  const health = HEALTH.find((h) => h.key === project.health);

  return (
    <li className="flex items-center gap-2.5 rounded-md px-1.5 py-2 hover:bg-muted/50">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted text-13">
        <ProjectLogo logo={project.logo_props} fallback={project.identifier} size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate text-13 font-medium">{project.name}</span>
      {health && (
        <span
          className="inline-flex h-5 shrink-0 items-center rounded-full px-2 text-10 font-medium leading-none"
          style={{ background: `${health.color}1f`, color: health.color }}
        >
          {health.label}
        </span>
      )}
      <span className="shrink-0 text-11 tabular-nums text-muted-foreground">{percent}%</span>
    </li>
  );
}

// ── Découpes par dimension ──────────────────────────────────────────────────

/**
 * Les six autres onglets partagent une même forme : un projet par ligne, avec
 * la mesure de la dimension choisie. La comparabilité ligne à ligne est ce
 * qu'on vient chercher — un agrégat unique noierait le projet en difficulté
 * dans la moyenne des autres.
 */
function BreakdownTab({
  projects, dimension,
}: { projects: PjProject[]; dimension: Exclude<Tab, "overview"> }) {
  const label = TABS.find((t) => t.key === dimension)!.label;

  return (
    <div className="mx-auto max-w-4xl">
      <h2 className="pb-1 text-20 font-semibold">{label}</h2>
      <p className="pb-4 text-12 text-muted-foreground">
        Un projet par ligne, comparables entre elles.
      </p>

      <div className="rounded-lg border border-border/70">
        <div className="grid grid-cols-[1fr_100px_100px_100px] gap-2 border-b border-border px-3 py-2 text-11 font-medium text-muted-foreground">
          <span>Projet</span>
          <span className="text-right">Total</span>
          <span className="text-right">Terminés</span>
          <span className="text-right">En retard</span>
        </div>
        {projects.map((p) => <BreakdownRow key={p.id} project={p} dimension={dimension} />)}
      </div>
    </div>
  );
}

function BreakdownRow({
  project, dimension,
}: { project: PjProject; dimension: Exclude<Tab, "overview"> }) {
  const { data: progress } = useQuery({
    queryKey: ["pj_progress", project.id],
    queryFn: () => fetchProgress(project.id),
  });

  const total = progress?.total ?? 0;

  return (
    <div className="grid grid-cols-[1fr_100px_100px_100px] items-center gap-2 border-b border-border/40 px-3 py-2 text-13 last:border-0">
      <span className="flex min-w-0 items-center gap-2">
        <span className="font-mono text-10 text-muted-foreground">{project.identifier}</span>
        <span className="truncate">{project.name}</span>
      </span>
      <span className="text-right tabular-nums">{total}</span>
      <span className="text-right tabular-nums">{progress?.completed ?? 0}</span>
      <span className={cn(
        "text-right tabular-nums",
        (progress?.overdue ?? 0) > 0 && "text-amber-600",
      )}>
        {progress?.overdue ?? 0}
      </span>
    </div>
  );
}
