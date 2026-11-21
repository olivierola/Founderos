import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlassIcon as Search, XIcon as X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { BLOCK_BY_KIND } from "./blocks";
import { hueOf } from "./look";
import { groupKinds, foldText } from "./block-groups";
import type { BlockKind } from "./context";

// La palette du canevas : choisir le bloc à poser.
//
// Trois choses la distinguent d'une simple liste :
// - les blocs sont rangés par FAMILLE, sous un intertitre qui reste visible
//   pendant le défilement — on sait toujours dans quel groupe on est ;
// - un champ de recherche a le focus dès l'ouverture : qui connaît le nom du
//   bloc le tape et valide, sans quitter le clavier ;
// - la palette se mesure avant de se placer. Une hauteur supposée la faisait
//   déborder du canevas, liste coupée à mi-ligne, dès qu'elle s'ouvrait bas.

const WIDTH = 288;
const MARGIN = 8;

export interface BlockPaletteProps {
  title: string;
  kinds: BlockKind[];
  /** Ceux qui, sur cet écran, s'accrochent à une étape au lieu de s'enchaîner. */
  attachable?: BlockKind[];
  /** Le coin haut-gauche souhaité, dans le repère du conteneur. */
  anchor: { x: number; y: number };
  /** La taille du conteneur, pour garder la palette dedans. */
  bounds: { width: number; height: number };
  onPick: (kind: BlockKind) => void;
  onClose: () => void;
}

export function BlockPalette({ title, kinds, attachable = [], anchor, bounds, onPick, onClose }: BlockPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number }>(() => ({
    left: anchor.x, top: anchor.y, maxH: 360,
  }));

  const groups = useMemo(() => {
    const q = foldText(query.trim());
    const all = groupKinds(kinds, attachable);
    if (!q) return all;
    return all
      .map((g) => ({
        ...g,
        kinds: g.kinds.filter((k) => {
          const def = BLOCK_BY_KIND.get(k);
          return !!def && (foldText(def.label).includes(q) || foldText(def.hint).includes(q) || foldText(g.label).includes(q));
        }),
      }))
      .filter((g) => g.kinds.length > 0);
  }, [kinds, attachable, query]);

  /** La liste à plat, dans l'ordre affiché : c'est elle que parcourent les
   *  flèches, d'un groupe à l'autre sans s'arrêter sur les intertitres. */
  const flat = useMemo(() => groups.flatMap((g) => g.kinds), [groups]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { input.current?.focus(); }, []);

  // Placer APRÈS avoir mesuré. La palette préfère s'ouvrir sous le point
  // demandé ; si la place manque en bas, elle remonte, et si elle manque des
  // deux côtés, c'est la liste qui raccourcit — jamais le bord qui la coupe.
  useLayoutEffect(() => {
    const el = box.current;
    const ls = list.current;
    if (!el || !ls) return;
    const left = Math.max(MARGIN, Math.min(anchor.x, bounds.width - WIDTH - MARGIN));
    const maxH = Math.max(200, Math.min(460, bounds.height - 2 * MARGIN));
    // La hauteur NATURELLE : le cadre, plus tout ce que la liste contient —
    // pas ce qu'elle montre déjà, qui dépend du plafond qu'on est en train de
    // calculer.
    const natural = el.offsetHeight - ls.clientHeight + ls.scrollHeight;
    const h = Math.min(natural, maxH);
    const top = Math.max(MARGIN, Math.min(anchor.y, bounds.height - h - MARGIN));
    setPos({ left, top, maxH });
    // Recalculé à l'ouverture et quand le canevas change de taille, pas à
    // chaque lettre tapée : une palette qui saute pendant qu'on écrit perd
    // le regard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.x, anchor.y, bounds.width, bounds.height]);

  // L'élément actif reste à l'écran quand on descend au clavier.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (!flat.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % flat.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + flat.length) % flat.length); }
    else if (e.key === "Enter") { e.preventDefault(); onPick(flat[Math.min(active, flat.length - 1)]); }
  };

  let idx = -1;
  return (
    <div
      ref={box}
      role="dialog" aria-label={title}
      className="absolute z-30 flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
      style={{ left: pos.left, top: pos.top, width: WIDTH, maxHeight: pos.maxH }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <div className="flex shrink-0 items-center justify-between px-3 pb-1.5 pt-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
        <button
          type="button" onClick={onClose} aria-label="Fermer"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      <div className="shrink-0 px-2 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un bloc…"
            className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/70"
            aria-label="Rechercher un bloc"
          />
        </label>
      </div>

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-border/60 pb-1.5">
        {groups.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">Aucun bloc ne correspond.</p>
        )}
        {groups.map((g, gi) => (
          <section key={g.id} className={cn(gi > 0 && "border-t border-border/40")}>
            <header className="sticky top-0 z-[1] bg-popover/95 px-3 pb-1 pt-2 backdrop-blur">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/80">{g.label}</span>
                <span className="text-[10px] tabular-nums text-muted-foreground/50">{g.kinds.length}</span>
              </div>
              {g.hint && <p className="text-[10.5px] leading-tight text-muted-foreground/60">{g.hint}</p>}
            </header>
            <div className="px-1.5">
              {g.kinds.map((k) => {
                const def = BLOCK_BY_KIND.get(k);
                if (!def) return null;
                idx += 1;
                const i = idx;
                const Icon = def.icon;
                const hue = hueOf(k);
                const on = i === active;
                return (
                  <button
                    key={k} type="button" data-idx={i}
                    onClick={() => onPick(k)}
                    onMouseMove={() => { if (!on) setActive(i); }}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                      on ? "bg-muted" : "hover:bg-muted/60",
                    )}
                  >
                    <span
                      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                      style={{ background: `${hue}22`, color: hue, boxShadow: `inset 0 0 0 1px ${hue}33` }}
                    >
                      <Icon className="h-3.5 w-3.5" weight="bold" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] font-medium leading-tight">{def.label}</span>
                      <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted-foreground">{def.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground/70">
        <span><Kbd>↑</Kbd><Kbd>↓</Kbd> naviguer</span>
        <span><Kbd>⏎</Kbd> ajouter</span>
        <span><Kbd>Échap</Kbd> fermer</span>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mr-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded border border-border/70 bg-muted/50 px-1 font-sans text-[9.5px]">
      {children}
    </kbd>
  );
}
