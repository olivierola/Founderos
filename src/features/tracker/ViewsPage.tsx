import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowsDownUpIcon, CaretDownIcon, CaretRightIcon, CheckIcon, DotsThreeIcon,
  EyeIcon, GlobeIcon, LockSimpleIcon, MagnifyingGlassIcon, PlusIcon, StackIcon,
  StarIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { LogoPicker, ProjectLogo } from "./LogoPicker";
import { IssuesBoard } from "./IssuesBoard";
import { MemberAvatar, formatRelative, memberName } from "./pickers";
import { EmptyState, Modal, PageHeader, TextAreaField, TextField } from "./ui";
import { SearchIllustration, ViewIllustration } from "./illustrations";
import { countActiveFilters, EMPTY_FILTERS, type Filters } from "./filters";
import {
  createView, deleteView, fetchFavorites, fetchMembers, fetchViews, toggleFavorite,
  updateView,
  type PjProject, type PjView,
} from "./model";

/**
 * Les vues sauvegardées : un jeu de filtres qu'on garde sous la main.
 *
 * Une vue n'est pas une copie du board — c'est une QUESTION qu'on repose
 * souvent (« ce qui m'est assigné et qui est en retard », « les bugs urgents
 * non assignés »). Elle ne fige donc aucun résultat : elle rejoue ses filtres à
 * chaque ouverture, sinon elle deviendrait un rapport périmé le lendemain.
 *
 * L'accès est porté par la vue elle-même : une vue privée sert de brouillon de
 * recherche, une vue partagée devient un vocabulaire d'équipe (« regarde la vue
 * Triage »). Confondre les deux ferait hésiter à créer la première par peur
 * d'encombrer les autres.
 */
/**
 * Les ordres de tri.
 *
 * « Récentes » d'abord parce que la vue qu'on vient de créer est celle qu'on
 * cherche le plus souvent juste après ; l'alphabétique sert quand la liste est
 * assez longue pour qu'on connaisse le nom qu'on veut.
 */
const SORTS = [
  { key: "recent", label: "Les plus récentes" },
  { key: "name", label: "Nom (A → Z)" },
  { key: "filters", label: "Nombre de critères" },
] as const;

type Sort = (typeof SORTS)[number]["key"];

