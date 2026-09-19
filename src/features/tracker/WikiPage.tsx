import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CaretDownIcon, CaretRightIcon, FileTextIcon, LockSimpleIcon, PlusIcon,
  RobotIcon, StarIcon, TrashIcon, UsersThreeIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { ArtifactsBrowser } from "@/features/service-dashboards/RoomArtifacts";
import { formatDate } from "./pickers";
import { PageEditor as RichEditor, SaveState, useSaveState } from "./PageEditor";
import { TextField } from "./ui";
import {
  createPage, deletePage, fetchFavorites, fetchWikiPages, toggleFavorite, updatePage,
  type PjPage,
} from "./model";

/**
 * Le Wiki : les pages qui appartiennent au SERVICE, pas à un projet.
 *
 * La distinction est le tout du module. Une page de projet documente ce
 * projet et meurt avec lui ; une page de wiki — une décision d'architecture, un
 * runbook, un plan de lancement — survit aux projets qui l'ont motivée. Les
 * ranger ensemble reviendrait à perdre la seconde catégorie le jour où le
 * projet est archivé.
 *
 * Trois regroupements, dans cet ordre : les collections (l'arborescence
 * partagée), les favoris (ce qu'on rouvre tous les jours), et mes pages (les
 * brouillons qu'on n'a pas encore rangés).
 *
 * ── Les artefacts ───────────────────────────────────────────────────────────
 *
 * Ils avaient leur propre onglet, sous l'Assistant. Ils sont ici, en tête de la
 * colonne, et ce n'est pas un rangement : un rapport produit par un agent et une
 * page écrite à la main sont deux DOCUMENTS du même service. Les tenir dans deux
 * onglets obligeait à savoir, avant de chercher, lequel des deux on cherchait —
 * ce qu'on ignore précisément quand on cherche.
 *
 * Ils restent une entrée SÉPARÉE et non une cinquième section de la liste : ce
 * ne sont pas des pages de wiki, ils ne s'éditent pas pareil, et les mêler aux
 * autres aurait fait croire qu'on peut les ranger dans une collection.
 */
