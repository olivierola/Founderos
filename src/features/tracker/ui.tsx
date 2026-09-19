import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Les primitives du module de suivi.
 *
 * Elles existent pour une raison mesurable : les en-têtes du module avaient
 * trois hauteurs différentes (py-2, py-2.5, py-3) selon l'écran. Sur des pages
 * qu'on enchaîne — Home, puis Work items, puis Cycles — un décalage de quatre
 * pixels fait sauter tout le contenu à chaque navigation. Personne ne sait
 * nommer ce qui gêne, mais tout le monde le sent.
 *
 * La hauteur est donc figée par un jeton (`--height-header`, 3.25rem, valeur de
 * Plane) et non par du padding : le padding dépend du contenu, la hauteur non.
 */

// ── En-tête ─────────────────────────────────────────────────────────────────

export function PageHeader({
  icon, title, subtitle, breadcrumb, actions, className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  /** Le second cran du fil d'Ariane, après un chevron. */
  breadcrumb?: ReactNode;
  /** Une phrase sous le titre. Rare : la plupart des écrans se passent d'une
   *  explication, et celles qui en ont une la mettent dans le corps. */
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex h-header shrink-0 items-center gap-2 border-b border-border px-4",
        className,
      )}
    >
      {icon && <span className="flex shrink-0 text-muted-foreground">{icon}</span>}
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="truncate text-14 font-medium">{title}</h2>
        {subtitle && (
          <span className="hidden truncate text-11 text-muted-foreground sm:block">
            {subtitle}
          </span>
        )}
      </div>
      {breadcrumb}
      <div className="flex-1" />
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}

// ── Surfaces ────────────────────────────────────────────────────────────────

/**
 * La carte du module. Elle porte l'ombre `raised-100` — 3 % d'opacité — et non
 * une ombre franche : une carte est POSÉE sur la page, elle n'en décolle pas.
 * Ce qui décolle (menu, dialogue) prend `overlay`.
 */
export const Card = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & {
  interactive?: boolean;
}>(({ className, interactive, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-lg border border-border/70 bg-card shadow-raised-100",
      interactive && "transition-colors hover:border-border hover:bg-muted/30",
      className,
    )}
    {...props}
  />
));
Card.displayName = "TrackerCard";

/** Le titre d'une section dans le corps d'une page, avec son action à droite. */
export function SectionTitle({
  children, hint, action,
}: { children: ReactNode; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pb-2">
      <h3 className="text-13 font-medium">{children}</h3>
      {hint && <span className="text-11 text-muted-foreground">{hint}</span>}
      <div className="flex-1" />
      {action}
    </div>
  );
}

/**
 * L'état vide.
 *
 * Il dit ce qu'on peut FAIRE, pas seulement qu'il n'y a rien : « Aucun cycle »
 * laisse l'utilisateur devant une impasse, « Aucun cycle — un cycle borne une
 * itération dans le temps » lui apprend à quoi sert l'écran où il vient
 * d'atterrir. C'est le seul moment où l'interface a l'attention de quelqu'un
 * qui ne sait pas encore s'en servir.
 */
