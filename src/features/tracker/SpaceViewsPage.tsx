import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowsDownUpIcon, CaretDownIcon, CheckIcon, EyeIcon, GlobeIcon, LockSimpleIcon,
  MagnifyingGlassIcon, StackIcon,
} from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectLogo } from "./LogoPicker";
import { SearchIllustration, ViewIllustration } from "./illustrations";
import { EmptyState, PageHeader, TextField } from "./ui";
import { countActiveFilters, EMPTY_FILTERS, type Filters } from "./filters";
import { fetchProjects, fetchSpaceViews, type PjProject, type PjView } from "./model";

/**
 * Les vues du SERVICE : celles de tous les projets, réunies.
 *
 * Elle répond à une question que la page Vues d'un projet ne peut pas poser :
 * « où était donc cette vue ? ». Quand quinze projets portent chacun trois ou
 * quatre vues, on se souvient du nom — « Triage urgences » — mais rarement du
 * projet qui la porte, et il faut alors ouvrir les projets un par un.
 *
 * Elle ne permet PAS d'en créer. Une vue est un jeu de filtres sur les états,
 * les labels et les cycles d'un projet précis ; la créer hors de tout projet
 * demanderait de choisir lequel d'abord, ce qui est exactement le geste qu'on
 * ferait en allant dans le projet. Elle mène donc à la vue, et c'est tout.
 */

const SORTS = [
  { key: "recent", label: "Les plus récentes" },
  { key: "name", label: "Nom (A → Z)" },
  { key: "project", label: "Par projet" },
] as const;

type Sort = (typeof SORTS)[number]["key"];

export function SpaceViewsPage({
  dashboardId, onOpenView,
}: {
  dashboardId: string;
  /** Ouvre la vue DANS son projet : c'est le seul endroit où elle a un board. */
  onOpenView: (projectId: string, viewId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");

  const { data: views, isLoading } = useQuery({
    queryKey: ["pj_space_views", dashboardId],
    queryFn: () => fetchSpaceViews(dashboardId),
  });
  const { data: projects } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    queryFn: () => fetchProjects(dashboardId),
  });

  const byProject = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p])),
    [projects],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (views ?? []).filter((v) => {
      if (!q) return true;
      const project = v.pj_project_id ? byProject.get(v.pj_project_id) : null;
      // On cherche aussi dans le NOM DU PROJET : « les vues de la refonte » est
      // une recherche légitime, et la seule chose qu'on ait en tête quand on ne
      // se souvient pas du nom de la vue.
      return v.name.toLowerCase().includes(q)
        || (project?.name ?? "").toLowerCase().includes(q);
    });

    return [...list].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "project") {
        const pa = byProject.get(a.pj_project_id ?? "")?.name ?? "";
        const pb = byProject.get(b.pj_project_id ?? "")?.name ?? "";
        return pa.localeCompare(pb) || a.name.localeCompare(b.name);
      }
      return a.sort_order - b.sort_order;
    });
  }, [views, query, sort, byProject]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={<EyeIcon className="h-4 w-4" />}
        title="Vues"
        subtitle="Les vues enregistrées de tous les projets du service."
        actions={
          <>
            <div className="relative w-52">
              <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-tertiary" />
              <TextField
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Vue ou projet…"
                className="pl-8"
              />
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  title="Trier"
                  className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-12 text-secondary hover:bg-muted hover:text-foreground"
                >
                  <ArrowsDownUpIcon className="h-3.5 w-3.5" />
                  <span className="hidden sm:block">
                    {SORTS.find((o) => o.key === sort)?.label}
                  </span>
                  <CaretDownIcon className="h-3 w-3 text-tertiary" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {SORTS.map((o) => (
                  <DropdownMenuItem key={o.key} onClick={() => setSort(o.key)}>
                    {o.key === sort ? <CheckIcon className="h-3.5 w-3.5" /> : <span className="w-3.5" />}
                    {o.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? null : !shown.length ? (
          query ? (
            <EmptyState
              illustration={<SearchIllustration className="w-full" />}
              title="Aucune vue ne correspond"
              hint={`Rien ne s'appelle « ${query} » dans ce service, ni parmi les vues ni parmi les projets.`}
            />
          ) : (
            <EmptyState
              illustration={<ViewIllustration className="w-full" />}
              title="Aucune vue enregistrée"
              hint="Une vue garde un jeu de filtres sous la main et rejoue ses critères à chaque ouverture. Elle se crée depuis un projet, dans son onglet Vues."
            />
          )
        ) : (
          <ul>
            {shown.map((v) => (
              <SpaceViewRow
                key={v.id}
                view={v}
                project={v.pj_project_id ? byProject.get(v.pj_project_id) : undefined}
                onOpen={() => {
                  if (v.pj_project_id) onOpenView(v.pj_project_id, v.id);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SpaceViewRow({
  view, project, onOpen,
}: { view: PjView; project: PjProject | undefined; onOpen: () => void }) {
  const active = countActiveFilters({ ...EMPTY_FILTERS, ...(view.filters as Partial<Filters>) });

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 border-b border-border/40 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
          {view.logo_props && Object.keys(view.logo_props).length
            ? <ProjectLogo logo={view.logo_props} size={15} />
            : <StackIcon className="h-4 w-4 text-tertiary" />}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-13 font-medium">{view.name}</span>
          {view.description && (
            <span className="block truncate text-11 text-tertiary">{view.description}</span>
          )}
        </span>

        {/* Le projet d'origine, à droite du nom : c'est l'information qui
            manque sur la page d'un projet et qui justifie cet écran. */}
        {project ? (
          <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-11 text-secondary">
            <ProjectLogo logo={project.logo_props} fallback={project.identifier} size={12} />
            {project.name}
          </span>
        ) : (
          <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-11 text-tertiary">
            Tout le service
          </span>
        )}

        <span className="shrink-0 text-11 text-tertiary">
          {active === 0 ? "Aucun filtre" : `${active} critère${active > 1 ? "s" : ""}`}
        </span>

        <span
          className="shrink-0 text-tertiary"
          title={view.access === 1 ? "Partagée avec l'espace" : "Privée"}
        >
          {view.access === 1
            ? <GlobeIcon className="h-4 w-4" />
            : <LockSimpleIcon className="h-4 w-4" />}
        </span>
      </button>
    </li>
  );
}
