import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon, ArrowLeftIcon, ArrowsClockwiseIcon, CaretRightIcon, ChartBarIcon,
  DotsThreeIcon, EyeIcon, FileTextIcon, GearSixIcon, ListChecksIcon, NotePencilIcon,
  GlobeIcon, LockSimpleIcon, PackageIcon, PlusIcon, SquaresFourIcon, StackIcon, StarIcon,
  TrayIcon, UsersThreeIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { FloatingTabBar } from "@/features/service-dashboards/FloatingTabBar";
import { IssuesBoard } from "./IssuesBoard";
import { CyclesPage } from "./CyclesPage";
import { ModulesPage } from "./ModulesPage";
import { ViewsPage } from "./ViewsPage";
import { PagesPage } from "./PagesPage";
import { IntakePage } from "./IntakePage";
import { CrewPage } from "./CrewPage";
import { DeliverablesPage } from "./DeliverablesPage";
import { AnalyticsPage } from "./AnalyticsPage";
import { ProjectSettings } from "./ProjectSettings";
import { NotificationsBell } from "./Notifications";
import { TrackerSearch } from "./TrackerSearch";
import { OverviewPage } from "./OverviewPage";
import { SpaceViewsPage } from "./SpaceViewsPage";
import { AgentsTab } from "@/features/service-dashboards/ServiceDashboardTabs";
import { DraftsPage } from "./DraftsPage";
import { TrackerHomePage } from "./HomePage";
import { InitiativesPage } from "./InitiativesPage";
import { InitiativeDetail } from "./InitiativeDetail";
import { WorkgraphPage } from "./WorkgraphPage";
import { DashboardsPage } from "./DashboardsPage";
import { SpaceAnalytics } from "./SpaceAnalytics";
import { TrackerCommandPalette } from "./CommandPalette";
import { WikiPage } from "./WikiPage";
import { EpicsPage } from "./EpicsPage";
import { ActiveCyclesPage } from "./ActiveCyclesPage";
import { ArchivesPage } from "./ArchivesPage";
import { LogoPicker, ProjectLogo } from "./LogoPicker";
import { SpaceArchivesPage, SpaceDraftsPage, SpaceStickiesPage } from "./SpacePages";
import { ProjectCard } from "./ProjectCard";
import { MyWorkPage } from "./MyWorkPage";
import { TextAreaField, TextField } from "./ui";
import { BoardIllustration } from "./illustrations";
import { EmptyState } from "./ui";
import {
  createProject, deleteProject, deriveIdentifier, fetchFavorites, fetchInitiatives,
  fetchProjects, fetchIssues, fetchStates, toggleFavorite, updateProject,
  type PjProject,
} from "./model";

/**
 * L'onglet « Projets » d'un dashboard de service : le suivi de travail, repris
 * de Plane.
 *
 * Deux niveaux, et pas trois : la liste des projets, puis UN projet avec ses
 * sections. Plane ajoute un niveau espace de travail au-dessus ; ici c'est le
 * dashboard de service qui joue ce rôle, et l'empiler à nouveau donnerait un
 * fil d'Ariane à quatre crans pour arriver à une liste de tâches.
 */

type Section =
  | "overview" | "issues" | "cycles" | "modules" | "epics" | "views" | "pages" | "intake"
  | "crew" | "deliverables"
  | "drafts" | "analytics" | "archives" | "settings";

/** Les destinations d'espace, par opposition à un identifiant de projet. */
const SPACE_VIEWS = [
  "my-work", "drafts", "stickies", "all-projects", "initiatives", "workgraph",
  "analytics", "boards", "views", "archives", "wiki", "active-cycles", "agents",
];

/**
 * Les écrans qui portent sur TOUT le service plutôt que sur un projet. Ils
 * partagent la même enveloppe : c'est ce qui fait qu'on passe de « mon travail »
 * au graphe sans avoir l'impression de changer d'outil.
 */
