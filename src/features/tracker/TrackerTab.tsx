import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon, ArrowLeftIcon, ArrowsClockwiseIcon, CaretRightIcon, ChartBarIcon,
  DotsThreeIcon, EyeIcon, FileTextIcon, GearSixIcon, ListChecksIcon, NotePencilIcon,
  GlobeIcon, LockSimpleIcon, PackageIcon, PlusIcon, SquaresFourIcon, StackIcon, StarIcon,
  TrayIcon, UsersThreeIcon, FlagBannerIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { DeliverablesField, MissionKickoff, TeamsPicker } from "./MissionKickoff";
import { BriefInput, SmartTextarea } from "./SmartTextarea";
import { missionAction, type MissionDeliverable } from "./model";
import { useTeams } from "@/features/service-dashboards/live/teams";
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
import { ViewsPage } from "./ViewsPage";
import { PagesPage } from "./PagesPage";
import { CrewPage } from "./CrewPage";
import { DeliverablesPage } from "./DeliverablesPage";
import { AssetsPage } from "./AssetsPage";
import { AnalyticsPage } from "./AnalyticsPage";
import { ProjectSettings } from "./ProjectSettings";
import { NotificationsBell } from "./Notifications";
import { TrackerSearch } from "./TrackerSearch";
import { OverviewPage } from "./OverviewPage";
import { SpaceViewsPage } from "./SpaceViewsPage";
import { AgentsTab } from "@/features/service-dashboards/ServiceDashboardTabs";
import { CollaboratorInbox } from "@/features/service-dashboards/CollaboratorInbox";
import { DraftsPage } from "./DraftsPage";
import { TrackerHomePage } from "./HomePage";
import { WorkgraphPage } from "./WorkgraphPage";
import { DashboardsPage } from "./DashboardsPage";
import { SpaceAnalytics } from "./SpaceAnalytics";
import { TrackerCommandPalette } from "./CommandPalette";
import { WikiPage } from "./WikiPage";
import { ArchivesPage } from "./ArchivesPage";
import { LogoPicker, ProjectLogo } from "./LogoPicker";
import { SpaceArchivesPage, SpaceDraftsPage, SpaceStickiesPage } from "./SpacePages";
import { ProjectCard } from "./ProjectCard";
import { MyWorkPage } from "./MyWorkPage";
import { TextAreaField, TextField } from "./ui";
import { BoardIllustration } from "./illustrations";
import { EmptyState, Tabs } from "./ui";
import {
  createProject, deleteProject, deriveIdentifier, fetchFavorites,
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
  | "kickoff" | "overview" | "issues" | "cycles" | "modules" | "epics" | "views" | "pages" | "intake"
  | "crew" | "deliverables" | "assets"
  | "drafts" | "analytics" | "archives" | "settings";

/** Les destinations d'espace, par opposition à un identifiant de projet. */
const SPACE_VIEWS = [
  "my-work", "drafts", "stickies", "all-projects", "workgraph",
  "analytics", "boards", "views", "archives", "wiki", "agents", "inbox",
];

/** Analytics et les tableaux de bord : une seule destination, deux onglets.
 *  `/boards` reste une adresse valide et ouvre le second. */
function AnalyticsHub({ initial, dashboardId, workspaceId }: {
  initial: "analytics" | "boards"; dashboardId: string; workspaceId: string | null;
}) {
  const [tab, setTab] = useState<"analytics" | "boards">(initial);
  const switcher = (
    <Tabs value={tab} onChange={setTab} options={[{ key: "analytics", label: "Analyses" }, { key: "boards", label: "Tableaux du suivi" }]} />
  );
  return tab === "analytics"
    ? <SpaceAnalytics dashboardId={dashboardId} switcher={switcher} />
    : <DashboardsPage dashboardId={dashboardId} workspaceId={workspaceId} switcher={switcher} />;
}

/**
 * Les écrans qui portent sur TOUT le service plutôt que sur un projet. Ils
 * partagent la même enveloppe : c'est ce qui fait qu'on passe de « mon travail »
 * au graphe sans avoir l'impression de changer d'outil.
 */
function SpaceView({
  view, dashboardId, workspaceId, onOpenProject, onOpenView,
  onOpenAgent,
}: {
  view: string; dashboardId: string; workspaceId: string | null;
  onOpenProject: (id: string) => void;
  /** Une vue s'ouvre DANS son projet : c'est là qu'elle a un board. */
  onOpenView: (projectId: string, viewId: string) => void;
  /** La fiche d'un agent vit dans le tableau de service, hors du module. */
  onOpenAgent: (id: string) => void;
}) {
  switch (view) {
    case "my-work":
      return <MyWorkPage dashboardId={dashboardId} onOpenProject={onOpenProject} />;
    case "workgraph":
      return (
        <WorkgraphPage
          dashboardId={dashboardId} workspaceId={workspaceId} onOpenProject={onOpenProject}
          onOpenAgent={onOpenAgent}
          onOpenNotes={() => onOpenProject("stickies")}
        />
      );
    case "boards":
      return <AnalyticsHub key="boards" initial="boards" dashboardId={dashboardId} workspaceId={workspaceId} />;
    case "wiki":
      return <WikiPage dashboardId={dashboardId} workspaceId={workspaceId} />;
    case "drafts":
      return <SpaceDraftsPage dashboardId={dashboardId} />;
    case "archives":
      return <SpaceArchivesPage dashboardId={dashboardId} />;
    case "stickies":
      return <SpaceStickiesPage dashboardId={dashboardId} workspaceId={workspaceId} />;
    case "analytics":
      return <AnalyticsHub key="analytics" initial="analytics" dashboardId={dashboardId} workspaceId={workspaceId} />;
    case "agents":
      // Le roster EXISTANT, rendu ici tel quel — pas une copie.
      //
      // C'est le point : la force de travail et le suivi du travail sont deux
      // faces du même sujet, et les tenir dans deux endroits séparés obligeait
      // à changer d'écran pour passer de « qui fait ça » à « ce qui est à
      // faire ». Réimplémenter une seconde liste d'agents ici aurait donné deux
      // rosters à garder d'accord, dont un qui aurait divergé au premier ajout.
      // Le roster s'étire avec son contenu (`min-h-full`) et compte sur un
      // conteneur pour défiler. Les autres destinations d'espace portent le
      // leur ; celle-ci est empruntée au tableau de service, où c'était
      // `<main>` qui défilait — ici `<main>` est en `overflow-hidden` (le
      // module de suivi borne sa hauteur), donc la page ne bougeait plus d'un
      // pixel dès qu'il y avait plus d'agents que d'écran.
      return (
        <div className="h-full overflow-y-auto">
          <AgentsTab dashboardId={dashboardId} />
        </div>
      );
    case "views":
      return <SpaceViewsPage dashboardId={dashboardId} onOpenView={onOpenView} />;
    case "inbox":
      // Ce que les collaborateurs attendent d'un humain, tous confondus (0265).
      return <CollaboratorInbox dashboardId={dashboardId} />;
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

  // La palette est montée au-dessus de tout et reste disponible quelle que soit
  // la vue : un raccourci global qui ne marche que sur l'écran d'accueil n'est
  // pas un raccourci global.
  const palette = (
    <TrackerCommandPalette
      dashboardId={dashboardId}
      onOpenProject={setOpenId}
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

  // `openId` porte soit un identifiant, soit le slug d'une destination
  // d'espace. Les distinguer ici plutôt que dans l'URL évite un second segment
  // pour une différence que personne ne voit.
  if (openId && openId !== "all-projects" && SPACE_VIEWS.includes(openId)) {
    return (
      <>
        {palette}
        <SpaceView
          view={openId} dashboardId={dashboardId} workspaceId={workspaceId}
          onOpenProject={setOpenId}
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
            Work items, cycles, modules, le suivi du travail de ce service.
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
  // Une mission confiée à l'équipe s'ouvre sur son cadrage : c'est là que ça
  // se passe tant que le plan n'est pas en route.
  const [localSection, setLocalSection] = useState<Section>(
    project.brief || (project.planning_status && project.planning_status !== "none") ? "kickoff" : "issues",
  );
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
      // Le cadrage d'abord : la mission telle que l'équipe l'a comprise,
      // découpée et répartie (0295).
      { key: "kickoff", label: "Cadrage", icon: FlagBannerIcon, on: true },
      { key: "overview", label: "Overview", icon: SquaresFourIcon, on: true },
      { key: "issues", label: "Work items", icon: ListChecksIcon, on: true },
      { key: "views", label: "Vues", icon: EyeIcon, on: project.issue_views_view },
      { key: "pages", label: "Pages", icon: FileTextIcon, on: project.page_view },
      // L'équipage puis les livrables, dans cet ordre : on met quelqu'un sur le
      // projet, puis on regarde ce qui en sort. Les deux sont toujours actifs —
      // un projet sans agent autorisé a d'autant plus besoin de la page qui
      // permet d'en autoriser un.
      { key: "crew", label: "Équipage", icon: UsersThreeIcon, on: true },
      { key: "deliverables", label: "Livrables", icon: PackageIcon, on: true },
      // Les ressources sont la MATIÈRE du projet — le dépôt, la maquette, les
      // données. Elles se rangent à côté de l'équipage et des livrables : qui
      // travaille, sur quoi, et ce qui en sort.
      { key: "assets", label: "Ressources", icon: StackIcon, on: true },
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
          {active === "kickoff" && <MissionKickoff project={project} dashboardId={dashboardId} onChanged={onChanged} />}
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
          {active === "views" && <ViewsPage project={project} />}
          {active === "pages" && <PagesPage project={project} />}
          {active === "crew" && <CrewPage project={project} dashboardId={dashboardId} />}
          {active === "deliverables" && <DeliverablesPage project={project} />}
          {active === "assets" && <AssetsPage project={project} />}
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
  // Ce que l'humain confie à l'équipe (0295) : avec un brief, la mission part
  // en cadrage dès sa création.
  const { teams } = useTeams(dashboardId);
  const [brief, setBrief] = useState("");
  const [deliv, setDeliv] = useState<MissionDeliverable[]>([{ title: "" }]);
  const [picked, setPicked] = useState<string[]>([]);
  const [autostart, setAutostart] = useState(false);

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
        brief: brief.trim() || undefined,
        deliverables: deliv.filter((d) => d.title.trim()),
        planningTeams: picked,
        planningAutostart: autostart,
      });
      if (brief.trim()) {
        try {
          await missionAction(created.id, "mission_kickoff");
        } catch {
          // La mission existe : le cadrage se relancera depuis son onglet.
        }
      }
      onCreated(created);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "La création a échoué.");
    } finally {
      setBusy(false);
    }
  };

  // Deux temps, pour ne pas tout demander d'un coup : ce que l'on veut, puis
  // ce qui doit en sortir et qui s'en charge.
  const [step, setStep] = useState<1 | 2>(1);
  const hasBrief = !!brief.trim();

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      {/* Un clic à côté ne ferme pas : un brief à moitié écrit ne doit pas se
          perdre sur un geste distrait. On ferme avec Annuler ou la croix. */}
      <DialogContent
        className="flex max-h-[90vh] max-w-xl flex-col gap-0 overflow-hidden p-0"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="sr-only"><DialogTitle>Nouvelle mission</DialogTitle></DialogHeader>

        {/* ── En-tête : l'icône, le titre, la référence ── */}
        <div className="flex items-center gap-3 border-b border-border px-5 py-4" style={{ backgroundImage: `linear-gradient(90deg, color-mix(in srgb, ${coverFor(effectiveIdentifier).match(/hsl\([^)]+\)/)?.[0] ?? "transparent"} 18%, transparent), transparent 70%)` }}>
          <LogoPicker value={logo} onChange={setLogo} fallback={effectiveIdentifier} size={32} className="shrink-0" />
          <input
            autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { if (brief.trim()) setStep(2); else void submit(); } }}
            placeholder="Titre de la mission" maxLength={255}
            className="min-w-0 flex-1 bg-transparent text-16 font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground/70"
          />
          {/* La référence des work items (PROJ-1) : modifiable, mais discrète. */}
          <input
            value={effectiveIdentifier} aria-label="Référence des work items"
            title={`Les work items porteront la référence ${effectiveIdentifier || "PROJ"}-1. Elle ne change plus ensuite.`}
            onChange={(e) => {
              setTouchedIdentifier(true);
              setIdentifier(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10));
            }}
            placeholder="PROJ"
            className={cn("w-20 shrink-0 rounded-md bg-muted/60 px-2 py-1 text-center font-mono text-11 uppercase text-muted-foreground outline-none focus:ring-1 focus:ring-primary/50",
              taken && "text-red-600 ring-1 ring-red-500")}
          />
        </div>

        {/* ── Le corps : une étape à la fois ── */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {step === 1 ? (
            <>
              <SmartTextarea
                label="En bref" value={description} onChange={setDescription}
                placeholder="En une ou deux phrases : de quoi s'agit-il ?" minRows={2} maxRows={4}
              />
              <div>
                <BriefInput
                  value={brief} onChange={setBrief}
                  onTitle={(t) => { if (!name.trim()) setName(t.slice(0, 255)); }}
                />
                <p className="mt-1.5 text-11 text-muted-foreground">
                  Avec un brief, les agents cadrent la mission, vous posent leurs questions, puis la découpent et se la répartissent.
                </p>
              </div>
            </>
          ) : (
            <>
              <DeliverablesField deliv={deliv} setDeliv={setDeliv} />
              <TeamsPicker teams={teams} picked={picked} setPicked={setPicked} />
              <div className="divide-y divide-border rounded-lg border border-border">
                <ToggleRow
                  label="Démarrer dès que le plan est prêt"
                  hint="Sinon, le plan attend votre feu vert."
                  on={autostart} onChange={setAutostart}
                />
                <ToggleRow
                  label="Mission privée"
                  hint={network === 0 ? "Seuls les membres invités y ont accès." : "Visible par tout l'espace."}
                  on={network === 0} onChange={(v) => setNetwork(v ? 0 : 2)}
                />
              </div>
            </>
          )}
          {error && <p className="text-12 text-red-600">{error}</p>}
        </div>

        {/* ── Le pied : où l'on en est, et la suite ── */}
        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          {hasBrief && (
            <div className="flex items-center gap-1.5 text-11 text-muted-foreground">
              {[1, 2].map((n) => (
                <span key={n} className={cn("h-1.5 rounded-full transition-all", step === n ? "w-5 bg-primary" : "w-1.5 bg-border")} />
              ))}
              <span className="ml-1">{step === 1 ? "La mission" : "Livrables et équipe"}</span>
            </div>
          )}
          <div className="flex-1" />
          {step === 2 ? (
            <Button variant="ghost" onClick={() => setStep(1)}>Retour</Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
          )}
          {step === 1 && hasBrief ? (
            <Button onClick={() => setStep(2)} disabled={!name.trim()}>Continuer</Button>
          ) : (
            <Button onClick={submit} disabled={!name.trim() || busy}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} {hasBrief ? "Confier à l'équipe" : "Créer la mission"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Un réglage oui/non, sur une ligne : son libellé, sa conséquence, un interrupteur. */
function ToggleRow({ label, hint, on, onChange }: {
  label: string; hint: string; on: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} data-no-press
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
      <span className="min-w-0 flex-1">
        <span className="block text-13 font-medium">{label}</span>
        <span className="block text-11 text-muted-foreground">{hint}</span>
      </span>
      <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-primary" : "bg-muted-foreground/30")}>
        <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", on ? "left-[18px]" : "left-0.5")} />
      </span>
    </button>
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
