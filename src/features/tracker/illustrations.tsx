/**
 * Les illustrations des états vides, en isométrie.
 *
 * Dessinées en SVG plutôt que chargées en image, pour trois raisons qui tiennent
 * toutes au même point — l'illustration doit APPARTENIR à l'interface :
 *
 *   · elle suit le thème. Les traits reprennent `--border` et `--muted` : une
 *     image figée serait claire sur fond sombre, ou l'inverse.
 *   · elle ne clignote pas. Un fichier chargé après la page fait sauter le bloc
 *     au moment précis où l'utilisateur lit qu'il n'y a rien.
 *   · elle pèse zéro requête.
 *
 * Toutes partagent la même mise en scène : un SOCLE de dalles empilées, un
 * objet qui flotte au-dessus, son reflet dessous. C'est ce qui les fait lire
 * comme une famille plutôt que comme neuf dessins sans rapport — et ce qui
 * permet de reconnaître un état vide avant même d'avoir lu le titre.
 *
 * L'objet, lui, montre la STRUCTURE de ce qui manque : un cycle est un anneau,
 * une page a des lignes, un module est un volume. C'est ce qui apprend à quoi
 * sert l'écran à quelqu'un qui vient d'y atterrir, là où un pictogramme
 * générique ne dit rien de plus que « vide ».
 */

type Props = { className?: string };

/**
 * La projection isométrique : un carré du plan devient un losange à 30°.
 *
 * C'est la matrice standard (cos 30° = 0,866, sin 30° = 0,5). Tout ce qui est
 * posé « au sol » passe par elle ; ce qui doit monter est simplement décalé
 * vers le haut EN PIXELS, après projection — c'est ainsi qu'on obtient une
 * hauteur qui ne se déforme pas avec la profondeur.
 */
const ISO = "matrix(0.866, 0.5, -0.866, 0.5, 120, 96)";

// Le cadre déborde de 34 px vers le HAUT.
//
// Les objets flottants montent au-dessus du socle : une plaque dressée culmine
// à une cinquantaine de pixels de son point d'appui, et la pastille flotte plus
// haut encore. Avec un cadre calé sur zéro, les deux se faisaient couper net —
// et une illustration tronquée se lit comme un défaut de chargement, ce qui est
// exactement le contraire de ce qu'un état vide doit dire.
const BOX = "0 -34 240 234";

const LINE = "hsl(var(--border))";
const SLAB = "hsl(var(--muted))";
const SHADE = "hsl(var(--muted-foreground))";

/** Une dalle du socle : sa tranche, puis sa face du dessus. */
function Slab({ y, size, depth }: { y: number; size: number; depth: number }) {
  // La tranche est obtenue en répétant la face vers le bas. Trois copies
  // suffisent à la rendre pleine, et le procédé garde les coins arrondis —
  // qu'un vrai volume extrudé obligerait à recalculer à la main.
  const half = size / 2;
  return (
    <g transform={`translate(0, ${y})`}>
      {[depth, depth * 0.66, depth * 0.33].map((d) => (
        <g key={d} transform={`translate(0, ${d})`}>
          <g transform={ISO}>
            <rect x={-half} y={-half} width={size} height={size} rx="14" fill={SHADE} opacity="0.22" />
          </g>
        </g>
      ))}
      <g transform={ISO}>
        <rect x={-half} y={-half} width={size} height={size} rx="14" fill={SLAB} />
        <rect
          x={-half} y={-half} width={size} height={size} rx="14"
          fill="none" stroke={LINE} strokeWidth="1.2"
        />
      </g>
    </g>
  );
}

/**
 * La scène : deux dalles, l'objet, le reflet.
 *
 * Le reflet n'est pas un ornement. Sans lui, l'objet flotte sans support
 * visuel et la composition paraît décollée du bas du cadre ; avec lui, le
 * regard se pose et le vide autour devient du calme plutôt qu'un manque.
 */