function SpaceView({
  view, dashboardId, workspaceId, onOpenProject, onOpenInitiative, onOpenView,
  onOpenAgent,
}: {
  view: string; dashboardId: string; workspaceId: string | null;
  onOpenProject: (id: string) => void;
  onOpenInitiative: (id: string) => void;
  /** Une vue s'ouvre DANS son projet : c'est là qu'elle a un board. */
  onOpenView: (projectId: string, viewId: string) => void;
  /** La fiche d'un agent vit dans le tableau de service, hors du module. */
  onOpenAgent: (id: string) => void;
}) {
  switch (view) {
    case "my-work":
      return <MyWorkPage dashboardId={dashboardId} onOpenProject={onOpenProject} />;
    case "initiatives":
      return (
        <InitiativesPage
          dashboardId={dashboardId} workspaceId={workspaceId}
          onOpenProject={onOpenProject} onOpenInitiative={onOpenInitiative}
        />
      );
    case "workgraph":
      return (
        <WorkgraphPage
          dashboardId={dashboardId} workspaceId={workspaceId} onOpenProject={onOpenProject}
          onOpenAgent={onOpenAgent}
          onOpenNotes={() => onOpenProject("stickies")}
        />
      );
    case "boards":
      return <DashboardsPage dashboardId={dashboardId} workspaceId={workspaceId} />;
    case "wiki":
      return <WikiPage dashboardId={dashboardId} workspaceId={workspaceId} />;
    case "active-cycles":
      return <ActiveCyclesPage dashboardId={dashboardId} onOpenProject={onOpenProject} />;
    case "drafts":
      return <SpaceDraftsPage dashboardId={dashboardId} />;
    case "archives":
      return <SpaceArchivesPage dashboardId={dashboardId} />;
    case "stickies":
      return <SpaceStickiesPage dashboardId={dashboardId} workspaceId={workspaceId} />;
    case "analytics":
      return <SpaceAnalytics dashboardId={dashboardId} />;
    case "agents":
      // Le roster EXISTANT, rendu ici tel quel — pas une copie.
      //
      // C'est le point : la force de travail et le suivi du travail sont deux
      // faces du même sujet, et les tenir dans deux endroits séparés obligeait
      // à changer d'écran pour passer de « qui fait ça » à « ce qui est à
      // faire ». Réimplémenter une seconde liste d'agents ici aurait donné deux
      // rosters à garder d'accord, dont un qui aurait divergé au premier ajout.
      return <AgentsTab dashboardId={dashboardId} />;
    case "views":
      return <SpaceViewsPage dashboardId={dashboardId} onOpenView={onOpenView} />;
    default:
      return null;
  }
}