export function WikiPage({
  dashboardId, workspaceId,
}: { dashboardId: string; workspaceId: string | null }) {
  const { user } = useAuth();
  const { projectId } = useCurrentContext();
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  /** La colonne pilote DEUX contenus : une page, ou la galerie d'artefacts. */
  const [artifacts, setArtifacts] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");

  const { data: pages } = useQuery({
    queryKey: ["pj_wiki", dashboardId],
    queryFn: () => fetchWikiPages(dashboardId),
  });
  const { data: favorites } = useQuery({
    queryKey: ["pj_favorites", workspaceId, user?.id],
    enabled: !!workspaceId && !!user,
    queryFn: () => fetchFavorites(workspaceId!, user!.id),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pj_wiki", dashboardId] });
    qc.invalidateQueries({ queryKey: ["pj_favorites"] });
  };

  const favouriteIds = useMemo(
    () => new Set((favorites ?? []).filter((f) => f.entity_type === "page").map((f) => f.entity_id)),
    [favorites],
  );

  const all = pages ?? [];
  const current = all.find((p) => p.id === openId) ?? null;
  const openPage = (id: string) => { setArtifacts(false); setOpenId(id); };

  const groups = useMemo(() => ({
    // Une collection est une page RACINE qui en porte d'autres. On ne crée pas
    // d'entité « collection » : toute page peut le devenir en accueillant un
    // enfant, ce qui évite de choisir entre « page » et « dossier » au moment
    // où l'on a juste une idée à noter.
    collections: all.filter((p) => !p.parent_id && all.some((c) => c.parent_id === p.id)),
    favourites: all.filter((p) => favouriteIds.has(p.id)),
    mine: all.filter((p) => p.owned_by === user?.id && !p.parent_id && !all.some((c) => c.parent_id === p.id)),
    shared: all.filter((p) => p.owned_by !== user?.id && !p.parent_id && !all.some((c) => c.parent_id === p.id)),
  }), [all, favouriteIds, user?.id]);

  const create = async (parentId: string | null) => {
    if (!workspaceId) return;
    const page = await createPage({
      workspaceId, dashboardId, parentId,
      name: title.trim() || "Sans titre", ownedBy: user?.id ?? null,
    });
    setTitle("");
    setCreating(false);
    refresh();
    setArtifacts(false);
    setOpenId(page.id);
  };

  return (
    <div className="flex h-full">
      {/* 300 px et un fond en RETRAIT du contenu.
          Une colonne de la même couleur que la page qu'elle borde ne se lit pas
          comme une navigation mais comme une première colonne de texte : on ne
          sait plus où commence le document. Le décrochage d'un demi-ton suffit
          à séparer les deux, et c'est le procédé du reste du produit. */}
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-border bg-sidebar-background/40">
        <div className="p-2">
          <Button size="sm" className="h-8 w-full justify-start" onClick={() => setCreating(true)}>
            <PlusIcon className="mr-1.5 h-4 w-4" /> Nouvelle page
          </Button>
        </div>

        {creating && (
          <div className="px-2 pb-2">
            <TextField
              autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create(null);
                if (e.key === "Escape") { setTitle(""); setCreating(false); }
              }}
              onBlur={() => { if (!title.trim()) setCreating(false); }}
              placeholder="Titre de la page" className="h-8 text-14"
            />
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-6">
          {/* En TÊTE de colonne, avant les sections : c'est une destination, pas
              un groupe de pages, et la placer au milieu de la liste l'aurait
              fait passer pour l'une d'elles. */}
          <div className="px-2">
            <button
              type="button"
              onClick={() => { setArtifacts(true); setOpenId(null); }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-13 transition-colors",
                artifacts
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-secondary hover:bg-muted hover:text-foreground",
              )}
            >
              <RobotIcon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Artefacts</span>
            </button>
          </div>

          <Section label="Collections" icon={FileTextIcon} count={groups.collections.length}>
            {groups.collections.map((p) => (
              <CollectionNode
                key={p.id} page={p} pages={all} activeId={openId}
                onOpen={openPage} onAddChild={(parent) => create(parent)}
              />
            ))}
            {!groups.collections.length && (
              <Empty>Une collection range les pages par sujet.</Empty>
            )}
          </Section>

          <Section label="Favoris" icon={StarIcon} count={groups.favourites.length}>
            {groups.favourites.map((p) => (
              <PageRow key={p.id} page={p} active={openId === p.id} onOpen={openPage} />
            ))}
            {!groups.favourites.length && (
              <Empty>L&apos;étoile d&apos;une page la remonte ici.</Empty>
            )}
          </Section>

          <Section label="Mes pages" icon={FileTextIcon} count={groups.mine.length}>
            {groups.mine.map((p) => (
              <PageRow key={p.id} page={p} active={openId === p.id} onOpen={openPage} />
            ))}
            {!groups.mine.length && (
              <Empty>Les pages que vous créez apparaissent ici.</Empty>
            )}
          </Section>

          <Section label="Partagé avec moi" icon={UsersThreeIcon} count={groups.shared.length}>
            {groups.shared.map((p) => (
              <PageRow key={p.id} page={p} active={openId === p.id} onOpen={openPage} />
            ))}
            {!groups.shared.length && (
              <Empty>Les pages publiées par l&apos;équipe arrivent ici.</Empty>
            )}
          </Section>
        </div>
      </aside>

      {artifacts ? (
        <div className="min-w-0 flex-1">
          <ArtifactsBrowser workspaceId={workspaceId ?? ""} projectId={projectId ?? null} />
        </div>
      ) : !current ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <FileTextIcon className="h-8 w-8 text-muted-foreground" />
          <p className="text-14 text-muted-foreground">
            Sélectionnez une page, ou créez-en une.
          </p>
        </div>
      ) : (
        <PageEditor
          key={current.id}
          page={current}
          favourite={favouriteIds.has(current.id)}
          workspaceId={workspaceId}
          userId={user?.id ?? null}
          onChanged={refresh}
          onDeleted={() => { setOpenId(null); refresh(); }}
          onAddChild={() => create(current.id)}
        />
      )}
    </div>
  );
}

