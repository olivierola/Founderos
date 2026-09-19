import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowsClockwiseIcon, ArrowsOutSimpleIcon, CaretDownIcon, CheckIcon,
  FileTextIcon, GlobeSimpleIcon, HouseIcon, LinkSimpleIcon,
  PlusIcon, SlidersIcon, DotsThreeVerticalIcon,
  SquaresFourIcon, StackIcon, SuitcaseSimpleIcon,
  TrashIcon, WarningIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { useAssistant } from "@/lib/assistant-context";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { RoomLauncher } from "@/features/service-dashboards/RoomLauncher";
import { useDashboardAgents } from "@/features/service-dashboards/ServiceDashboardTabs";
import { ProjectLogo } from "./LogoPicker";
import { StickyBoard } from "./StickyBoard";
import { IssueKey, PriorityIcon, StateIcon, formatDate, formatRelative } from "./pickers";
import { CountBadge, EmptyState, IconButton, Modal, PageHeader, SectionTitle, TextField } from "./ui";
import { TRACKER_ACTION_LABEL } from "./IssueMissions";
import {
  decideApproval, fetchAttentionQueue, type AttentionItem,
  HOME_WIDGETS, createQuickLink, deleteQuickLink, fetchHomeWidgets, fetchMyWork,
  fetchProjects, fetchQuickLinks, fetchRecentEntries, saveHomeWidgets,
  type HomeWidget, type MyWorkRow, type RecentEntry,
} from "./model";

/**
 * L'accueil du suivi de travail.
 *
 * Il répond à UNE question — « qu'est-ce que je fais maintenant » — et pas à
 * « quel est l'état du service », qui est le rôle des Analytics.
 *
 * Sa composition est PERSONNELLE (migration 0226) : chacun garde les blocs qui
 * lui servent. C'est le contraire des liens rapides, qui appartiennent à
 * l'équipe. Confondre les deux donnerait soit des liens que chacun doit
 * recréer, soit un accueil que le dernier qui l'a réorganisé impose à tous.
 *
 * Le rythme vertical est large — 4 rem entre les sections. Sur une page qu'on
 * ouvre pour se réorienter, l'air est ce qui permet de balayer ; une grille
 * dense obligerait à lire pour trouver.
 */