export function TrackerTab({
  dashboardId, workspaceId, projectId, selectedProjectId, section, onSelectProject, onSelectSection,
}: {
  dashboardId: string;
  workspaceId: string | null;
  projectId: string | null;
  /** Le projet ouvert, porté par l'URL : c'est la sidebar qui le désigne, et un
   *  lien vers un projet doit rouvrir ce projet. */
  selectedProjectId?: string | null;
  /** La section du projet, portée par l'URL elle aussi : la sidebar la désigne,
   *  et un lien vers /issues doit s'ouvrir sur Work items. */
  section?: string | null;
  onSelectProject?: (id: string | null) => void;
  onSelectSection?: (section: string) => void;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  // État interne uniquement quand l'hôte ne pilote pas la sélection, pour que
  // le composant reste utilisable seul (tests, futur écran hors dashboard).
  const [localId, setLocalId] = useState<string | null>(null);
  const controlled = onSelectProject !== undefined;
  const openId = controlled ? selectedProjectId ?? null : localId;
  const setOpenId = (id: string | null) => {
    if (controlled) onSelectProject!(id); else setLocalId(id);
  };
  const [creating, setCreating] = useState(false);

  const { data: projects, isLoading } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    queryFn: () => fetchProjects(dashboardId),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_projects", dashboardId] });
  const current = (projects ?? []).find((p) => p.id === openId) ?? null;

  const { data: initiatives } = useQuery({
    queryKey: ["pj_initiatives", dashboardId],
    queryFn: () => fetchInitiatives(dashboardId),
  });

  const { data: favorites } = useQuery({
    queryKey: ["pj_favorites", workspaceId, user?.id],
    enabled: !!workspaceId && !!user,
    queryFn: () => fetchFavorites(workspaceId!, user!.id),
  });

  const favouriteProjects = useMemo(
    () => new Set((favorites ?? []).filter((f) => f.entity_type === "project").map((f) => f.entity_id)),
    [favorites],
  );

  const star = async (projectId: string, on: boolean) => {
    if (!workspaceId || !user) return;
    await toggleFavorite({
      workspaceId, userId: user.id, entityType: "project", entityId: projectId, on,
    });
    qc.invalidateQueries({ queryKey: ["pj_favorites"] });
  };
  const openInitiative = (initiatives ?? []).find((i) => i.id === openId) ?? null;

  // La palette est montée au-dessus de tout et reste disponible quelle que soit
  // la vue : un raccourci global qui ne marche que sur l'écran d'accueil n'est
  // pas un raccourci global.
  const palette = (
    <TrackerCommandPalette
      dashboardId={dashboardId}
      onOpenProject={setOpenId}
      onOpenInitiative={setOpenId}
      onNavigate={setOpenId}
      onNewIssue={() => setOpenId((projects ?? [])[0]?.id ?? null)}
    />
  );

  if (current) {
    return (
      <>
        {palette}
        <ProjectWorkspace
          project={current} dashboardId={dashboardId}
          section={section ?? null} onSelectSection={onSelectSection}
          onBack={() => setOpenId(null)} onChanged={refresh}
        />
      </>
    );
  }

  if (openInitiative) {
    return (
      <InitiativeDetail
        initiative={openInitiative} workspaceId={workspaceId}
        onBack={() => setOpenId(null)}
        onChanged={() => qc.invalidateQueries({ queryKey: ["pj_initiatives", dashboardId] })}
        onOpenProject={setOpenId}
      />
    );
  }

  // `openId` porte soit un identifiant, soit le slug d'une destination
  // d'espace. Les distinguer ici plutôt que dans l'URL évite un second segment
  // pour une différence que personne ne voit.
  if (openId && openId !== "all-projects" && SPACE_VIEWS.includes(openId)) {
    return (
      <>
        {palette}
        <SpaceView
          view={openId} dashboardId={dashboardId} workspaceId={workspaceId}
          onOpenProject={setOpenId} onOpenInitiative={setOpenId}
          // La fiche d'un agent est HORS du module de suivi : elle vit dans le
          // tableau de service, avec son chat et ses missions. On y navigue
          // plutôt que d'en rapatrier une copie ici.
          onOpenAgent={(id) => {
            const base = window.location.pathname.split("/projects")[0];
            window.location.assign(`${base}/agent/${id}`);
          }}
          onOpenView={(pid) => {
            // On ouvre le projet sur son onglet Vues plutôt que de tenter de
            // déplier la vue depuis ici : le board d'une vue a besoin des
            // états, des labels et des cycles DU PROJET, qui ne sont pas
            // chargés au niveau de l'espace.
            setOpenId(pid);
            onSelectSection?.("views");
          }}
        />
      </>
    );
  }

  // Sans destination, on arrive sur Home et non sur la liste des projets. La
  // liste est une DESTINATION (« Projets », sous Espace) ; l'accueil est un
  // point de reprise, et c'est lui qu'on veut en ouvrant l'onglet.
  if (!openId) {
    return (
      <>
        {palette}
        <TrackerHomePage
          dashboardId={dashboardId} workspaceId={workspaceId}
          onOpenProject={setOpenId}
          onOpenIssue={(projectIdArg) => setOpenId(projectIdArg)}
        />
      </>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {palette}
      <header className="flex h-header shrink-0 items-center justify-between px-4">
        <div>
          <h2 className="text-14 font-medium">Projets</h2>
          <p className="text-11 text-muted-foreground">
            Work items, cycles, modules — le suivi du travail de ce service.
          </p>
        </div>
        <Button
          size="sm" className="h-8"
          onClick={() => setCreating(true)}
          disabled={!workspaceId || !projectId}
        >
          <PlusIcon className="mr-1 h-4 w-4" /> Nouveau projet
        </Button>
      </header>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : !projects?.length ? (
        <EmptyState
          illustration={<BoardIllustration className="w-full" />}
          title="Aucun projet"
          hint="Un projet porte ses propres états, labels, cycles et modules. C'est l'unité de travail : tout le reste s'y rattache."
          action={
            <Button
              size="sm"
              onClick={() => setCreating(true)}
              disabled={!workspaceId || !projectId}
            >
              <PlusIcon className="mr-1 h-4 w-4" /> Créer le premier projet
            </Button>
          }
        />
      ) : (
        <div className="grid gap-2 px-4 pb-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard
              key={p.id} project={p}
              favourite={favouriteProjects.has(p.id)}
              onToggleFavourite={() => star(p.id, !favouriteProjects.has(p.id))}
              onOpen={() => setOpenId(p.id)} onChanged={refresh}
            />
          ))}
        </div>
      )}

      {creating && workspaceId && projectId && (
        <CreateProjectDialog
          workspaceId={workspaceId}
          projectId={projectId}
          dashboardId={dashboardId}
          existing={projects ?? []}
          onClose={() => setCreating(false)}
          onCreated={(p) => { refresh(); setOpenId(p.id); }}
        />
      )}
    </div>
  );
}