/**
 * Un groupe de la colonne.
 *
 * L'en-tête porte un COMPTEUR, et il ne sert pas à décorer : replié, un groupe
 * ne dit plus rien de ce qu'il contient, et on le rouvre pour vérifier qu'il
 * est bien vide. Le compteur évite ce geste.
 *
 * Le libellé est en capitales et en petit corps — le cran de la navigation du
 * produit. Au corps du texte, quatre en-têtes empilés se lisaient comme quatre
 * entrées de plus dans la liste, au même rang que les pages elles-mêmes.
 */
function Section({
  label, icon: Icon, count, children,
}: {
  label: string;
  icon: typeof FileTextIcon;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group/sec flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-10 font-semibold uppercase tracking-wide text-tertiary transition-colors hover:text-foreground"
      >
        <CaretDownIcon className={cn(
          "h-3 w-3 shrink-0 transition-transform",
          !open && "-rotate-90",
        )} />
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count > 0 && (
          <span className="shrink-0 rounded bg-muted px-1.5 text-10 font-medium tabular-nums text-tertiary">
            {count}
          </span>
        )}
      </button>
      {open && <div className="space-y-px px-2 pb-1">{children}</div>}
    </div>
  );
}

/**
 * Le vide d'un groupe de la colonne latérale.
 *
 * Une phrase et non un constat : « Aucun favori » dit ce qui manque, pas
 * comment le remplir, et sur une colonne de quatre groupes vides on se retrouve
 * devant quatre négations sans savoir par où commencer.
 */
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2.5 py-1 text-11 leading-snug text-placeholder">{children}</p>
  );
}

function PageRow({
  page, active, onOpen, depth = 0,
}: { page: PjPage; active: boolean; onOpen: (id: string) => void; depth?: number }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(page.id)}
      style={{ paddingLeft: 10 + depth * 14 }}
      className={cn(
        "flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-13 transition-colors",
        // La page ouverte porte un LISERÉ à gauche en plus du fond. Sur une
        // colonne où plusieurs lignes se survolent au passage de la souris, le
        // fond seul ne suffit pas à distinguer « survolé » de « ouvert ».
        active
          ? "bg-muted font-medium text-foreground shadow-[inset_2px_0_0_hsl(var(--primary))]"
          : "text-secondary hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <FileTextIcon className={cn(
        "h-3.5 w-3.5 shrink-0",
        active ? "text-primary" : "text-tertiary",
      )} />
      <span className="min-w-0 flex-1 truncate">{page.name || "Sans titre"}</span>
      {page.is_locked && <LockSimpleIcon className="h-3 w-3 shrink-0 text-tertiary" />}
    </button>
  );
}