function IsoScene({ className, children }: Props & { children: React.ReactNode }) {
  // Un identifiant par instance : deux illustrations sur la même page
  // partageraient sinon le même masque, et la seconde effacerait la première.
  const id = `iso-${Math.random().toString(36).slice(2, 9)}`;

  const scene = (
    <>
      <Slab y={26} size={124} depth={10} />
      <Slab y={8} size={124} depth={10} />
      <g transform="translate(0, -34)">{children}</g>
    </>
  );

  return (
    <svg viewBox={BOX} className={className} role="presentation">
      <defs>
        <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="white" stopOpacity="0.5" />
          <stop offset="0.7" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <mask id={`${id}-mask`}>
          <rect x="0" y="-34" width="240" height="234" fill={`url(#${id}-fade)`} />
        </mask>
      </defs>

      {/* Le reflet : la scène retournée sous le socle, puis effacée en
          descendant. Il est dessiné AVANT, donc passe dessous. */}
      <g transform="translate(0, 268) scale(1, -1)" mask={`url(#${id}-mask)`} opacity="0.5">
        {scene}
      </g>

      {scene}
    </svg>
  );
}

/** Un trait de l'objet flottant : jamais rempli, toujours en contour. */
const stroke = {
  fill: "hsl(var(--card))",
  stroke: LINE,
  strokeWidth: 1.6,
  strokeLinejoin: "round" as const,
};

/**
 * Une plaque dressée : un rectangle vu de face, en perspective isométrique.
 * C'est la brique de la plupart des objets — une carte, une page, un panneau.
 */
function Plate({
  x = 0, y = 0, w = 44, h = 44, r = 8, opacity = 1,
}: { x?: number; y?: number; w?: number; h?: number; r?: number; opacity?: number }) {
  // Dressée sur son arête : on incline le rectangle à 30° et on le laisse
  // debout, au lieu de le coucher au sol comme les dalles.
  return (
    <g transform={`translate(${x}, ${y}) matrix(0.866, 0.5, 0, 1, 120, 96)`} opacity={opacity}>
      <rect x={-w / 2} y={-h} width={w} height={h} rx={r} {...stroke} />
    </g>
  );
}