/** Un projet ouvert : la barre de sections, puis la section choisie. */
function ProjectWorkspace({
  project, dashboardId, section: urlSection, onSelectSection, onBack, onChanged,
}: {
  project: PjProject; dashboardId: string;
  section: string | null;
  onSelectSection?: (s: string) => void;
  onBack: () => void; onChanged: () => void;
}) {
  // L'URL commande quand elle porte une section ; l'état local ne sert qu'aux
  // sections absentes de la sidebar (Brouillons, Archives, Analytics, Réglages),
  // qu'on atteint depuis la page elle-même.
  const [localSection, setLocalSection] = useState<Section>("issues");
  const section = (urlSection as Section) ?? localSection;
  const setSection = (s: Section) => {
    setLocalSection(s);
    onSelectSection?.(s);
  };

  // Les sections désactivées disparaissent de la barre au lieu d'être grisées :
  // un onglet qu'on ne peut pas ouvrir n'a rien à faire dans une navigation.
  const sections = useMemo(() => {
    // L'ordre est celui de Plane : on arrive sur Overview, on travaille dans
    // Work items, et le reste vient ensuite.
    const all: { key: Section; label: string; icon: PhosphorIcon; on: boolean }[] = [
      { key: "overview", label: "Overview", icon: SquaresFourIcon, on: true },
      { key: "issues", label: "Work items", icon: ListChecksIcon, on: true },
      { key: "cycles", label: "Cycles", icon: ArrowsClockwiseIcon, on: project.cycle_view },
      { key: "modules", label: "Modules", icon: StackIcon, on: project.module_view },
      { key: "epics", label: "Epics", icon: StackIcon, on: true },
      { key: "views", label: "Vues", icon: EyeIcon, on: project.issue_views_view },
      { key: "pages", label: "Pages", icon: FileTextIcon, on: project.page_view },
      { key: "intake", label: "Intake", icon: TrayIcon, on: project.intake_view },
      // L'équipage puis les livrables, dans cet ordre : on met quelqu'un sur le
      // projet, puis on regarde ce qui en sort. Les deux sont toujours actifs —
      // un projet sans agent autorisé a d'autant plus besoin de la page qui
      // permet d'en autoriser un.
      { key: "crew", label: "Équipage", icon: UsersThreeIcon, on: true },
      { key: "deliverables", label: "Livrables", icon: PackageIcon, on: true },
      { key: "drafts", label: "Brouillons", icon: NotePencilIcon, on: true },
      { key: "archives", label: "Archives", icon: ArchiveIcon, on: true },
      { key: "analytics", label: "Analytics", icon: ChartBarIcon, on: true },
      { key: "settings", label: "Réglages", icon: GearSixIcon, on: true },
    ];
    return all.filter((s) => s.on).map(({ key, label, icon }) => ({ key, label, icon }));
  }, [project]);

  // Désactiver la section courante doit ramener quelque part, pas laisser un
  // écran vide.
  const active = sections.some((s) => s.key === section) ? section : "issues";

  return (
    <div className="relative flex h-full flex-col">
      {/* Le fil d'Ariane, comme dans Plane : le projet, puis la section, avec
          les sections secondaires (brouillons, archives, réglages) dans un menu
          plutôt qu'en barre — elles se visitent rarement et alourdiraient la
          navigation principale, déjà portée par la sidebar. */}
      <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
        <button type="button" onClick={onBack} className="rounded p-1 hover:bg-muted" title="Tous les projets">
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <ProjectLogo logo={project.logo_props} fallback={project.identifier} size={16} />
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-10 text-muted-foreground">
          {project.identifier}
        </span>
        <h2 className="truncate text-14 font-medium">{project.name}</h2>
        <CaretRightIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="text-14 text-muted-foreground">
          {sections.find((s) => s.key === active)?.label ?? "Work items"}
        </span>

        <div className="flex-1" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              <DotsThreeIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {sections.map((s) => (
              <DropdownMenuItem key={s.key} onClick={() => setSection(s.key as Section)}>
                <s.icon className="h-4 w-4" /> {s.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <TrackerSearch dashboardId={dashboardId} />
        <NotificationsBell />
      </header>

      <div className="relative min-h-0 flex-1">
        <div className="h-full">
          {active === "overview" && <OverviewPage project={project} />}
          {active === "issues" && (
            <div className="h-full">
              <IssuesBoard
                project={project}
                dashboardId={dashboardId}
                scope={{ pjProjectId: project.id }}
                scopeKey={`project-${project.id}`}
                onOpenAnalytics={() => setSection("analytics")}
              />
            </div>
          )}
          {active === "drafts" && <DraftsPage project={project} />}
          {active === "archives" && <ArchivesPage project={project} />}
          {active === "cycles" && <CyclesPage project={project} />}
          {active === "modules" && <ModulesPage project={project} />}
          {active === "epics" && <EpicsPage project={project} />}
          {active === "views" && <ViewsPage project={project} />}
          {active === "pages" && <PagesPage project={project} />}
          {active === "intake" && <IntakePage project={project} />}
          {active === "crew" && <CrewPage project={project} dashboardId={dashboardId} />}
          {active === "deliverables" && <DeliverablesPage project={project} />}
          {active === "analytics" && <AnalyticsPage project={project} />}
          {active === "settings" && <ProjectSettings project={project} onChanged={onChanged} />}
        </div>
      </div>
    </div>
  );
}

function CreateProjectDialog({
  workspaceId, projectId, dashboardId, existing, onClose, onCreated,
}: {
  workspaceId: string; projectId: string; dashboardId: string;
  existing: PjProject[];
  onClose: () => void;
  onCreated: (p: PjProject) => void;
}) {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [touchedIdentifier, setTouchedIdentifier] = useState(false);
  const [description, setDescription] = useState("");
  const [logo, setLogo] = useState<Record<string, unknown>>({});
  const [network, setNetwork] = useState<0 | 2>(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tant que personne n'a touché au code, il suit le nom. Dès qu'on l'édite, il
  // se fige : sinon on corrige un code et il se fait écraser à la frappe
  // suivante dans le titre.
  const effectiveIdentifier = touchedIdentifier ? identifier : deriveIdentifier(name);
  const taken = existing.some((p) => p.identifier === effectiveIdentifier);

  const submit = async () => {
    if (!name.trim() || busy) return;
    if (!/^[A-Z0-9]{1,12}$/.test(effectiveIdentifier)) {
      setError("Le code doit faire 1 à 12 caractères, en majuscules ou chiffres.");
      return;
    }
    if (taken) { setError("Ce code est déjà pris par un autre projet."); return; }
    setBusy(true);
    setError(null);
    try {
      const created = await createProject({
        workspaceId, projectId, dashboardId,
        name: name.trim(), identifier: effectiveIdentifier,
        description: description.trim() || undefined,
        logo_props: logo,
        network,
        createdBy: user?.id ?? null,
      });
      onCreated(created);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "La création a échoué.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      {/* Sans padding : la couverture doit toucher les bords, comme sur la
          carte du projet. Le corps reprend sa marge lui-même. */}
      <DialogContent className="max-w-lg overflow-hidden p-0">
        <DialogHeader className="sr-only"><DialogTitle>Nouveau projet</DialogTitle></DialogHeader>

        {/* ── Couverture + logo ────────────────────────────────────────── */}
        <div className="relative h-[100px]" style={{ background: coverFor(effectiveIdentifier) }}>
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
          <div className="absolute -bottom-5 left-5">
            <span className="block rounded-lg bg-card p-1 shadow-raised-200">
              <LogoPicker
                value={logo}
                onChange={setLogo}
                fallback={effectiveIdentifier}
                size={40}
                className="border-0"
              />
            </span>
          </div>
        </div>

        <div className="space-y-4 px-5 pb-5 pt-8">
          <div className="flex gap-2">
            <TextField
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder="Nom du projet"
              className="flex-1"
              maxLength={255}
            />
            {/* Le code tient à côté du nom et non en dessous : c'est UNE
                décision, prise au même moment, et l'empiler donnerait
                l'impression d'un second formulaire. */}
            <TextField
              value={effectiveIdentifier}
              onChange={(e) => {
                setTouchedIdentifier(true);
                // Même assainissement que Plane : majuscules, alphanumérique,
                // dix caractères. Corriger à la frappe plutôt que refuser après
                // coup évite un message d'erreur pour une faute qu'on peut
                // empêcher.
                setIdentifier(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10));
              }}
              placeholder="PROJ"
              className={cn('w-28 text-center font-mono uppercase', taken && 'border-red-500')}
            />
          </div>
          <p className="text-11 text-muted-foreground">
            Les work items porteront la référence{' '}
            <span className="font-mono">{effectiveIdentifier || 'PROJ'}-1</span>. Elle se colle
            dans les conversations et les commits, et ne change plus ensuite.
          </p>

          <TextAreaField
            value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="À quoi sert ce projet ?" className="min-h-[70px]"
          />

          <fieldset>
            <legend className="mb-2 text-12 text-secondary">Accès</legend>
            <div className="space-y-2">
              <NetworkOption
                active={network === 2} onSelect={() => setNetwork(2)}
                icon={<GlobeIcon className="h-4 w-4" />}
                label="Ouvert à l'espace"
                hint="Tout le monde peut le voir et le rejoindre."
              />
              <NetworkOption
                active={network === 0} onSelect={() => setNetwork(0)}
                icon={<LockSimpleIcon className="h-4 w-4" />}
                label="Privé"
                hint="Seuls les membres invités y ont accès."
              />
            </div>
          </fieldset>

          {error && <p className="text-12 text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button onClick={submit} disabled={!name.trim() || busy}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Créer le projet
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Un choix d'accès : icône, libellé et sa conséquence. « Privé » seul laisse
 *  deviner si cela veut dire invisible ou seulement non modifiable. */
function NetworkOption({
  active, onSelect, icon, label, hint,
}: {
  active: boolean; onSelect: () => void;
  icon: React.ReactNode; label: string; hint: string;
}) {
  return (
    <button type="button" onClick={onSelect} className="flex w-full items-start gap-2.5 text-left">
      <span className={cn(
        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
        active ? 'border-primary' : 'border-border',
      )}>
        {active && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-13 font-medium">{label}</span>
        <span className="block text-11 text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

/** La couverture par défaut, dérivée de l'identifiant : stable, donc
 *  mémorisable. Même règle que la carte du projet. */
function coverFor(identifier: string): string {
  let hash = 0;
  for (const ch of identifier || "PROJ") hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${hash} 45% 38%), hsl(${(hash + 40) % 360} 45% 26%))`;
}