function CollectionNode({
  page, pages, activeId, onOpen, onAddChild, depth = 0,
}: {
  page: PjPage; pages: PjPage[]; activeId: string | null;
  onOpen: (id: string) => void; onAddChild: (parentId: string) => void; depth?: number;
}) {
  const [open, setOpen] = useState(true);
  const children = pages.filter((p) => p.parent_id === page.id);

  return (
    <>
      <div className="group flex items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{ marginLeft: depth * 14 }}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted"
        >
          {open ? <CaretDownIcon className="h-3 w-3" /> : <CaretRightIcon className="h-3 w-3" />}
        </button>
        <button
          type="button"
          onClick={() => onOpen(page.id)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded py-1.5 pr-1 text-left text-13",
            activeId === page.id ? "bg-muted font-medium" : "hover:bg-muted/60",
          )}
        >
          <span className="min-w-0 flex-1 truncate">{page.name || "Sans titre"}</span>
        </button>
        <button
          type="button"
          onClick={() => onAddChild(page.id)}
          title="Ajouter une page dans cette collection"
          className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100"
        >
          <PlusIcon className="h-3 w-3" />
        </button>
      </div>
      {open && children.map((c) => (
        pages.some((p) => p.parent_id === c.id)
          ? <CollectionNode
              key={c.id} page={c} pages={pages} activeId={activeId}
              onOpen={onOpen} onAddChild={onAddChild} depth={depth + 1}
            />
          : <PageRow key={c.id} page={c} active={activeId === c.id} onOpen={onOpen} depth={depth + 1} />
      ))}
    </>
  );
}

/**
 * L'éditeur d'une page.
 *
 * Le titre et le corps s'enregistrent à la sortie du champ plutôt qu'à chaque
 * frappe : une page de wiki se rédige par blocs, pas caractère par caractère,
 * et écrire à chaque touche multiplierait les révisions sans rien protéger de
 * plus qu'un enregistrement au flou.
 */
function PageEditor({
  page, favourite, workspaceId, userId, onChanged, onDeleted, onAddChild,
}: {
  page: PjPage; favourite: boolean; workspaceId: string | null; userId: string | null;
  onChanged: () => void; onDeleted: () => void; onAddChild: () => void;
}) {
  const [name, setName] = useState(page.name);
  const save = useSaveState();

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
        <FileTextIcon className="h-4 w-4 text-muted-foreground" />
        <span className="truncate text-14">{name || "Sans titre"}</span>
        <div className="flex-1" />
        <SaveState state={save.state} />
        <button
          type="button"
          title={favourite ? "Retirer des favoris" : "Ajouter aux favoris"}
          onClick={async () => {
            if (!workspaceId || !userId) return;
            await toggleFavorite({
              workspaceId, userId, entityType: "page", entityId: page.id, on: !favourite,
            });
            onChanged();
          }}
          className={cn(
            "rounded p-1.5 hover:bg-muted",
            favourite ? "text-amber-500" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <StarIcon className="h-4 w-4" weight={favourite ? "fill" : "regular"} />
        </button>
        <button
          type="button"
          title={page.is_locked ? "Déverrouiller" : "Verrouiller"}
          onClick={() => updatePage(page.id, { is_locked: !page.is_locked }).then(onChanged)}
          className={cn(
            "rounded p-1.5 hover:bg-muted",
            page.is_locked ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <LockSimpleIcon className="h-4 w-4" />
        </button>
        <button
          type="button" title="Ajouter une sous-page" onClick={onAddChild}
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={async () => { await deletePage(page.id); onDeleted(); }}
          className="rounded p-1.5 text-muted-foreground hover:text-red-600"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-3xl">
          <input
            value={name}
            disabled={page.is_locked}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (name !== page.name) updatePage(page.id, { name }).then(onChanged); }}
            placeholder="Sans titre"
            className="w-full bg-transparent pb-3 text-3xl font-semibold outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <p className="pb-5 text-11 text-muted-foreground">
            Modifiée le {formatDate(page.updated_at)}
            {page.is_locked ? " · verrouillée" : ""}
          </p>
          <RichEditor
            value={page.description_rich ?? page.description_html}
            readOnly={page.is_locked}
            workspaceId={page.workspace_id}
            onSave={(rich, text, markdown) => {
              save.begin();
              // Les deux colonnes partent ensemble : l'arbre est la source que
              // relit l'éditeur, le texte alimente recherche et exports.
              updatePage(page.id, {
                description_rich: rich,
                description_html: markdown,
                description_text: text,
              } as Parameters<typeof updatePage>[1]).then(() => { save.done(); onChanged(); });
            }}
          />
        </div>
      </div>
    </div>
  );
}