export function TrackerHomePage({
  dashboardId, workspaceId, onOpenProject, onOpenIssue,
}: {
  dashboardId: string;
  workspaceId: string | null;
  onOpenProject: (id: string) => void;
  onOpenIssue: (projectId: string, issueId: string) => void;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [managing, setManaging] = useState(false);

  const { data: widgets } = useQuery({
    queryKey: ["pj_home_widgets", dashboardId],
    queryFn: () => fetchHomeWidgets(dashboardId),
  });

  const shown = widgets ?? [];
  const has = (w: HomeWidget) => shown.includes(w);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={<HouseIcon className="h-4 w-4" />}
        title="Home"
        actions={
          <Button
            size="sm" variant="outline" className="h-8 gap-1.5 text-12"
            onClick={() => setManaging(true)}
          >
            <SlidersIcon className="h-4 w-4" /> Gérer les widgets
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-16">
        <div className="mx-auto w-full max-w-[800px]">
          <Greeting name={user?.email?.split("@")[0] ?? null} />

          {/* HORS des widgets, et au-dessus d'eux : ce n'est pas une préférence
              d'affichage mais une alerte. Un bloc qu'on peut masquer finit
              masqué, et ce qu'il signale — un agent arrêté faute de réponse —
              ne se voit alors plus nulle part. Il n'apparaît que s'il y a
              quelque chose à faire. */}
          <AttentionQueue dashboardId={dashboardId} onOpenIssue={onOpenIssue} />

          <div className="flex flex-col">
            {has("ai") && <div className="py-4"><AskTeam dashboardId={dashboardId} workspaceId={workspaceId} /></div>}
            {has("quicklinks") && (
              <div className="py-4">
                <QuickLinks dashboardId={dashboardId} workspaceId={workspaceId} />
              </div>
            )}
            {has("recents") && (
              <div className="py-4">
                <Recents
                  dashboardId={dashboardId}
                  onOpenProject={onOpenProject}
                  onOpenIssue={onOpenIssue}
                />
              </div>
            )}
            {has("my_work") && (
              <div className="py-4">
                <MyWork dashboardId={dashboardId} onOpenIssue={onOpenIssue} />
              </div>
            )}
            {has("stickies") && workspaceId && (
              <div className="py-4">
                <section>
                  <HomeSectionTitle hint="visibles de vous seul">Vos notes</HomeSectionTitle>
                  <StickyBoard dashboardId={dashboardId} workspaceId={workspaceId} />
                </section>
              </div>
            )}
          </div>
        </div>
      </div>

      {managing && workspaceId && user && (
        <ManageWidgetsDialog
          current={shown}
          onClose={() => setManaging(false)}
          onSave={async (next) => {
            await saveHomeWidgets({ workspaceId, dashboardId, userId: user.id, widgets: next });
            qc.invalidateQueries({ queryKey: ["pj_home_widgets", dashboardId] });
          }}
        />
      )}
    </div>
  );
}

/**
 * L'en-tête d'un bloc de l'accueil.
 *
 * Il est en gris TERTIAIRE et non en noir : sur une page faite de cinq blocs
 * empilés, des titres pleinement contrastés se disputent l'attention avec leur
 * propre contenu. Ici le titre sert de repère, pas de message.
 */
function HomeSectionTitle({
  children, hint, action, className,
}: { children: React.ReactNode; hint?: string; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-4 flex items-center justify-between gap-2", className)}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-14 font-semibold text-tertiary">{children}</span>
        {hint && <span className="text-11 text-placeholder">{hint}</span>}
      </div>
      {action}
    </div>
  );
}

/**
 * La salutation, centrée et en gros corps.
 *
 * Elle donne l'heure ET le jour parce que l'accueil sert de point de reprise :
 * savoir qu'on est vendredi 20 h change ce qu'on décide de commencer. Le
 * pictogramme suit le moment de la journée — c'est un repère périphérique,
 * on le lit sans le regarder.
 */
/**
 * Ce qui attend une décision humaine, dans tout le service.
 *
 * Le seul endroit où l'on voit d'un coup d'œil que la machine est arrêtée faute
 * de nous. Chaque ligne se traite sur place quand c'est possible — autoriser ou
 * refuser — et s'ouvre sinon : un item mis en pause demande qu'on relise son
 * brief, ce qui ne se fait pas depuis une liste.
 */
function AttentionQueue({
  dashboardId, onOpenIssue,
}: {
  dashboardId: string;
  onOpenIssue: (projectId: string, issueId: string) => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["pj_attention_queue", dashboardId],
    queryFn: () => fetchAttentionQueue(dashboardId),
    // Une demande naît pendant un run : relue chaque minute tant que la page
    // est ouverte, ce qui suffit — la cloche prévient plus vite pour qui n'y est
    // pas.
    refetchInterval: 60_000,
  });

  const items = data ?? [];
  if (!items.length) return null;

  const decide = async (item: AttentionItem, decision: "approve" | "reject") => {
    setBusy(item.ref_id);
    try {
      await decideApproval(item.ref_id, decision);
      qc.invalidateQueries({ queryKey: ["pj_attention_queue", dashboardId] });
      qc.invalidateQueries({ queryKey: ["pj_issue_approvals", item.issue_id] });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="py-4">
      <HomeSectionTitle hint={`${items.length} en attente`}>En attente de vous</HomeSectionTitle>
      <ul className="overflow-hidden rounded-xl border border-amber-500/30 bg-amber-500/5">
        {items.map((item) => (
          <li
            key={`${item.kind}-${item.ref_id}`}
            className="flex items-center gap-3 border-b border-amber-500/15 px-3 py-2.5 last:border-b-0"
          >
            <span className={cn(
              "grid h-7 w-7 shrink-0 place-items-center rounded-md",
              item.kind === "approval" ? "bg-amber-500/15 text-amber-600" : "bg-red-500/10 text-red-600",
            )}>
              <WarningIcon className="h-4 w-4" />
            </span>

            <button
              type="button"
              onClick={() => onOpenIssue(item.pj_project_id, item.issue_id)}
              className="min-w-0 flex-1 text-left"
            >
              <span className="block truncate text-13">
                <span className="font-medium">{item.agent_name ?? "Un agent"}</span>
                {item.kind === "approval"
                  ? <> veut {TRACKER_ACTION_LABEL[item.detail ?? ""] ?? item.detail ?? "agir"}</>
                  : <> est en pause après trois échecs</>}
              </span>
              <span className="block truncate text-11 text-tertiary">
                <span className="font-mono">{item.issue_ref}</span> · {item.issue_name}
                {item.kind === "approval" && item.reason && <> — {item.reason}</>}
                {item.kind === "stalled" && item.detail && <> — {item.detail}</>}
              </span>
            </button>

            <span className="hidden shrink-0 text-11 text-placeholder sm:block">
              {formatRelative(item.since)}
            </span>

            {item.kind === "approval" ? (
              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm" variant="ghost" className="h-7 text-11"
                  disabled={busy !== null}
                  onClick={() => void decide(item, "reject")}
                >
                  Refuser
                </Button>
                <Button
                  size="sm" className="h-7 text-11"
                  disabled={busy !== null}
                  onClick={() => void decide(item, "approve")}
                >
                  {busy === item.ref_id ? "…" : "Autoriser"}
                </Button>
              </div>
            ) : (
              <Button
                size="sm" variant="outline" className="h-7 shrink-0 text-11"
                onClick={() => onOpenIssue(item.pj_project_id, item.issue_id)}
              >
                Revoir le brief
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Greeting({ name }: { name: string | null }) {
  const now = new Date();
  const hour = now.getHours();

  // Trois moments seulement, coupés à midi et 18 h, comme dans Plane : un
  // « bonne nuit » à 3 h du matin s'adresse à quelqu'un qui travaille, et lui
  // souhaiter de dormir tombe à côté.
  const { label, glyph } = hour < 12 ? { label: "Bonjour", glyph: "🌤️" }
    : hour < 18 ? { label: "Bon après-midi", glyph: "🌥️" }
    : { label: "Bonsoir", glyph: "🌙" };

  const weekDay = now.toLocaleDateString("fr-FR", { weekday: "long" });
  const date = now.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  const time = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", hour12: false });

  return (
    <div className="my-6 flex flex-col items-center">
      <h2 className="text-center text-20 font-semibold">
        {label}{name ? `, ${name}` : ""}
      </h2>
      <h5 className="flex items-center gap-2 text-14 font-medium text-placeholder">
        <span aria-hidden>{glyph}</span>
        <span>
          <span className="capitalize">{weekDay}</span>, {date} {time}
        </span>
      </h5>
    </div>
  );
}

/**
 * Le composeur d'accueil : on écrit, et la conversation existe.
 *
 * C'est le MÊME moteur que l'ancienne page d'accueil du tableau, extrait dans
 * `RoomLauncher` plutôt que recopié : écrire crée une room, y ajoute les
 * agents mentionnés, envoie le message, puis ouvre la room.
 *
 * Ce bloc envoyait auparavant vers le panneau de l'assistant, avec son
 * sélecteur de périmètre et son choix « demander / agir ». La différence n'est
 * pas cosmétique : l'assistant répond dans un fil latéral qui n'appartient à
 * personne, alors qu'une room est un objet du service — elle a des
 * participants, elle garde son historique, les agents y travaillent avec leurs
 * outils, et on peut y revenir. Pour une page d'accueil d'équipe, c'est le bon
 * réceptacle ; l'assistant reste à un clic, pour ce qui n'a pas vocation à
 * laisser de trace.
 */
function AskTeam({
  dashboardId, workspaceId,
}: { dashboardId: string; workspaceId: string | null }) {
  const assistant = useAssistant();
  const { projectId } = useCurrentContext();
  const { data: agents } = useDashboardAgents(dashboardId);
  const { data: dashboards } = useQuery({
    queryKey: ["service_dashboards_name", dashboardId],
    queryFn: async () => {
      const { data } = await supabase
        .from("service_dashboards").select("name").eq("id", dashboardId).maybeSingle();
      return (data as { name?: string } | null)?.name ?? "Service";
    },
  });

  // Sans espace ni projet courant, la création de room n'a pas de quoi
  // s'ancrer. On se tait plutôt que d'offrir un champ qui échouera à l'envoi.
  if (!workspaceId || !projectId) return null;

  return (
    <section>
      <HomeSectionTitle
        className="mb-2"
        action={
          assistant.available ? (
            <IconButton title="Ouvrir l'assistant" onClick={() => assistant.setOpen(true)}>
              <ArrowsOutSimpleIcon className="h-4 w-4" />
            </IconButton>
          ) : undefined
        }
      >
        Demander à votre équipe
      </HomeSectionTitle>

      <RoomLauncher
        dashboardId={dashboardId}
        dashboardName={dashboards ?? "Service"}
        workspaceId={workspaceId}
        projectId={projectId}
        agents={agents ?? []}
        placeholder="Décrivez ce qu'il y a à faire, ou mentionnez un agent avec @…"
        hint="Mentionnez un agent avec @ pour qu'il rejoigne la conversation. Une nouvelle room est créée."
      />
    </section>
  );
}

/**
 * La tuile d'icône des cartes et des lignes : 32 px, coin court, fond sourd.
 * Elle donne un point d'ancrage constant à gauche, ce qui laisse les titres
 * s'aligner même quand leurs icônes n'ont pas la même largeur.
 */
function IconTile({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-muted text-tertiary">
      {children}
    </span>
  );
}

function QuickLinks({
  dashboardId, workspaceId,
}: { dashboardId: string; workspaceId: string | null }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const { data: links } = useQuery({
    queryKey: ["pj_quick_links", dashboardId],
    queryFn: () => fetchQuickLinks(dashboardId),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_quick_links", dashboardId] });

  return (
    <section>
      <HomeSectionTitle
        hint="partagés par l'équipe"
        action={
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="my-auto flex shrink-0 items-center gap-1 text-13 font-medium text-primary"
          >
            <PlusIcon className="h-4 w-4" /> Ajouter un lien
          </button>
        }
      >
        Liens rapides
      </HomeSectionTitle>

      {!links?.length ? (
        <p className="rounded-lg border border-dashed border-border/70 px-3 py-5 text-center text-12 text-tertiary">
          Les adresses que l&apos;équipe rouvre tous les jours : doc, tableau d&apos;astreinte, changelog.
        </p>
      ) : (
        // Des cartes de largeur FIXE qui reviennent à la ligne, et non une
        // grille : une grille étirerait deux liens sur toute la largeur de la
        // page, ce qui les ferait passer pour des sections entières.
        <div className="flex flex-wrap gap-2">
          {links.map((l) => (
            <div
              key={l.id}
              className="group relative flex h-[56px] w-[230px] items-center gap-4 rounded-md border-[0.5px] border-border bg-card px-4 transition-colors hover:border-border"
            >
              <a href={l.url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-4">
                <IconTile><GlobeSimpleIcon className="h-4 w-4" /></IconTile>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-13 font-medium">{l.title}</span>
                  <span className="block truncate text-11 font-medium text-placeholder">
                    {formatRelative(l.created_at)}
                  </span>
                </span>
              </a>
              {/* Un menu et non une corbeille nue : copier l'adresse est le
                  geste le plus fréquent sur un lien, et il n'avait aucune
                  place quand le seul bouton visible supprimait. */}
              <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                      <DotsThreeVerticalIcon className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => navigator.clipboard?.writeText(l.url)}>
                      Copier l&apos;adresse
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => window.open(l.url, "_blank", "noreferrer")}>
                      Ouvrir dans un onglet
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-red-600"
                      onClick={async () => { await deleteQuickLink(l.id); refresh(); }}
                    >
                      Supprimer
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && workspaceId && (
        <QuickLinkDialog
          workspaceId={workspaceId} dashboardId={dashboardId} userId={user?.id ?? null}
          onClose={() => setAdding(false)} onSaved={refresh}
        />
      )}
    </section>
  );
}

/** L'hôte d'une URL, ou l'URL brute si elle est invalide — l'affichage ne doit
 *  pas casser sur une saisie douteuse. */
function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function QuickLinkDialog({
  workspaceId, dashboardId, userId, onClose, onSaved,
}: {
  workspaceId: string; dashboardId: string; userId: string | null;
  onClose: () => void; onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    try {
      new URL(url.trim());
    } catch {
      setError("URL invalide.");
      return;
    }
    await createQuickLink({
      workspaceId, dashboardId,
      title: title.trim() || safeHost(url.trim()),
      url: url.trim(), createdBy: userId,
    });
    onSaved();
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={"Nouveau lien rapide"}
      size="md"
      footer={<>
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button onClick={submit} disabled={!url.trim()}>Ajouter</Button>
        </>}
    >
        <TextField autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        <TextField value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nom (facultatif)" />
        {error && <p className="text-12 text-red-600">{error}</p>}
        </Modal>
  );
}

const RECENT_ICONS = {
  project: SuitcaseSimpleIcon,
  issue: SquaresFourIcon,
  cycle: ArrowsClockwiseIcon,
  module: StackIcon,
  page: FileTextIcon,
  initiative: LinkSimpleIcon,
} as const;

const RECENT_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "Tout" },
  { key: "issue", label: "Work items" },
  { key: "project", label: "Projets" },
  { key: "page", label: "Pages" },
];

function Recents({
  dashboardId, onOpenProject, onOpenIssue,
}: {
  dashboardId: string;
  onOpenProject: (id: string) => void;
  onOpenIssue: (projectId: string, issueId: string) => void;
}) {
  const [filter, setFilter] = useState("all");

  const { data: entries } = useQuery({
    queryKey: ["pj_recent_entries", dashboardId],
    queryFn: () => fetchRecentEntries(dashboardId, 20),
  });

  const rows = (entries ?? []).filter((v) => filter === "all" || v.entity_type === filter);

  return (
    <section>
      <HomeSectionTitle
        action={
          <Popover>
            <PopoverTrigger asChild>
              <button className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-13 font-medium text-secondary hover:bg-muted hover:text-foreground">
                {RECENT_FILTERS.find((f) => f.key === filter)?.label}
                <CaretDownIcon className="my-auto h-3 w-3 text-tertiary" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-40 p-1" align="end">
              {RECENT_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-12",
                    filter === f.key ? "bg-muted font-medium" : "hover:bg-muted",
                  )}
                >
                  {filter === f.key ? <CheckIcon className="h-3 w-3" /> : <span className="w-3" />}
                  {f.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        }
      >
        Récents
      </HomeSectionTitle>

      {!rows.length ? (
        <EmptyState
          icon={<ArrowsClockwiseIcon className="h-5 w-5" />}
          title="Rien encore"
          hint="Ce que vous ouvrirez apparaîtra ici, du plus récent au plus ancien."
          compact
          className="border-dashed"
        />
      ) : (
        <ul className="space-y-0.5">
          {rows.map((v) => (
            <RecentRow
              key={`${v.entity_type}-${v.entity_id}`}
              entry={v}
              onOpen={() => {
                if (v.entity_type === "project") onOpenProject(v.entity_id);
                // Un work item se rouvre dans SON projet : c'est le seul
                // endroit où sa fiche a un board derrière elle.
                else if (v.entity_type === "issue" && v.project_id) {
                  onOpenIssue(v.project_id, v.entity_id);
                } else if (v.project_id) onOpenProject(v.project_id);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Une ligne de récent.
 *
 * Elle porte la même signalétique qu'ailleurs — icône du type, référence
 * PROJET-numéro, état, priorité — parce qu'un récent n'est pas une catégorie
 * d'objet à part : c'est le même work item, vu par la porte de derrière. Lui
 * inventer une présentation propre obligerait à réapprendre à le lire.
 */
function RecentRow({ entry, onOpen }: { entry: RecentEntry; onOpen: () => void }) {
  const Icon = RECENT_ICONS[entry.entity_type];
  const isProject = entry.entity_type === "project";

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-3 text-left transition-colors hover:bg-muted/50"
      >
        <IconTile>
          {isProject && entry.logo_props
            ? <ProjectLogo logo={entry.logo_props} fallback={entry.identifier ?? "?"} size={16} />
            : <Icon className="h-4 w-4" />}
        </IconTile>

        {entry.identifier && (
          <span className="shrink-0 whitespace-nowrap text-13 font-medium text-placeholder">
            {entry.identifier}
            {entry.sequence_id != null && `-${entry.sequence_id}`}
          </span>
        )}

        {/* Le titre ne prend PAS toute la place : le temps le suit
            immédiatement, comme une légende. Repoussé à droite, il se lirait
            comme une colonne à comparer d'une ligne à l'autre, alors qu'il ne
            sert qu'à situer l'item qu'on est en train de lire. */}
        <span className="min-w-0 truncate text-13 font-medium">{entry.title}</span>

        <span className="shrink-0 text-11 font-medium text-placeholder">
          {formatRelative(entry.visited_at)}
        </span>

        <span className="flex-1" />

        {/* L'état et la priorité ferment la ligne, à droite : ce sont les deux
            colonnes qu'on balaie verticalement pour repérer ce qui bloque. */}
        <span className="flex shrink-0 items-center gap-4">
          {entry.state_group && (
            <StateIcon group={entry.state_group} color={entry.state_color ?? undefined} />
          )}
          {entry.priority && entry.priority !== "none" && (
            <PriorityIcon priority={entry.priority} />
          )}
        </span>
      </button>
    </li>
  );
}

function MyWork({
  dashboardId, onOpenIssue,
}: { dashboardId: string; onOpenIssue: (projectId: string, issueId: string) => void }) {
  const { data: rows } = useQuery({
    queryKey: ["pj_my_work", dashboardId],
    queryFn: () => fetchMyWork(dashboardId),
  });

  const today = new Date().toISOString().slice(0, 10);
  const open = (rows ?? []).filter((r) => r.state_group !== "completed" && r.state_group !== "cancelled");
  const late = open.filter((r) => r.target_date && r.target_date.slice(0, 10) < today);

  return (
    <section>
      <HomeSectionTitle action={<CountBadge n={open.length} />}>
        Votre travail
        {late.length > 0 && (
          <span className="ml-2 inline-flex items-center gap-1 inline-flex h-5 items-center rounded-full bg-amber-500/15 px-2 text-11 font-medium leading-none font-medium text-amber-600">
            <WarningIcon className="h-3 w-3" /> {late.length} en retard
          </span>
        )}
      </HomeSectionTitle>

      {!open.length ? (
        <EmptyState
          icon={<CheckIcon className="h-5 w-5" />}
          title="Rien ne vous est assigné"
          hint="Les work items dont vous êtes responsable apparaîtront ici, les retards en premier."
          compact
          className="border-dashed"
        />
      ) : (
        <ul className="space-y-0.5">
          {open.slice(0, 8).map((r) => (
            <MyWorkRowView key={r.issue_id} row={r} today={today} onOpen={onOpenIssue} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MyWorkRowView({
  row, today, onOpen,
}: {
  row: MyWorkRow; today: string;
  onOpen: (projectId: string, issueId: string) => void;
}) {
  const late = row.target_date && !row.completed_at && row.target_date.slice(0, 10) < today;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row.pj_project_id, row.issue_id)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/50"
      >
        {row.state_group && <StateIcon group={row.state_group} color={row.state_color ?? undefined} />}
        <IssueKey identifier={row.identifier} sequenceId={row.sequence_id} />
        <span className="min-w-0 flex-1 truncate text-13 font-medium">{row.name}</span>
        <span className="shrink-0 text-11 text-muted-foreground">{row.project_name}</span>
        <PriorityIcon priority={row.priority} />
        {row.target_date && (
          <span className={cn("shrink-0 text-11", late ? "text-red-600" : "text-muted-foreground")}>
            {formatDate(row.target_date)}
          </span>
        )}
      </button>
    </li>
  );
}

function ManageWidgetsDialog({
  current, onClose, onSave,
}: {
  current: HomeWidget[];
  onClose: () => void;
  onSave: (widgets: HomeWidget[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState<HomeWidget[]>(current);

  // L'ordre de `picked` porte l'ordre d'affichage : cocher ajoute EN FIN de
  // liste, ce qui laisse le bloc qu'on vient d'activer là où on l'attend — en
  // bas — plutôt qu'inséré au milieu de l'accueil.
  const toggle = (w: HomeWidget) =>
    setPicked((prev) => (prev.includes(w) ? prev.filter((x) => x !== w) : [...prev, w]));

  return (
    <Modal
      open
      onClose={onClose}
      title={"Widgets de l&apos;accueil"}
      size="md"
      footer={<>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={async () => { await onSave(picked); onClose(); }}>Enregistrer</Button>
        </>}
    >
        <p className="text-11 text-muted-foreground">
          Cette composition n&apos;appartient qu&apos;à vous : elle ne change rien pour le reste de l&apos;équipe.
        </p>
        <div className="space-y-1">
          {HOME_WIDGETS.map((w) => {
            const on = picked.includes(w.key);
            return (
              <button
                key={w.key}
                type="button"
                onClick={() => toggle(w.key)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                  on ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted",
                )}
              >
                <span className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                  on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                )}>
                  {on && <CheckIcon className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-13">{w.label}</span>
                  <span className="block text-11 text-muted-foreground">{w.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
    </Modal>
  );
}