export function ViewsPage({ project }: { project: PjProject }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<PjView | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");

  const { data: views } = useQuery({
    queryKey: ["pj_views", project.id],
    queryFn: () => fetchViews(project.id),
  });
  const { data: members } = useQuery({
    queryKey: ["pj_members", project.workspace_id],
    queryFn: () => fetchMembers(project.workspace_id),
  });

  const { data: favorites } = useQuery({
    queryKey: ["pj_favorites", project.workspace_id, user?.id],
    queryFn: () => fetchFavorites(project.workspace_id, user!.id),
    enabled: !!user,
  });

  const favorite = useMemo(
    () => new Set((favorites ?? []).filter((f) => f.entity_type === "view").map((f) => f.entity_id)),
    [favorites],
  );

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_views", project.id] });
  const refreshFavorites = () =>
    qc.invalidateQueries({ queryKey: ["pj_favorites", project.workspace_id, user?.id] });

  const star = async (viewId: string, on: boolean) => {
    if (!user) return;
    await toggleFavorite({
      workspaceId: project.workspace_id, userId: user.id,
      entityType: "view", entityId: viewId, on,
    });
    refreshFavorites();
  };

  const shown = useMemo(() => {
    const list = (views ?? []).filter((v) =>
      !query.trim() || v.name.toLowerCase().includes(query.toLowerCase()));

    const rank = (v: PjView) => {
      switch (sort) {
        case "name": return v.name.toLowerCase();
        case "filters":
          return -countActiveFilters({ ...EMPTY_FILTERS, ...(v.filters as Partial<Filters>) });
        // `sort_order` décroît à la création : le plus récent porte le plus
        // petit rang, d'où la lecture directe.
        default: return v.sort_order;
      }
    };

    return [...list].sort((a, b) => {
      // Les favorites restent en tête QUEL QUE SOIT le tri : les épingler pour
      // les voir se disperser au premier changement d'ordre viderait le geste
      // de son sens.
      const fa = favorite.has(a.id) ? 0 : 1;
      const fb = favorite.has(b.id) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      const ra = rank(a);
      const rb = rank(b);
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
  }, [views, query, sort, favorite]);

  const current = (views ?? []).find((v) => v.id === openId) ?? null;

  if (current) {
    return (
      <div className="flex h-full flex-col">
        {/* UNE seule barre, pas deux. L'écran d'une vue ouverte est un board :
            lui poser un en-tête de page au-dessus de la barre du board donnait
            deux rangées pour un seul écran, dont la première ne portait qu'un
            nom déjà répété dans la seconde. Le fil d'Ariane prend la place du
            titre DANS la barre. */}
        <div className="min-h-0 flex-1">
          <IssuesBoard
            project={project}
            scope={{ pjProjectId: project.id }}
            // La clé inclut l'identifiant : chaque vue garde SON layout et ses
            // réglages d'affichage, ce qui est le propre d'une vue — sinon
            // passer de « Mes retards » en liste à « Roadmap » remettrait
            // celle-ci en liste alors qu'on l'avait laissée en gantt.
            scopeKey={`view-${current.id}`}
            breadcrumb={
              <ViewBreadcrumb
                current={current}
                views={views ?? []}
                onBack={() => setOpenId(null)}
                onPick={setOpenId}
              />
            }
            initialFilters={{ ...EMPTY_FILTERS, ...(current.filters as Partial<Filters>) }}
            emptyHint="Aucun work item ne correspond aux critères de cette vue. Modifiez-les, ou créez le premier item qui y répond."
            headerSlot={
              <>
                <Button size="sm" className="h-8 gap-1.5" onClick={() => setCreating(true)}>
                  <PlusIcon className="h-4 w-4" /> Nouvelle vue
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground">
                      <DotsThreeIcon className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setEditing(current)}>Modifier la vue</DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => star(current.id, !favorite.has(current.id))}
                    >
                      {favorite.has(current.id) ? "Retirer des favoris" : "Mettre en favori"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => updateView(current.id, { access: current.access === 1 ? 0 : 1 }).then(refresh)}
                    >
                      {current.access === 1 ? "Rendre privée" : "Partager avec l'espace"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setOpenId(null)}>
                      Retour à la liste
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-red-600"
                      onClick={async () => { await deleteView(current.id); setOpenId(null); refresh(); }}
                    >
                      Supprimer la vue
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            }
          />
        </div>

        {(creating || editing) && (
          <ViewDialog
            project={project}
            view={editing}
            userId={user?.id ?? null}
            onClose={() => { setCreating(false); setEditing(null); }}
            onSaved={refresh}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={<EyeIcon className="h-4 w-4" />}
        title="Vues"
        actions={
          <>
            <div className="relative w-52">
              <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <TextField
                value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Rechercher une vue…" className="h-8 pl-8 text-13"
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

            <Button size="sm" className="h-8 gap-1.5" onClick={() => setCreating(true)}>
              <PlusIcon className="h-4 w-4" /> Nouvelle vue
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!shown.length ? (
          // Deux messages distincts : « rien ne correspond » demande de changer
          // sa recherche, « aucune vue » demande d'en créer une. Le même texte
          // pour les deux enverrait créer une vue à quelqu'un qui en a douze et
          // s'est juste trompé de mot.
          query ? (
            <EmptyState
              illustration={<SearchIllustration className="w-full" />}
              title="Aucune vue ne correspond"
              hint={`Rien ne s'appelle « ${query} » ici. Essayez un autre mot, ou effacez la recherche.`}
              action={
                <Button size="sm" variant="outline" onClick={() => setQuery("")}>
                  Effacer la recherche
                </Button>
              }
            />
          ) : (
            <EmptyState
              illustration={<ViewIllustration className="w-full" />}
              title="Aucune vue"
              hint="Une vue garde un jeu de filtres sous la main : « mes retards », « les bugs urgents non assignés ». Elle rejoue ses critères à chaque ouverture, elle ne fige jamais un résultat."
              action={
                <Button size="sm" onClick={() => setCreating(true)}>
                  <PlusIcon className="mr-1 h-4 w-4" /> Créer une vue
                </Button>
              }
            />
          )
        ) : (
          <ul>
            {shown.map((v) => (
              <ViewRow
                key={v.id}
                view={v}
                owner={(members ?? []).find((m) => m.user_id === v.owned_by)}
                starred={favorite.has(v.id)}
                onStar={() => star(v.id, !favorite.has(v.id))}
                onOpen={() => setOpenId(v.id)}
                onEdit={() => setEditing(v)}
                onChanged={refresh}
              />
            ))}
          </ul>
        )}
      </div>

      {(creating || editing) && (
        <ViewDialog
          project={project}
          view={editing}
          userId={user?.id ?? null}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

/**
 * Le fil d'Ariane d'une vue ouverte : « Vues › nom [compte] ⌄ ».
 *
 * Le chevron n'est pas décoratif : il ouvre la liste des autres vues. C'est ce
 * qui manque quand on ne met qu'une flèche de retour — passer d'une vue à
 * l'autre demandait alors deux gestes (revenir, rouvrir) alors que c'est
 * précisément l'aller-retour qu'on fait le plus souvent en triant.
 */
function ViewBreadcrumb({
  current, views, onBack, onPick,
}: {
  current: PjView;
  views: PjView[];
  onBack: () => void;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-13 text-tertiary transition-colors hover:bg-muted hover:text-foreground"
      >
        <StackIcon className="h-4 w-4" />
        Vues
      </button>

      <CaretRightIcon className="h-3 w-3 shrink-0 text-placeholder" />

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted"
          >
            {current.logo_props && Object.keys(current.logo_props).length
              ? <ProjectLogo logo={current.logo_props} size={15} />
              : <StackIcon className="h-4 w-4 shrink-0 text-tertiary" />}
            <span className="min-w-0 truncate text-13 font-medium">{current.name}</span>
            <CaretDownIcon className="h-3 w-3 shrink-0 text-tertiary" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-1" align="start">
          {views.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => { onPick(v.id); setOpen(false); }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-12",
                v.id === current.id ? "bg-muted font-medium" : "hover:bg-muted",
              )}
            >
              {v.logo_props && Object.keys(v.logo_props).length
                ? <ProjectLogo logo={v.logo_props} size={14} />
                : <StackIcon className="h-3.5 w-3.5 shrink-0 text-tertiary" />}
              <span className="min-w-0 flex-1 truncate">{v.name}</span>
              {v.id === current.id && <CheckIcon className="h-3.5 w-3.5 shrink-0" />}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ViewRow({
  view, owner, starred, onStar, onOpen, onEdit, onChanged,
}: {
  view: PjView;
  owner: { user_id: string; full_name: string | null; email: string | null } | undefined;
  starred: boolean;
  onStar: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const active = countActiveFilters({ ...EMPTY_FILTERS, ...(view.filters as Partial<Filters>) });

  return (
    <li className="group flex items-center gap-3 border-b border-border/40 px-4 py-2.5 hover:bg-muted/30">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
        {view.logo_props && Object.keys(view.logo_props).length
          ? <ProjectLogo logo={view.logo_props} size={15} />
          : <StackIcon className="h-4 w-4 text-muted-foreground" />}
      </span>

      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-13 font-medium hover:underline">{view.name}</span>
        {view.description && (
          <span className="block truncate text-11 text-muted-foreground">{view.description}</span>
        )}
      </button>

      {/* Le nombre de critères, pas leur liste : sur une ligne, six puces de
          filtre remplacent le nom de la vue par du bruit. */}
      <span className="shrink-0 text-11 text-muted-foreground">
        {active === 0 ? "Aucun filtre" : `${active} critère${active > 1 ? "s" : ""}`}
      </span>

      {owner && <MemberAvatar member={owner} />}

      {/* L'étoile reste visible une fois posée, et n'apparaît au survol que
          tant qu'elle est vide : une liste où toutes les étoiles sont grises
          en permanence ne dit plus lesquelles comptent. */}
      <button
        type="button"
        title={starred ? "Retirer des favoris" : "Mettre en favori"}
        onClick={onStar}
        className={cn(
          "shrink-0 rounded p-1 transition-opacity",
          starred
            ? "text-amber-500"
            : "text-tertiary opacity-0 hover:text-foreground group-hover:opacity-100",
        )}
      >
        <StarIcon weight={starred ? "fill" : "regular"} className="h-4 w-4" />
      </button>

      <span
        className="shrink-0 text-muted-foreground"
        title={view.access === 1 ? "Partagée avec l'espace" : "Privée"}
      >
        {view.access === 1
          ? <GlobeIcon className="h-4 w-4" />
          : <LockSimpleIcon className="h-4 w-4" />}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100">
            <DotsThreeIcon className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onOpen}>Ouvrir</DropdownMenuItem>
          <DropdownMenuItem onClick={onStar}>
            {starred ? "Retirer des favoris" : "Mettre en favori"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onEdit}>Modifier</DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => updateView(view.id, { access: view.access === 1 ? 0 : 1 }).then(onChanged)}
          >
            {view.access === 1 ? "Rendre privée" : "Partager avec l'espace"}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-red-600"
            onClick={async () => { await deleteView(view.id); onChanged(); }}
          >
            Supprimer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * La création et la modification d'une vue.
 *
 * On n'y règle PAS les filtres : ils se posent sur le board, où l'on voit leur
 * effet, puis « Enregistrer comme vue » les capture. Reproduire ici une barre
 * de filtres reviendrait à composer une requête à l'aveugle.
 */
function ViewDialog({
  project, view, userId, onClose, onSaved,
}: {
  project: PjProject;
  view: PjView | null;
  userId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(view?.name ?? "");
  const [description, setDescription] = useState(view?.description ?? "");
  const [logo, setLogo] = useState<Record<string, unknown>>(view?.logo_props ?? {});
  const [access, setAccess] = useState<0 | 1>((view?.access as 0 | 1) ?? 1);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (view) {
        await updateView(view.id, {
          name: name.trim(), description, logo_props: logo, access,
        });
      } else {
        await createView({
          pjProjectId: project.id, workspaceId: project.workspace_id,
          name: name.trim(), description,
          // Une vue créée depuis cet écran part SANS filtre : elle montre tout,
          // et on la restreint ensuite depuis le board. L'inverse — créer une
          // vue déjà filtrée sans avoir vu le résultat — donne des vues vides
          // qu'on n'ose plus supprimer faute de savoir ce qu'elles cherchaient.
          filters: {},
          // L'affichage part vide lui aussi : la vue adoptera les réglages du
          // board tant que personne n'en enregistre d'autres, ce qui évite
          // qu'elle impose un layout choisi à l'aveugle.
          display_filters: {},
          display_properties: {},
          access, ownedBy: userId,
        });
      }
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={view ? "Modifier la vue" : "Nouvelle vue"}
      size="lg"
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button onClick={submit} disabled={!name.trim() || busy}>
            {view ? "Enregistrer" : "Créer la vue"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
          <div className="flex gap-2">
            <LogoPicker value={logo} onChange={setLogo} size={36} fallback={name || "VUE"} />
            <TextField
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="Nom de la vue" className="flex-1"
            />
          </div>

          <TextAreaField
            value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Que cherche-t-on avec cette vue ?" className="min-h-[70px]"
          />

          <fieldset>
            <legend className="mb-2 text-12 text-secondary">Accès</legend>
            <div className="space-y-2">
              <AccessOption
                active={access === 1} onSelect={() => setAccess(1)}
                icon={<GlobeIcon className="h-4 w-4" />}
                label="Partagée"
                hint="Toute l'équipe la voit et peut s'y référer par son nom."
              />
              <AccessOption
                active={access === 0} onSelect={() => setAccess(0)}
                icon={<LockSimpleIcon className="h-4 w-4" />}
                label="Privée"
                hint="Un brouillon de recherche, visible de vous seul."
              />
            </div>
          </fieldset>

          {!view && (
            <p className="rounded-md border border-dashed border-border/70 px-3 py-2 text-11 text-muted-foreground">
              Les filtres se posent sur le board, puis « Enregistrer comme vue » les capture —
              on voit ainsi ce qu&apos;on garde avant de le garder.
            </p>
          )}

      </div>
    </Modal>
  );
}

function AccessOption({
  active, onSelect, icon, label, hint,
}: {
  active: boolean; onSelect: () => void;
  icon: React.ReactNode; label: string; hint: string;
}) {
  return (
    <button type="button" onClick={onSelect} className="flex w-full items-start gap-2.5 text-left">
      <span className={cn(
        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
        active ? "border-primary" : "border-border",
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
