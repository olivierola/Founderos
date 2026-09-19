import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon, DotsThreeIcon, FileTextIcon, LockSimpleIcon, PlusIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { PageEditor as RichEditor } from "./PageEditor";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth-context";
import { formatDate } from "./pickers";
import { PageIllustration } from "./illustrations";
import { EmptyState } from "./ui";
import {
  createPage, deletePage, fetchPages, updatePage, type PjPage, type PjProject,
} from "./model";

/**
 * Les pages : la documentation du projet, à côté de son suivi.
 *
 * L'édition écrit à la volée avec un délai, pas sur un bouton « Enregistrer » :
 * une page qu'on quitte sans penser à valider est une page perdue, et c'est
 * exactement ce que Plane évite en sauvegardant en continu.
 */
export function PagesPage({ project }: { project: PjProject }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [openPage, setOpenPage] = useState<PjPage | null>(null);

  const { data: pages } = useQuery({
    queryKey: ["pj_pages", project.id],
    queryFn: () => fetchPages(project.id),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_pages", project.id] });

  const create = async () => {
    const page = await createPage({
      pjProjectId: project.id, workspaceId: project.workspace_id,
      name: "Page sans titre", ownedBy: user?.id ?? null,
    });
    refresh();
    setOpenPage(page);
  };

  if (openPage) {
    return (
      <PageEditor
        page={openPage}
        onBack={() => { setOpenPage(null); refresh(); }}
        onChanged={refresh}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex h-header shrink-0 items-center justify-between px-4">
        <h2 className="text-14 font-medium">Pages</h2>
        <Button size="sm" className="h-8" onClick={create}>
          <PlusIcon className="mr-1 h-4 w-4" /> Nouvelle page
        </Button>
      </header>

      {!pages?.length ? (
        <EmptyState
          illustration={<PageIllustration className="w-full" />}
          title="Aucune page"
          hint="Les pages accueillent ce qui ne tient pas dans un work item : une spec, un compte rendu, une décision et sa raison."
          action={
            <Button size="sm" className="h-8" onClick={create}>
              <PlusIcon className="mr-1 h-4 w-4" /> Nouvelle page
            </Button>
          }
        />
      ) : (
        <ul className="px-4 pb-4">
          {pages.map((p) => (
            <li key={p.id} className="flex items-center gap-2 border-b border-border/40 py-2.5">
              <FileTextIcon className="h-4 w-4 text-muted-foreground" />
              <button type="button" onClick={() => setOpenPage(p)} className="min-w-0 flex-1 text-left">
                <span className="text-14">{p.name || "Page sans titre"}</span>
                <span className="block text-11 text-muted-foreground">
                  Modifiée le {formatDate(p.updated_at)}
                </span>
              </button>
              {p.access === 0 && <LockSimpleIcon className="h-3.5 w-3.5 text-muted-foreground" />}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted">
                    <DotsThreeIcon className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => updatePage(p.id, { access: p.access === 1 ? 0 : 1 }).then(refresh)}>
                    {p.access === 1 ? "Rendre privée" : "Partager"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => updatePage(p.id, { is_locked: !p.is_locked }).then(refresh)}>
                    {p.is_locked ? "Déverrouiller" : "Verrouiller"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => updatePage(p.id, { archived_at: new Date().toISOString() }).then(refresh)}
                  >
                    Archiver
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-red-600"
                    onClick={async () => { await deletePage(p.id); refresh(); }}
                  >
                    Supprimer
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PageEditor({
  page, onBack, onChanged,
}: { page: PjPage; onBack: () => void; onChanged: () => void }) {
  const [name, setName] = useState(page.name);
  const [saved, setSaved] = useState(true);

  // Le TITRE seul est enregistré ici, en différé. Le corps passe par
  // l'éditeur riche, qui porte son propre délai : deux minuteurs sur la même
  // ligne se marcheraient dessus et l'un écraserait l'écriture de l'autre.
  useEffect(() => {
    if (name === page.name) return;
    setSaved(false);
    const timer = setTimeout(async () => {
      await updatePage(page.id, { name });
      setSaved(true);
      onChanged();
    }, 700);
    return () => clearTimeout(timer);
  }, [name, page.id, page.name, onChanged]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-header shrink-0 items-center gap-3 border-b border-border px-4">
        <button type="button" onClick={onBack} className="rounded p-1 hover:bg-muted">
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <span className="text-11 text-muted-foreground">
          {page.is_locked ? "Verrouillée" : saved ? "Enregistrée" : "Enregistrement…"}
        </span>
      </header>

      <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-6 py-6">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={page.is_locked}
          placeholder="Titre de la page"
          className="w-full bg-transparent pb-3 text-24 font-medium outline-none disabled:opacity-70"
        />
        {/* L'éditeur du produit plutôt qu'un textarea : une page de projet
            porte des tableaux, des blocs de code et des cases à cocher, que du
            texte plat ne sait pas représenter. */}
        <RichEditor
          value={page.description_rich ?? page.description_html}
          readOnly={page.is_locked}
          workspaceId={page.workspace_id}
          onSave={(rich, text, markdown) => {
            updatePage(page.id, {
              description_rich: rich,
              description_html: markdown,
              description_text: text,
            } as Partial<PjPage>).then(() => { setSaved(true); onChanged(); });
          }}
        />
      </div>
    </div>
  );
}