/** Le jeton qui flotte à côté : un petit disque en biais. */
function Coin({ x, y, size = 12 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x}, ${y})`}>
      <ellipse cx="0" cy="0" rx={size} ry={size * 0.58} {...stroke} />
      <ellipse cx="0" cy="0" rx={size * 0.42} ry={size * 0.24} fill="none" stroke={LINE} strokeWidth="1.2" />
    </g>
  );
}

/** La pastille qui flotte de l'autre côté : une gélule posée à plat. */
function Chip({ x, y, children }: { x: number; y: number; children?: React.ReactNode }) {
  return (
    <g transform={`translate(${x}, ${y}) matrix(0.866, 0.5, -0.866, 0.5, 0, 0)`}>
      <rect x="-22" y="-9" width="44" height="18" rx="9" {...stroke} />
      {children}
    </g>
  );
}

// ── Les neuf scènes ────────────────────────────────────────────────────────

/** Un board : trois plaques dressées, décalées comme des colonnes. */
export function BoardIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={62} y={44} size={10} />
      <Chip x={176} y={28} />
      <Plate x={-30} y={6} w={40} h={46} opacity={0.55} />
      <Plate x={-10} y={0} w={40} h={46} opacity={0.8} />
      <Plate x={12} y={-6} w={40} h={46} />
    </IsoScene>
  );
}

/** Un cycle : un anneau posé à plat, l'itération qui tourne. */
export function CycleIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={64} y={40} size={9} />
      <Chip x={174} y={26} />
      <g transform="translate(120, 96)">
        <ellipse cx="0" cy="6" rx="46" ry="27" fill={SHADE} opacity="0.12" />
        <ellipse cx="0" cy="0" rx="46" ry="27" {...stroke} />
        <ellipse cx="0" cy="0" rx="22" ry="13" fill={SHADE} opacity="0.18" stroke={LINE} strokeWidth="1.4" />
        {/* Le quart parcouru : ce qui distingue un anneau d'un cycle, c'est
            qu'une part en est déjà faite. */}
        <path
          d="M 46 0 A 46 27 0 0 0 0 -27"
          fill="none" stroke="hsl(var(--primary))" strokeWidth="3" strokeLinecap="round"
          opacity="0.8"
        />
      </g>
    </IsoScene>
  );
}

/** Un module : un volume plein, le lot de travail qui a une épaisseur. */
export function ModuleIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={62} y={46} size={10} />
      <Chip x={176} y={30} />
      {/* Trois plaques serrées, vues comme un bloc : un module est un paquet
          de work items, pas un objet unique. */}
      <Plate x={-16} y={4} w={54} h={40} r={7} opacity={0.5} />
      <Plate x={0} y={-2} w={54} h={40} r={7} opacity={0.75} />
      <Plate x={16} y={-8} w={54} h={40} r={7} />
    </IsoScene>
  );
}

/** Une page : une plaque avec ses lignes de texte. */
export function PageIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={60} y={42} size={9} />
      <Chip x={178} y={30} />
      <g transform="translate(0, -4) matrix(0.866, 0.5, 0, 1, 120, 96)">
        <rect x="-30" y="-56" width="60" height="56" rx="6" {...stroke} />
        {[-46, -38, -30, -22].map((y, i) => (
          <rect
            key={y}
            x="-22" y={y} width={i === 3 ? 24 : 44} height="3.5" rx="1.75"
            fill={SHADE} opacity="0.28"
          />
        ))}
      </g>
    </IsoScene>
  );
}

/** Une vue : une plaque et son entonnoir de filtres. */
export function ViewIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={60} y={44} size={9} />
      <Chip x={178} y={28} />
      <g transform="translate(0, -4) matrix(0.866, 0.5, 0, 1, 120, 96)">
        <rect x="-32" y="-54" width="64" height="54" rx="7" {...stroke} />
        {/* L'entonnoir : une vue, c'est un filtre enregistré. */}
        <path
          d="M -18 -42 H 18 L 5 -27 V -14 L -5 -19 V -27 Z"
          fill={SHADE} opacity="0.22" stroke={LINE} strokeWidth="1.4" strokeLinejoin="round"
        />
      </g>
    </IsoScene>
  );
}

/** L'intake : une plaque et sa boîte de réception. */
export function IntakeIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={60} y={40} size={9} />
      <Chip x={178} y={30} />
      <g transform="translate(120, 96)">
        {/* Le bac, posé au sol, et la demande qui tombe dedans. */}
        <g transform={ISO}>
          <rect x="-34" y="-34" width="68" height="68" rx="10" {...stroke} />
          <rect x="-20" y="-20" width="40" height="40" rx="6" fill={SHADE} opacity="0.18" />
        </g>
        <g transform="translate(0, -46)">
          <rect x="-16" y="-12" width="32" height="24" rx="4" {...stroke} />
          <path d="M -16 -8 L 0 3 L 16 -8" fill="none" stroke={LINE} strokeWidth="1.4" strokeLinejoin="round" />
        </g>
      </g>
    </IsoScene>
  );
}

/** Un tableau de bord : des barres qui montent au-dessus du socle. */
export function DashboardIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={58} y={44} size={10} />
      <Chip x={180} y={26} />
      <g transform="translate(0, 6)">
        {[
          { x: -34, h: 26 },
          { x: -12, h: 44 },
          { x: 10, h: 34 },
          { x: 32, h: 54 },
        ].map((b) => (
          <g key={b.x} transform={`translate(${b.x}, 0) matrix(0.866, 0.5, 0, 1, 120, 96)`}>
            <rect x="-8" y={-b.h} width="16" height={b.h} rx="3" {...stroke} />
          </g>
        ))}
      </g>
    </IsoScene>
  );
}

/** Une recherche sans résultat : la loupe au-dessus du vide. */
export function SearchIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={62} y={46} size={9} />
      <Chip x={176} y={30} />
      <g transform="translate(120, 82)">
        <circle cx="-4" cy="-8" r="22" {...stroke} />
        <circle cx="-4" cy="-8" r="13" fill="none" stroke={LINE} strokeWidth="1.2" opacity="0.6" />
        <path d="M 12 8 L 28 24" stroke={LINE} strokeWidth="4" strokeLinecap="round" fill="none" />
      </g>
    </IsoScene>
  );
}

/** Rien à faire : la coche, et un socle qu'on a fini de vider. */
export function DoneIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={62} y={44} size={9} />
      <Chip x={176} y={28} />
      <g transform="translate(120, 84)">
        <circle cx="0" cy="0" r="26" {...stroke} />
        <path
          d="M -11 1 L -3 9 L 12 -8"
          fill="none" stroke="hsl(var(--primary))" strokeWidth="3.5"
          strokeLinecap="round" strokeLinejoin="round"
        />
      </g>
    </IsoScene>
  );
}

/** Des notes : deux plaques posées de travers, comme des post-it. */
export function NoteIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={60} y={44} size={9} />
      <Chip x={178} y={28} />
      <g transform="translate(-14, 4)"><Plate w={44} h={44} r={5} opacity={0.6} /></g>
      <g transform="translate(10, -8)"><Plate w={44} h={44} r={5} /></g>
    </IsoScene>
  );
}

/** Des personnes : trois jetons alignés sur le socle. */
export function PeopleIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Chip x={178} y={30} />
      <g transform="translate(120, 74)">
        {[-30, 0, 30].map((x, i) => (
          <g key={x} transform={`translate(${x}, ${i === 1 ? -8 : 0})`}>
            <circle cx="0" cy="-10" r="9" {...stroke} />
            <path d="M -14 14 A 14 12 0 0 1 14 14 Z" {...stroke} />
          </g>
        ))}
      </g>
    </IsoScene>
  );
}

/** Un lien : deux anneaux entrelacés au-dessus du socle. */
export function LinkIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={60} y={44} size={9} />
      <g transform="translate(120, 80)">
        <rect x="-34" y="-12" width="40" height="24" rx="12" {...stroke} />
        <rect x="-6" y="-12" width="40" height="24" rx="12" {...stroke} />
      </g>
    </IsoScene>
  );
}

/** Une archive : le socle seul, refermé par un couvercle. */
export function ArchiveIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={62} y={46} size={9} />
      <g transform="translate(120, 96)">
        <g transform={ISO}>
          <rect x="-40" y="-40" width="80" height="80" rx="12" {...stroke} />
          <rect x="-14" y="-40" width="28" height="80" fill={SHADE} opacity="0.18" />
        </g>
      </g>
    </IsoScene>
  );
}

/** Un brouillon : une plaque au trait interrompu. */
export function DraftIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={60} y={42} size={9} />
      <Chip x={178} y={30} />
      <g transform="translate(0, -4) matrix(0.866, 0.5, 0, 1, 120, 96)">
        <rect
          x="-30" y="-54" width="60" height="54" rx="6"
          fill="hsl(var(--card))" stroke={LINE} strokeWidth="1.6" strokeDasharray="5 4"
        />
        {[-42, -34, -26].map((y, i) => (
          <rect
            key={y}
            x="-20" y={y} width={i === 2 ? 20 : 40} height="3.5" rx="1.75"
            fill={SHADE} opacity="0.26"
          />
        ))}
      </g>
    </IsoScene>
  );
}

/** Une initiative : un drapeau planté au sommet du socle. */
export function InitiativeIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Coin x={62} y={44} size={9} />
      <Chip x={176} y={28} />
      <g transform="translate(120, 96)">
        <path d="M -6 6 V -48" stroke={LINE} strokeWidth="2.5" strokeLinecap="round" fill="none" />
        <path d="M -6 -48 L 32 -38 L -6 -26 Z" {...stroke} />
      </g>
    </IsoScene>
  );
}

/** Un graphe : des nœuds reliés, flottant au-dessus du socle. */
export function GraphIllustration({ className }: Props) {
  return (
    <IsoScene className={className}>
      <Chip x={178} y={28} />
      <g transform="translate(120, 82)">
        <path
          d="M -34 10 L 0 -18 M 0 -18 L 34 6 M -34 10 L 34 6"
          stroke={LINE} strokeWidth="1.4" fill="none" opacity="0.7"
        />
        {[[-34, 10], [0, -18], [34, 6]].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="11" {...stroke} />
        ))}
      </g>
    </IsoScene>
  );
}