export function EmptyState({
  icon, illustration, title, hint, action, secondaryAction, className, compact,
}: {
  /** Un pictogramme, pour les états vides posés dans une carte étroite. */
  icon?: ReactNode;
  /** Une illustration, pour les états vides qui occupent une page entière. */
  illustration?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
  /** Sans carte ni bordure : pour un état vide à l'intérieur d'un widget. */
  compact?: boolean;
}) {
  // Dans un widget étroit, l'état vide est une petite boîte bordée avec un
  // pictogramme : il doit tenir dans la carte qui l'accueille sans la faire
  // grandir.
  if (compact) {
    return (
      <div className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-md border border-border p-10 text-center",
        className,
      )}>
        <div className="flex flex-col items-center gap-2">
          {icon && (
            <span className="flex h-8 w-8 items-center justify-center rounded bg-muted text-tertiary">
              {icon}
            </span>
          )}
          <span className="text-13 font-medium">{title}</span>
          {hint && <span className="text-11 text-tertiary">{hint}</span>}
        </div>
        {(action || secondaryAction) && (
          <div className="flex items-center gap-2">
            {action}
            {secondaryAction}
          </div>
        )}
      </div>
    );
  }

  // Sur une page entière, PAS de carte : l'illustration, le titre, la phrase,
  // et rien autour. Un cadre au milieu du vide se lit comme un bloc qui n'a
  // pas chargé ; sans cadre, le vide devient l'écran lui-même — ce qu'il est.
  return (
    // Le centrage ne peut pas reposer sur `h-full` seul : dans un conteneur
    // dont la hauteur suit son contenu — et c'est le cas de la plupart des
    // pages, qui empilent un en-tête puis une zone défilante — `h-full` vaut
    // la hauteur du bloc lui-même, donc l'état vide se colle en haut au lieu
    // de tenir le milieu de l'écran. Le plancher en `min-h` lui donne de quoi
    // se centrer dans tous les cas, et `flex-1` le fait remplir la place
    // disponible quand le parent lui en offre.
    <div className={cn(
      "flex min-h-[60vh] w-full flex-1 flex-col items-center justify-center p-6",
      className,
    )}>
      <div className="flex max-w-md flex-col items-center gap-2.5 text-center">
        {illustration ? (
          <div className="w-full max-w-[200px]">{illustration}</div>
        ) : icon ? (
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-tertiary">
            {icon}
          </span>
        ) : null}

        {/* Le titre porte seul : c'est le seul texte de la page, il n'a rien
            contre quoi se hiérarchiser. */}
        <p className="text-16 font-medium">{title}</p>

        {hint && <p className="text-14 font-medium text-placeholder">{hint}</p>}

        {(action || secondaryAction) && (
          <div className="flex items-center gap-2 pt-2">
            {action}
            {secondaryAction}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Contrôles ───────────────────────────────────────────────────────────────

/**
 * Le groupe de segments (Ouvertes/Traitées, Graph/Table, En cours/En retard).
 *
 * Un seul composant pour les six endroits où le motif apparaissait, chacun
 * avec ses propres classes : c'est ainsi qu'un module finit avec six boutons
 * qui font la même chose et se ressemblent à peu près.
 */
export function SegmentedControl<T extends string>({
  value, onChange, options, className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { key: T; label: ReactNode; count?: number; tone?: "warn" }[];
  className?: string;
}) {
  return (
    <div className={cn("flex h-7 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5", className)}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            aria-pressed={on}
            className={cn(
              "flex items-center gap-1.5 flex h-full items-center rounded px-2.5 text-12 transition-colors",
              on ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span className={cn(
                "tabular-nums",
                o.tone === "warn" && o.count > 0 ? "text-amber-600" : "text-muted-foreground",
              )}>
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * LES onglets du module — un seul style, partout.
 *
 * Deux styles concurrents (rail segmenté ici, soulignement là) obligeaient à
 * réapprendre où l'on se trouve à chaque écran. Le rail creux s'impose parce
 * qu'il rend l'état actif lisible SANS dépendre du contraste des fonds : le
 * soulignement disparaît sous un tableau dense, la pastille non.
 */
export function Tabs<T extends string>({
  value, onChange, options, className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { key: T; label: string; count?: number }[];
  className?: string;
}) {
  return (
    <nav
      role="tablist"
      className={cn(
        // Le rail est un creux : un fond plus SOMBRE que la page, pas plus
        // clair. C'est ce qui fait que la pastille active paraît posée dessus
        // au lieu d'être découpée dedans.
        'inline-flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5',
        className,
      )}
    >
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.key)}
            className={cn(
              'flex h-6 items-center gap-1.5 rounded-md px-2.5 text-12 transition-all',
              on
                // Trois signaux pour l'état actif — fond, bordure, graisse —
                // parce qu'aucun ne suffit seul : le fond disparaît sur un
                // écran peu contrasté, la bordure seule fait bouton inactif, et
                // la graisse seule se remarque à peine sur du 13.
                ? 'border border-border bg-card font-medium text-foreground shadow-raised-100'
                : 'border border-transparent text-tertiary hover:text-foreground',
            )}
          >
            {o.label}
            {o.count !== undefined && o.count > 0 && (
              <span className={cn('text-11 tabular-nums', on ? 'text-tertiary' : 'opacity-70')}>
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** Un bouton d'icône de barre d'outils : même gabarit partout, 32 px de haut,
 *  pour que les rangées s'alignent avec les boutons et les champs. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { bordered?: boolean; active?: boolean }
>(({ className, bordered, active, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
      "hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
      bordered && "border border-border",
      active && "bg-muted text-foreground",
      className,
    )}
    {...props}
  />
));
IconButton.displayName = "TrackerIconButton";

/** Le compteur discret posé à côté d'un titre (« Work items 112 »). */
export function CountBadge({ n, tone }: { n: number; tone?: "warn" }) {
  return (
    <Badge tone={tone === "warn" && n > 0 ? "warn" : "neutral"} className="tabular-nums">
      {n}
    </Badge>
  );
}

/**
 * LE badge du module — un seul gabarit pour tous les usages.
 *
 * Ils avaient dérivé : certains en `text-10 px-1.5`, d'autres en `text-11 px-2`,
 * d'autres encore en `rounded-full` contre `rounded`. Sur une même ligne — une
 * puce d'état, une de santé, un compteur — trois hauteurs différentes cassent
 * l'alignement vertical, et l'œil lit un défaut avant de lire l'information.
 *
 * Deux formes seulement :
 *   · `pill`  — un STATUT (santé, phase de cycle, état d'intake). Le rond
 *               marque quelque chose qui change dans le temps.
 *   · `chip`  — un ATTRIBUT (label, priorité, date). Le coin court marque
 *               quelque chose qu'on a posé et qui reste.
 *
 * La distinction n'est pas décorative : elle laisse deviner, sans lire, si le
 * badge dit un état ou une propriété.
 */
const BADGE_TONES = {
  neutral: "bg-muted text-muted-foreground",
  outline: "border border-border/70 text-foreground",
  primary: "bg-primary/15 text-primary",
  warn: "bg-amber-500/15 text-amber-600",
  danger: "bg-red-500/15 text-red-600",
  success: "bg-emerald-500/15 text-emerald-600",
} as const;

export function Badge({
  children, tone = "neutral", shape = "chip", className, style,
}: {
  children: ReactNode;
  tone?: keyof typeof BADGE_TONES;
  shape?: "chip" | "pill";
  className?: string;
  /** Pour les couleurs venues des données (label, état, santé), qu'aucune
   *  palette figée ne peut couvrir. */
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={style}
      className={cn(
        // Hauteur fixe : c'est elle qui garantit l'alignement quand plusieurs
        // badges se suivent, pas le padding vertical, qui varie avec la police.
        "inline-flex h-5 shrink-0 items-center gap-1.5 px-2 text-11 font-medium leading-none",
        shape === "pill" ? "rounded-full" : "rounded-md",
        !style && BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** La pastille colorée d'un badge (état, label, santé). 6 px : assez pour se
 *  voir, assez peu pour ne pas concurrencer le texte qu'elle qualifie. */
export function Dot({ color }: { color: string }) {
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />;
}


// ── Champs de saisie ────────────────────────────────────────────────────────

/**
 * Les champs du module, à la place de ceux du design system.
 *
 * Les composants système sont taillés pour les formulaires du SaaS : hauteur de
 * 40 px, texte de 14, anneau de focus épais. Posés dans un panneau de propriétés
 * ou une modale du suivi — où une ligne côtoie huit pastilles de 28 px — ils
 * cassent le rythme et font passer un champ pour une section.
 *
 * Ceux-ci reprennent les crans de Plane : 13 px de texte, un demi-pixel de
 * bordure, un fond légèrement en retrait du fond de carte. Le focus se marque
 * par la BORDURE et non par un halo, parce que dans une pile de champs serrés
 * un halo déborde sur le voisin.
 */

type FieldSize = "xs" | "sm" | "md";

const FIELD_SIZE: Record<FieldSize, string> = {
  xs: "px-1.5 py-1 text-12",
  sm: "px-3 py-2 text-13",
  md: "p-3 text-13",
};

/** `transparent` : sans cadre, pour un titre qui s'édite sur place. */
type FieldMode = "primary" | "transparent";

const FIELD_BASE =
  "w-full rounded-md outline-none transition-colors placeholder:text-placeholder disabled:cursor-not-allowed disabled:opacity-60";

function fieldClasses(mode: FieldMode, size: FieldSize, hasError: boolean, className?: string) {
  return cn(
    FIELD_BASE,
    FIELD_SIZE[size],
    mode === "primary" && "border-[0.5px] border-border bg-muted/30 focus:border-primary/50",
    mode === "transparent" && "border-none bg-transparent px-0",
    hasError && "border-destructive focus:border-destructive",
    className,
  );
}

export interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  mode?: FieldMode;
  size?: FieldSize;
  hasError?: boolean;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { mode = "primary", size = "sm", hasError = false, className, autoComplete = "off", ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      autoComplete={autoComplete}
      className={fieldClasses(mode, size, hasError, className)}
      {...rest}
    />
  );
});

export interface TextAreaFieldProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  mode?: FieldMode;
  size?: FieldSize;
  hasError?: boolean;
  /** Grandit avec le contenu, au lieu de faire défiler dans une lucarne. */
  autoResize?: boolean;
}

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(function TextAreaField(
  { mode = "primary", size = "sm", hasError = false, autoResize = false, className, value, ...rest },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement | null>(null);

  // On remet la hauteur à zéro avant de la relire : sans ça `scrollHeight`
  // renvoie la hauteur actuelle et le champ ne rétrécit jamais quand on efface.
  useEffect(() => {
    if (!autoResize) return;
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [autoResize, value]);

  return (
    <textarea
      ref={(node) => {
        inner.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
      }}
      value={value}
      className={cn(
        fieldClasses(mode, size, hasError, className),
        autoResize && "resize-none overflow-hidden",
      )}
      {...rest}
    />
  );
});

// ── Sélecteur ───────────────────────────────────────────────────────────────

/**
 * Le sélecteur du module, à la place du `<select>` natif.
 *
 * Un `<select>` natif ouvre la liste déroulante du SYSTÈME : fond bleu vif,
 * texte au corps du navigateur, coins carrés. Elle ne suit ni le thème, ni le
 * mode sombre, ni les tokens — et posée dans un menu à fond clair, elle donne
 * exactement l'effet d'une boîte de dialogue d'un autre logiciel qui se serait
 * ouverte par erreur.
 *
 * Celui-ci rend la même chose avec les surfaces du produit : la liste est un
 * popover, la sélection se marque par une coche et non par une bande colorée,
 * et le tout reste navigable au clavier — c'est ce que Radix apporte, et la
 * raison de ne pas dessiner une liste à la main.
 */
export function Select<T extends string>({
  value, onChange, options, placeholder = "Choisir…", className, size = "sm", disabled,
}: {
  value: T | null;
  onChange: (v: T) => void;
  options: { key: T; label: string; hint?: string }[];
  placeholder?: string;
  className?: string;
  size?: "xs" | "sm";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.key === value) ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-md border-[0.5px] border-border bg-muted/30 text-left transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60",
            size === "xs" ? "h-7 px-2 text-12" : "h-8 px-2.5 text-13",
            className,
          )}
        >
          <span className={cn("min-w-0 flex-1 truncate", !current && "text-placeholder")}>
            {current?.label ?? placeholder}
          </span>
          <CaretDownIcon className="h-3 w-3 shrink-0 text-tertiary" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        className="p-1"
        align="start"
        // La liste fait au moins la largeur du bouton : plus étroite, elle
        // paraîtrait détachée de lui ; à largeur fixe, elle tronquerait des
        // libellés que le bouton affiche en entier.
        style={{ width: "var(--radix-popover-trigger-width)", minWidth: "12rem" }}
      >
        <div className="max-h-64 overflow-y-auto">
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => { onChange(o.key); setOpen(false); }}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-12",
                o.key === value ? "bg-muted font-medium" : "hover:bg-muted",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{o.label}</span>
                {o.hint && <span className="block text-10 text-tertiary">{o.hint}</span>}
              </span>
              {o.key === value && <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Case à cocher ───────────────────────────────────────────────────────────

/**
 * La case à cocher du module.
 *
 * La native est dessinée par le système d'exploitation : sa taille, son bleu et
 * ses coins ne se règlent pas, et elle jure avec tout ce qui l'entoure — c'est
 * particulièrement visible dans un menu, où elle côtoie des libellés au corps
 * du produit.
 *
 * Le libellé fait partie de la CIBLE : cocher en cliquant le texte est le geste
 * naturel, et une case de 16 px seule est en dessous de toute règle de taille
 * de cible raisonnable.
 */
export function Checkbox({
  checked, onChange, label, hint, className, disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    >
      <span
        className={cn(
          "mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-transparent",
        )}
      >
        {checked && <CheckIcon weight="bold" className="h-3 w-3" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-12 leading-snug">{label}</span>
        {hint && <span className="block text-10 leading-snug text-tertiary">{hint}</span>}
      </span>
    </button>
  );
}

// ── Pastille de propriété ───────────────────────────────────────────────────

/**
 * La pastille d'un réglage à bascule (les propriétés du menu Affichage).
 *
 * Discrète et petite, exprès. Ce sont douze bascules côte à côte : au gabarit
 * d'un bouton, elles forment un pavé qui pèse plus lourd que le reste du menu
 * alors qu'on n'y touche presque jamais. L'état actif se marque par un FOND
 * teinté et non par une bordure épaisse — une bordure sur douze pastilles
 * dessine une grille, un fond ne dessine rien.
 */
export function Chip({
  active, onClick, children, className,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-6 items-center rounded-md px-2 text-11 transition-colors",
        active
          ? "bg-primary/12 font-medium text-primary"
          : "bg-muted/50 text-tertiary hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

// ── Modale ──────────────────────────────────────────────────────────────────

/**
 * L'enveloppe des modales du module.
 *
 * Elle existe parce que les huit modales du module se réglaient chacune à la
 * main : padding, taille du titre, séparation du pied. Résultat, un « Créer »
 * à un endroit et un « Créer » à un autre n'avaient ni la même hauteur ni la
 * même distance au bord, et l'ensemble donnait l'impression de huit dialogues
 * empruntés à huit produits.
 *
 * Trois partis pris.
 *
 *   · LE PIED EST SÉPARÉ PAR UN FILET et posé sur un fond très légèrement en
 *     retrait. C'est ce qui distingue « ce qu'on saisit » de « ce qu'on
 *     décide » ; des boutons flottant à la suite du dernier champ se lisent
 *     comme un champ de plus.
 *   · LE TITRE EST EN 16, PAS EN 18. Une modale de 480 px n'a pas besoin d'un
 *     titre de page — il n'a rien contre quoi se hiérarchiser, et plus il est
 *     gros plus il pèse dans un espace qui est déjà contraint.
 *   · L'ACTION PRINCIPALE EST À DROITE, l'annulation en fantôme à sa gauche.
 *     Leur donner le même poids visuel ferait hésiter à chaque fois.
 */
export function Modal({
  open, onClose, title, description, children, footer, size = "md", busy,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Une phrase sous le titre. Rare : la plupart des modales n'en ont pas besoin. */
  description?: string;
  children: ReactNode;
  /** Les boutons du pied. Sans eux, pas de pied du tout. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Empêche la fermeture pendant une écriture en cours. */
  busy?: boolean;
}) {
  const width = size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-md";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !busy) onClose(); }}>
      <DialogContent className={cn("gap-0 overflow-hidden p-0", width)}>
        <DialogHeader className="space-y-0.5 px-5 pb-3 pt-5 text-left">
          <DialogTitle className="text-16 font-medium">{title}</DialogTitle>
          {description && (
            <p className="text-12 leading-snug text-tertiary">{description}</p>
          )}
        </DialogHeader>

        <div className="max-h-[70vh] space-y-3 overflow-y-auto px-5 pb-5">
          {children}
        </div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
            {footer}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * La marque cochée SEULE, sans interaction propre.
 *
 * Elle sert dans les listes de commandes, où c'est la ligne entière qui bascule
 * la valeur : mettre une vraie case à cocher dedans donnerait deux cibles
 * imbriquées, dont une qui n'a pas le droit de réagir. La distinction est
 * volontaire — `Checkbox` se clique, `CheckMark` se lit.
 */
export function CheckMark({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-transparent",
        className,
      )}
    >
      {checked && <CheckIcon weight="bold" className="h-3 w-3" />}
    </span>
  );
}

// ── Interrupteur ────────────────────────────────────────────────────────────

/**
 * L'interrupteur, à distinguer de la case à cocher.
 *
 * La distinction n'est pas cosmétique. Une CASE enregistre un choix qu'on
 * validera plus tard — elle appartient à un formulaire. Un INTERRUPTEUR coupe
 * ou rétablit un comportement, immédiatement et sans confirmation. Employer
 * l'un pour l'autre trompe sur le moment où l'effet se produit, ce qui est la
 * seule chose qu'on ait besoin de savoir avant de cliquer.
 */
export function Switch({
  checked, onChange, label, className, disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Annoncé aux lecteurs d'écran ; l'intitulé visible est porté par la ligne. */
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        checked ? "bg-primary" : "bg-muted-foreground/30",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-raised-100 transition-all",
          checked ? "left-[1.125rem]" : "left-0.5",
        )}
      />
    </button>
  );
}
