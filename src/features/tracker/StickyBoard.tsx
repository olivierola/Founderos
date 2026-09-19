import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DotsSixIcon, ListChecksIcon, MagnifyingGlassIcon, PaletteIcon, PlusIcon,
  TextBIcon, TextItalicIcon, TrashIcon, XIcon,
} from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { NoteIllustration } from "./illustrations";
import { EmptyState, TextField } from "./ui";
import {
  STICKY_COLORS, createSticky, deleteSticky, fetchStickies, updateSticky,
  type PjSticky,
} from "./model";

/**
 * Le bloc-notes personnel.
 *
 * Extrait de la page d'accueil pour servir aussi de destination à part entière
 * dans la barre latérale : le même bloc rendu à deux endroits, pas deux
 * implémentations qui divergeront à la première correction.
 *
 * Les notes sont posées en COLONNES et non en grille. Une grille aligne les
 * hauteurs et laisse du blanc sous les notes courtes ; des colonnes laissent
 * chaque note faire sa taille, ce qui est le propre d'un mur de post-it — et ce
 * qui permet de voir d'un coup laquelle est longue.
 */
export function StickyBoard({
  dashboardId, workspaceId, showSearch = true,
}: {
  dashboardId: string;
  workspaceId: string;
  showSearch?: boolean;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [query, setQuery] = useState("");

  const { data: stickies } = useQuery({
    queryKey: ["pj_stickies", dashboardId],
    queryFn: () => fetchStickies(dashboardId),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_stickies", dashboardId] });

  const shown = useMemo(() => {
    const list = stickies ?? [];
    if (!query.trim()) return list;
    const q = query.toLowerCase();
    return list.filter((s) => s.content.toLowerCase().includes(q));
  }, [stickies, query]);

  const add = async () => {
    if (!user) return;
    await createSticky({
      workspaceId, dashboardId, userId: user.id,
      // La couleur tourne sur la palette : deux notes voisines de teintes
      // différentes se distinguent au coin de l'œil, ce qu'un mur uniforme ne
      // permet pas.
      color: STICKY_COLORS[(stickies?.length ?? 0) % STICKY_COLORS.length],
    });
    refresh();
  };

  return (
    <>
      {showSearch && (
        <div className="flex items-center gap-2 pb-3">
          <div className="relative w-44">
            <MagnifyingGlassIcon className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tertiary" />
            <TextField
              value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Filtrer" size="xs" className="pl-7"
            />
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={add}
            className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-12 font-medium text-primary-foreground hover:opacity-90"
          >
            <PlusIcon className="h-3.5 w-3.5" /> Ajouter une note
          </button>
        </div>
      )}

      {!shown.length ? (
        <EmptyState
          illustration={<NoteIllustration className="w-full" />}
          title={query ? "Aucune note ne correspond" : "Aucune note"}
          hint={query
            ? "Essayez un autre mot, ou effacez le filtre."
            : "Une note sert à ce qui n'a pas encore de place : un numéro, une idée, ce qu'il faut redire demain."}
          action={!query && (
            <button
              type="button"
              onClick={add}
              className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-12 font-medium text-primary-foreground hover:opacity-90"
            >
              <PlusIcon className="h-4 w-4" /> Ajouter une note
            </button>
          )}
        />
      ) : (
        <div className="columns-1 gap-4 sm:columns-2 lg:columns-3">
          {shown.map((s) => (
            <div key={s.id} className="mb-4 break-inside-avoid">
              <StickyNote sticky={s} onChanged={refresh} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Une note.
 *
 * Le fond est PLEIN, pas une teinte à 13 % sur le fond de page. C'est ce qui
 * fait qu'un mur de notes se lit comme des objets posés et non comme des
 * encadrés du même document — et c'est aussi ce qui rend la couleur utile pour
 * s'y retrouver.
 *
 * La barre du bas n'apparaît qu'au survol ou pendant la saisie : une note qu'on
 * relit ne doit montrer que son texte, et cinq boutons permanents sur une carte
 * de 200 px prennent plus de place que le contenu.
 */
export function StickyNote({ sticky, onChanged }: { sticky: PjSticky; onChanged: () => void }) {
  const [content, setContent] = useState(sticky.content);
  const area = useRef<HTMLTextAreaElement | null>(null);

  // La note grandit avec son texte : une lucarne qui défile obligerait à
  // faire défiler DANS un post-it, ce qui n'a pas de sens pour un objet qu'on
  // regarde justement d'un seul coup d'œil.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 220)}px`;
  }, [content]);

  const save = (patch: Partial<PjSticky>) => updateSticky(sticky.id, patch).then(onChanged);

  /** Encadre la sélection — ou insère les marques au curseur si rien n'est pris. */
  const wrap = (mark: string) => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b } = el;
    const next = `${content.slice(0, a)}${mark}${content.slice(a, b)}${mark}${content.slice(b)}`;
    setContent(next);
    save({ content: next });
    // On repositionne le curseur APRÈS le rendu : sans ça, React remet le
    // curseur en fin de champ et la frappe suivante atterrit au mauvais endroit.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + mark.length, b + mark.length);
    });
  };

  /** Ajoute une case à cocher en tête de la ligne courante. */
  const checklist = () => {
    const el = area.current;
    if (!el) return;
    const start = content.lastIndexOf("\n", Math.max(0, el.selectionStart - 1)) + 1;
    const next = `${content.slice(0, start)}[ ] ${content.slice(start)}`;
    setContent(next);
    save({ content: next });
  };

  return (
    <div
      className="group/sticky relative flex flex-col overflow-hidden rounded-lg"
      style={{ backgroundColor: sticky.color }}
    >
      {/* La poignée : elle ne fait rien tant que le glisser n'est pas branché,
          mais elle dit où l'on prendra la note — et c'est le repère qui manque
          le plus sur une carte sans bord. */}
      <span className="flex h-4 shrink-0 items-center justify-center pt-1.5 opacity-0 transition-opacity group-hover/sticky:opacity-60">
        <DotsSixIcon weight="bold" className="h-3.5 w-3.5 text-white" />
      </span>

      <textarea
        ref={area}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        // Enregistrement à la sortie du champ : une note se rédige d'un jet,
        // et écrire à chaque frappe multiplierait les requêtes sans rien
        // protéger de plus.
        onBlur={() => { if (content !== sticky.content) save({ content }); }}
        placeholder="Écrire…"
        className="min-h-[220px] w-full resize-none bg-transparent px-4 pb-2 pt-1 font-hand text-[22px] leading-snug text-white outline-none placeholder:text-white/50"
      />

      <div className="flex items-center gap-0.5 px-2.5 pb-2.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/sticky:opacity-100">
        <Popover>
          <PopoverTrigger asChild>
            <StickyAction title="Couleur"><PaletteIcon className="h-4 w-4" /></StickyAction>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2" align="start">
            <p className="pb-1.5 text-11 font-medium text-tertiary">Couleur de fond</p>
            <div className="flex gap-1.5">
              {STICKY_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => save({ color: c })}
                  className={cn(
                    "h-6 w-6 rounded-md transition-all hover:ring-2 hover:ring-primary",
                    c === sticky.color && "ring-2 ring-primary",
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <StickyAction title="Gras" onClick={() => wrap("**")}>
          <TextBIcon className="h-4 w-4" />
        </StickyAction>
        <StickyAction title="Italique" onClick={() => wrap("_")}>
          <TextItalicIcon className="h-4 w-4" />
        </StickyAction>
        <StickyAction title="Case à cocher" onClick={checklist}>
          <ListChecksIcon className="h-4 w-4" />
        </StickyAction>

        <div className="flex-1" />

        <StickyAction
          title="Supprimer"
          onClick={async () => { await deleteSticky(sticky.id); onChanged(); }}
        >
          <TrashIcon className="h-4 w-4" />
        </StickyAction>
      </div>
    </div>
  );
}

/**
 * Un bouton de la barre d'une note : blanc translucide, sur fond coloré.
 *
 * Il transmet sa ref et les propriétés qu'on lui passe, parce que le bouton de
 * couleur est la cible d'un Popover en `asChild` : sans cette transmission, le
 * déclencheur ne reçoit ni son gestionnaire de clic ni son ancre, et la palette
 * ne s'ouvre jamais — le bouton a l'air inerte alors qu'il est simplement
 * débranché.
 */
const StickyAction = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { title: string }
>(function StickyAction({ title, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/15 hover:text-white",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/**
 * Le mur de notes en pleine page, avec sa barre du haut.
 *
 * Le composant ci-dessus sert aussi de widget sur l'accueil ; c'est ici qu'on
 * ajoute ce qui n'a de sens qu'en page entière — le titre, la recherche qui se
 * déplie, et le bouton principal.
 */
export function StickiesPage({
  dashboardId, workspaceId,
}: { dashboardId: string; workspaceId: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [searching, setSearching] = useState(false);

  const { data: stickies } = useQuery({
    queryKey: ["pj_stickies", dashboardId],
    queryFn: () => fetchStickies(dashboardId),
  });

  const add = async () => {
    if (!user) return;
    await createSticky({
      workspaceId, dashboardId, userId: user.id,
      color: STICKY_COLORS[(stickies?.length ?? 0) % STICKY_COLORS.length],
    });
    qc.invalidateQueries({ queryKey: ["pj_stickies", dashboardId] });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
        <NoteGlyph />
        <h2 className="text-14 font-medium">Notes</h2>
        <div className="flex-1" />
        <button
          type="button"
          title={searching ? "Fermer la recherche" : "Rechercher"}
          onClick={() => setSearching((v) => !v)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-tertiary hover:bg-muted hover:text-foreground"
        >
          {searching ? <XIcon className="h-4 w-4" /> : <MagnifyingGlassIcon className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={add}
          className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-12 font-medium text-primary-foreground hover:opacity-90"
        >
          <PlusIcon className="h-4 w-4" /> Ajouter une note
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8">
        <StickyBoard dashboardId={dashboardId} workspaceId={workspaceId} showSearch={searching} />
      </div>
    </div>
  );
}

/** Le pictogramme du titre : une note cornée. */
function NoteGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-tertiary" aria-hidden>
      <path
        d="M2.5 2.5h11v7.5l-3.5 3.5h-7.5z"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
      />
      <path d="M13.5 10h-3.5v3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}
