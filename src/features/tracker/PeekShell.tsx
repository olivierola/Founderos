import { useEffect, useState } from "react";
import {
  ArrowsInSimpleIcon, ArrowsOutSimpleIcon, CaretDownIcon, CheckIcon,
  CornersOutIcon, SidebarSimpleIcon, XIcon,
} from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * L'enveloppe de la fiche d'un work item, dans ses trois tailles.
 *
 * Les modes viennent de Plane et répondent à trois usages distincts :
 *
 *   · `side-peek`   — la moitié droite. On garde la LISTE visible : c'est le
 *                     mode du tri, où l'on ouvre, décide, ferme, enchaîne.
 *   · `modal`       — cinq sixièmes, centré. La liste passe derrière un voile :
 *                     c'est le mode de la lecture, quand il faut se concentrer
 *                     sur un item sans le quitter du regard.
 *   · `full-screen` — tout l'écran. C'est le mode de l'ÉCRITURE : une
 *                     description longue, des tableaux, des blocs de code
 *                     méritent la largeur d'une page.
 *
 * Le choix est retenu par navigateur. Quelqu'un qui trie toute la journée ne
 * doit pas rebasculer en side-peek à chaque ouverture, et l'inverse vaut pour
 * qui rédige des specs.
 */

export type PeekMode = "side-peek" | "modal" | "full-screen";

const MODES: { key: PeekMode; label: string; hint: string; icon: typeof SidebarSimpleIcon }[] = [
  { key: "side-peek", label: "Panneau", hint: "La liste reste visible", icon: SidebarSimpleIcon },
  { key: "modal", label: "Fenêtre", hint: "Centré, la liste derrière", icon: ArrowsInSimpleIcon },
  { key: "full-screen", label: "Plein écran", hint: "Toute la largeur", icon: CornersOutIcon },
];

const STORAGE_KEY = "pj-peek-mode";

export function usePeekMode() {
  const [mode, setMode] = useState<PeekMode>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as PeekMode | null;
      return saved && MODES.some((m) => m.key === saved) ? saved : "side-peek";
    } catch {
      // Navigation privée, stockage bloqué : le défaut fait l'affaire.
      return "side-peek";
    }
  });

  const change = (next: PeekMode) => {
    setMode(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* idem */ }
  };

  return [mode, change] as const;
}

export function PeekShell({
  mode, onMode, onClose, header, actions, children,
}: {
  mode: PeekMode;
  onMode: (m: PeekMode) => void;
  onClose: () => void;
  /** Le contenu de la barre du haut, à gauche des contrôles de taille. */
  header?: React.ReactNode;
  /** Les actions propres au contenu, posées avant les contrôles de taille. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  // Échap ferme, quel que soit le mode. C'est le seul geste commun aux trois,
  // et l'attendre est un réflexe qu'on ne veut pas décevoir.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement;
      const typing = el instanceof HTMLElement
        && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-30">
      {/* Le voile n'apparaît PAS en side-peek : ce mode existe pour garder la
          liste lisible, et l'assombrir irait contre son seul intérêt. */}
      {mode !== "side-peek" && (
        <div
          className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
          onClick={onClose}
          aria-hidden
        />
      )}

      <div
        role="dialog"
        aria-modal={mode !== "side-peek"}
        className={cn(
          "absolute flex flex-col overflow-hidden bg-card shadow-overlay-200 transition-all duration-300",
          mode === "side-peek" && "inset-y-0 right-0 w-full border-l border-border md:w-1/2",
          mode === "modal" && "inset-[8.33%] rounded-xl border border-border",
          mode === "full-screen" && "inset-3 rounded-xl border border-border",
        )}
      >
        <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-3">
          {header}
          <div className="flex-1" />
          {actions}

          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                title="Taille de la fiche"
                className="flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {(() => {
                  const Icon = MODES.find((m) => m.key === mode)!.icon;
                  return <Icon className="h-4 w-4" />;
                })()}
                <CaretDownIcon className="h-3 w-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="end">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => onMode(m.key)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                    mode === m.key ? "bg-muted" : "hover:bg-muted",
                  )}
                >
                  <m.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-12 font-medium">{m.label}</span>
                    <span className="block text-10 text-muted-foreground">{m.hint}</span>
                  </span>
                  {mode === m.key && <CheckIcon className="h-3.5 w-3.5 shrink-0" />}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Bascule directe vers le plein écran : c'est le saut le plus
              fréquent — on ouvre pour lire, on agrandit pour écrire — et le
              faire passer par un menu à trois entrées est un geste de trop. */}
          <button
            type="button"
            title={mode === "full-screen" ? "Réduire" : "Plein écran"}
            onClick={() => onMode(mode === "full-screen" ? "side-peek" : "full-screen")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {mode === "full-screen"
              ? <ArrowsInSimpleIcon className="h-4 w-4" />
              : <ArrowsOutSimpleIcon className="h-4 w-4" />}
          </button>

          <button
            type="button"
            title="Fermer (Échap)"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        {/* En plein écran, la fiche adopte une largeur de lecture centrée : une
            description étalée sur 1 800 pixels devient illisible, la ligne
            étant trop longue pour que l'œil retrouve la suivante. */}
        <div className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          mode === "full-screen" && "px-[max(1rem,calc((100%-1100px)/2))]",
        )}>
          {children}
        </div>
      </div>
    </div>
  );
}
