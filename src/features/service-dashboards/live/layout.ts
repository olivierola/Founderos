// Le PLAN des locaux du Live Space — rien que des données, aucun mesh.
//
// Un grand plateau ouvert, bordé de pièces communes :
//
//   ┌ Réunion ─┬─ Utilities ─┬─ Atelier ─┬─ Petite salle ┐   ← pièces fermées
//   │ allée                                               │
//   │ coin  ÉQUIPE A  coin  ÉQUIPE C  coin                │   ← rangée nord
//   ═ entrée ═════════ boulevard ══════════════ entrée ═  │
//   │ coin  ÉQUIPE B  coin  ÉQUIPE D  coin                │   ← rangée sud
//   │ allée                                               │
//   └ Café ────┴─ Salon ─────┴─ Box de travail ──────────┘   ← pièces ouvertes ou vitrées
//
// Les équipes n'ont pas de murs : un sol à elles, un grand mur peint à leur
// couleur et à leur nom, et AUCUNE ne ressemble à sa voisine — îlots,
// tablées, tables rondes, studio avec son coin canapé, salle tournée vers un
// grand écran. Entre elles, des coins : canapé, cabines, bibliothèque, point
// café, jardin intérieur.
//
// Tout est décrit ICI, en coordonnées du monde : pièces, murs, cadres aux
// murs, chaque meuble, chaque siège, chaque halte, et le point d'où l'on
// aborde chaque siège. La scène 3D ne fait que dessiner ce plan, et la
// navigation des agents le lit pour ne traverser ni les murs ni les meubles.

import { approachPoint, buildNavGrid, isFree, nearestFree, type NavGrid } from "./nav";

export type ZoneKind =
  | "team" | "open" | "nook"
  | "lounge" | "cafe" | "memory" | "meeting" | "focus" | "creative" | "huddle";
export type TeamStyle = "pods" | "bench" | "round" | "studio" | "lab";
export type NookKind = "sofa" | "booths" | "library" | "coffee" | "green";
export type FloorKind =
  | "carpet" | "wood" | "darkwood" | "terrazzo" | "concrete" | "tech" | "lounge" | "meeting"
  | "tile" | "cork" | "herringbone" | "none";

export interface Seat {
  agentId: string | null;
  /** La chaise : là où l'agent s'assied. */
  x: number;
  z: number;
  /** Rotation Y de l'agent assis : il regarde son poste. */
  facing: number;
  /** La hauteur des hanches, assis. */
  hip: number;
  /** D'où l'on aborde la chaise (par derrière) : le dernier pas part d'ici. */
  ax: number;
  az: number;
}

/** Une halte : où l'on se tient debout, ou s'assoit, hors de son poste. */
export interface Spot {
  x: number;
  z: number;
  /** Vers où se tourner (NaN : peu importe). */
  face: number;
  /** Hauteur des hanches si l'on s'y assoit ; null : debout. */
  sit: number | null;
  /** D'où l'on aborde la place (devant un canapé, derrière une chaise). */
  ax: number;
  az: number;
  /** Salle Utilities : la borne où se brancher. */
  port?: { x: number; z: number };
  /** À quoi sert la halte : « skills », devant l'armoire des compétences. */
  use?: "skills";
}

/**
 * Un élément posé : meuble, poste, décor. `rot` est la direction vers
 * laquelle il FAIT FACE dans le monde (0 = +z) — la scène convertit selon le
 * pack d'origine. `y` le pose sur un autre meuble. `seat` relie un poste à
 * son siège.
 */
export interface Fixture {
  kind: string;
  x: number;
  z: number;
  rot: number;
  y?: number;
  s?: number;
  /** Longueur et profondeur, pour les éléments dessinés à la mesure. */
  len?: number;
  depth?: number;
  color?: string;
  variant?: string;
  seat?: Seat;
}

export type WallKind = "solid" | "glass" | "feature" | "partition" | "planter" | "shelf" | "slats";
export type ArtKind =
  | "frameA" | "frameB" | "frameM" | "frameS" | "frameS2" | "shelf"
  | "screen" | "whiteboard" | "pinboard" | "clock" | "upper";

/** Ce qui est accroché à un mur, côté intérieur : `t` de 0 (début du mur) à 1. */
export interface WallArt { t: number; y: number; kind: ArtKind }

export interface WallSeg {
  x1: number; z1: number; x2: number; z2: number;
  kind: WallKind;
  height: number;
  /** Normale SORTANTE, dans le monde : c'est elle qui décide de la coupe. */
  nx: number; nz: number;
  windows: number;
  color?: string;
  /** Peint sur le mur : le nom de l'équipe. */
  text?: string;
  art?: WallArt[];
}

export interface Zone {
  key: string;
  kind: ZoneKind;
  label: string;
  /** La couleur de l'équipe ; null pour les espaces communs. */
  color: string | null;
  teamId: string | null;
  style: TeamStyle | null;
  nook: NookKind | null;
  floor: FloorKind;
  /** Le rectangle de la zone dans le monde (coin x/z minimal). */
  x: number;
  z: number;
  w: number;
  d: number;
  /** « open » : sur le plateau ; north / south : une pièce des bandeaux. */
  side: "north" | "south" | "open";
  seats: Seat[];
  /** Où se dégourdir les jambes, s'asseoir, se brancher. */
  spots: Spot[];
  fixtures: Fixture[];
  walls: WallSeg[];
  /** Salle Utilities : le centre du silo. */
  core: { x: number; z: number } | null;
}

/** Le plateau ouvert : tout le sol entre les deux bandeaux de pièces. */
export interface Hall {
  x0: number; x1: number;
  z0: number; z1: number;
  /** La demi-largeur du boulevard central (et des deux entrées). */
  half: number;
  spots: Spot[];
  fixtures: Fixture[];
}

export interface Layout {
  zones: Zone[];
  seatOf: Map<string, { seat: Seat; zone: Zone }>;
  lounge: Zone | null;
  cafe: Zone | null;
  memory: Zone | null;
  meeting: Zone | null;
  focus: Zone | null;
  /** Les espaces où l'on va faire une pause : coins, café, salon, box… */
  commons: Zone[];
  hall: Hall;
  /** Les murs extérieurs du plateau, entrées comprises. */
  shell: WallSeg[];
  building: { minX: number; maxX: number; minZ: number; maxZ: number };
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  nav: NavGrid;
  /** Ce que la vérification du plan a écarté (une halte inaccessible…). */
  issues: string[];
}

export interface LayoutTeam { id: string; name: string; color: string; agentIds: string[] }

export const BOULEVARD = 3.0;
const AISLE = 1.7;
const BAND_D = 6.2;
const MARGIN = 1.1;
const NOOK_W = 4.8;
const MIN_ROW_D = 5.4;
export const GARDEN = 6;
const WALL_H = 1.75;
const FEATURE_H = 2.0;
const CHAIR_HIP = 0.6;
const LOW_HIP = 0.55;
const SOFA_HIP = 0.5;

const STYLES: TeamStyle[] = ["pods", "bench", "round", "studio", "lab"];
const FLOOR_OF: Record<TeamStyle, FloorKind> = {
  pods: "carpet", bench: "wood", round: "terrazzo", studio: "darkwood", lab: "concrete",
};
const NOOKS: NookKind[] = ["sofa", "booths", "library", "coffee", "green"];
const NOOK_LABEL: Record<NookKind, string> = {
  sofa: "Coin canapé", booths: "Cabines", library: "Bibliothèque", coffee: "Point café", green: "Jardin",
};
const BOOTH_COLORS = ["#7aa6d8", "#e8a87c", "#8fc9a3", "#c9a0dc", "#e6c25a"];

// ── Le contenu d'une zone, en repère LOCAL ───────────────────────────────────
// Le fond (mur peint, mur extérieur) en z = 0 ; l'ouverture en z = d.

interface LocalSeat { agentId: string | null; x: number; z: number; facing: number; hip: number }
interface LocalFix extends Omit<Fixture, "seat"> { seatIndex?: number }
interface LocalSpot {
  x: number; z: number; face: number; sit: number | null;
  /** Le côté d'où on l'aborde : devant (canapé) ou derrière (chaise). */
  from?: "front" | "back";
  port?: [number, number];
  use?: "skills";
}
interface LocalArt { x: number; y: number; kind: ArtKind }
interface Plan {
  w: number; d: number;
  seats: LocalSeat[];
  fixtures: LocalFix[];
  spots: LocalSpot[];
  /** Accroché au mur du fond. */
  art?: LocalArt[];
  core?: [number, number];
}

const stand = (x: number, z: number, face = NaN): LocalSpot => ({ x, z, face, sit: null });
const sitOn = (x: number, z: number, face: number, hip: number, from: "front" | "back" = "front"): LocalSpot =>
  ({ x, z, face, sit: hip, from });
const fx = (kind: string, x: number, z: number, rot = 0, extra: Partial<LocalFix> = {}): LocalFix =>
  ({ kind, x, z, rot, ...extra });
const atLeast = (ids: Array<string | null>, n: number) => {
  const s = [...ids];
  while (s.length < n) s.push(null);
  return s;
};
const evenSlots = (ids: Array<string | null>) => {
  const s = atLeast(ids, 2);
  if (s.length % 2) s.push(null);
  return s;
};

/** Une chaise autour d'une table : la place, et l'agent tourné vers la table. */
function chairAround(cx: number, cz: number, a: number, r: number) {
  return { x: cx + Math.sin(a) * r, z: cz + Math.cos(a) * r, facing: a + Math.PI };
}

// ── Les équipes : cinq aménagements ──────────────────────────────────────────

/** Des îlots de quatre postes, deux à deux face à face. */
function podsPlan(ids: Array<string | null>, color: string): Plan {
  const slots = evenSlots(ids);
  const pods = Math.ceil(slots.length / 4);
  const perRow = Math.min(3, pods);
  const rows = Math.ceil(pods / perRow);
  const POD = 3.0, GAP = 1.4, ROW = 4.2, CZ = 2.9;
  const span = perRow * POD + (perRow - 1) * GAP;
  const w = Math.max(6.6, span + 2.0);
  const d = CZ + (rows - 1) * ROW + 1.2 + 1.5;
  const x0 = (w - span) / 2;
  const seats: LocalSeat[] = [];
  const fixtures: LocalFix[] = [];
  slots.forEach((agentId, i) => {
    const pod = Math.floor(i / 4), slot = i % 4;
    const px = x0 + (pod % perRow) * (POD + GAP);
    const cz = CZ + Math.floor(pod / perRow) * ROW;
    const dx = px + 0.75 + (slot >= 2 ? 1.5 : 0);
    const back = slot % 2 === 0;
    const seat = { agentId, x: dx, z: back ? cz - 1.2 : cz + 1.2, facing: back ? 0 : Math.PI, hip: CHAIR_HIP };
    seats.push(seat);
    fixtures.push(fx("workstation", dx, back ? cz - 0.4 : cz + 0.4, seat.facing, { variant: "monitor", seatIndex: i }));
  });
  fixtures.push(
    fx("rug", w / 2, CZ + ((rows - 1) * ROW) / 2, 0, { len: span + 1.2, depth: (rows - 1) * ROW + 3.6, color: mixHex(color, "#ffffff", 0.35) }),
    fx("bookcaseOpenLow", 0.6, 0.42), fx("plantSmall2", 0.42, 0.42, 0, { y: 0.82 }), fx("books", 0.8, 0.42, 0, { y: 0.82 }),
    fx("coatRackStanding", w - 0.55, 0.55),
    fx("pottedPlant", 0.5, d - 0.5), fx("pottedPlant", w - 0.5, d - 0.5),
  );
  const art: LocalArt[] = [{ x: w / 2, y: 1.0, kind: "whiteboard" }];
  if (w >= 8) art.push({ x: 1.7, y: 1.05, kind: "frameM" }, { x: w - 1.7, y: 1.05, kind: "frameS" });
  return { w, d, seats, fixtures, art, spots: [stand(w / 2, 0.85, Math.PI), stand(w * 0.3, d - 0.6), stand(w * 0.7, d - 0.6)] };
}

/** De grandes tablées partagées, portables posés dessus, une jardinière au milieu. */
function benchPlan(ids: Array<string | null>, color: string): Plan {
  const slots = evenSlots(ids);
  const perSide = Math.min(5, Math.max(2, Math.ceil(slots.length / 2)));
  const tables = Math.ceil(slots.length / (2 * perSide));
  const len = perSide * 1.0 + 0.8;
  const w = Math.max(6.6, len + 3.2);
  const TZ = 2.3, STEP = 3.3;
  const d = TZ + (tables - 1) * STEP + 0.8 + 1.7;
  const tx = w / 2 + 0.5;
  const seats: LocalSeat[] = [];
  const fixtures: LocalFix[] = [];
  for (let t = 0; t < tables; t++) {
    const tz = TZ + t * STEP;
    fixtures.push(fx("rug", tx, tz, 0, { len: len + 1.2, depth: 2.9, color: mixHex(color, "#f4ead8", 0.55) }));
    fixtures.push(fx("benchTable", tx, tz, 0, { len }));
    for (let k = 0; k < perSide * 2; k++) {
      const i = t * perSide * 2 + k;
      if (i >= slots.length) break;
      const back = k % 2 === 0;
      const sx = tx - len / 2 + 0.9 + Math.floor(k / 2) * 1.0;
      const seat = { agentId: slots[i], x: sx, z: back ? tz - 0.8 : tz + 0.8, facing: back ? 0 : Math.PI, hip: LOW_HIP };
      seats.push(seat);
      fixtures.push(fx("benchSeat", sx, back ? tz - 0.25 : tz + 0.25, seat.facing, { seatIndex: i }));
    }
  }
  fixtures.push(
    fx("bookcaseOpen", 0.42, d / 2 - 0.45, Math.PI / 2), fx("bookcaseOpen", 0.42, d / 2 + 0.45, Math.PI / 2),
    fx("lamp_standing", 0.55, 0.6),
    fx("pottedPlant", w - 0.5, 0.5), fx("pottedPlant", w - 0.5, d - 0.5),
    fx("trashcan", 0.5, d - 0.5),
  );
  return {
    w, d, seats, fixtures,
    art: [{ x: tx, y: 1.05, kind: "pinboard" }, { x: tx - len / 2 - 0.2, y: 1.15, kind: "frameA" }, { x: tx + len / 2 + 0.2, y: 1.0, kind: "clock" }],
    spots: [stand(1.4, d / 2, -Math.PI / 2), stand(w * 0.35, d - 0.55), stand(w * 0.75, d - 0.55)],
  };
}

/** Des tables rondes de quatre, chacune sur son tapis. */
function roundPlan(ids: Array<string | null>, color: string): Plan {
  const slots = atLeast(ids, 2);
  const tables = Math.ceil(slots.length / 4);
  const cols = Math.min(3, tables), rows = Math.ceil(tables / cols);
  const SP = 3.6, CZ = 2.4;
  const w = Math.max(6.6, cols * SP + 1.4);
  const d = CZ + (rows - 1) * SP + 1.25 + 1.5;
  const x0 = (w - cols * SP) / 2;
  const seats: LocalSeat[] = [];
  const fixtures: LocalFix[] = [];
  const rugColors = [mixHex(color, "#ffffff", 0.25), "#e7c9a5", "#b9cbb0"];
  for (let t = 0; t < tables; t++) {
    const cx = x0 + SP / 2 + (t % cols) * SP;
    const cz = CZ + Math.floor(t / cols) * SP;
    fixtures.push(fx("rugDisc", cx, cz, 0, { len: 2.6, color: rugColors[t % rugColors.length] }));
    fixtures.push(fx("roundTable", cx, cz, 0));
    fixtures.push(fx("plantSmall3", cx, cz, 0, { y: 0.75 }));
    for (let k = 0; k < 4; k++) {
      const i = t * 4 + k;
      if (i >= slots.length) break;
      const a = Math.PI / 4 + k * (Math.PI / 2);
      const c = chairAround(cx, cz, a, 1.0);
      seats.push({ agentId: slots[i], ...c, hip: LOW_HIP });
      fixtures.push(fx("roundSeat", cx + Math.sin(a) * 0.42, cz + Math.cos(a) * 0.42, c.facing, { seatIndex: i }));
    }
  }
  fixtures.push(
    fx("lamp_standing", 0.5, 0.55), fx("lamp_standing", w - 0.5, 0.55),
    fx("cactus_medium_A", w - 0.5, d - 0.5), fx("pottedPlant", 0.5, d - 0.5),
  );
  return {
    w, d, seats, fixtures,
    art: [{ x: w / 2, y: 1.05, kind: "frameB" }, { x: w / 2 - 1.35, y: 1.1, kind: "frameS" }, { x: w / 2 + 1.35, y: 1.05, kind: "frameS2" }],
    spots: [stand(w / 2, d - 0.6), stand(w * 0.18, d - 0.75), stand(w * 0.82, d - 0.75)],
  };
}

/** Un studio : les postes contre le mur, et le coin canapé de l'équipe devant. */
function studioPlan(ids: Array<string | null>, color: string): Plan {
  const slots = atLeast(ids, 2);
  const perRow = Math.min(5, slots.length);
  const rows = Math.ceil(slots.length / perRow);
  const SP = 1.75, RZ = 0.7, RSTEP = 2.7;
  const w = Math.max(7.0, perRow * SP + 1.4);
  const x0 = (w - perRow * SP) / 2;
  const seats: LocalSeat[] = [];
  const fixtures: LocalFix[] = [];
  slots.forEach((agentId, i) => {
    const r = Math.floor(i / perRow), c = i % perRow;
    const x = x0 + SP / 2 + c * SP, z = RZ + r * RSTEP;
    seats.push({ agentId, x, z: z + 0.8, facing: Math.PI, hip: CHAIR_HIP });
    fixtures.push(fx("workstation", x, z, Math.PI, { variant: "dual", seatIndex: i }));
  });
  const zL = RZ + (rows - 1) * RSTEP + 0.8 + 1.3;
  const cx = w / 2;
  fixtures.push(
    fx("rug", cx, zL + 1.1, 0, { len: 5.0, depth: 2.9, color: mixHex(color, "#3b2f2a", 0.25) }),
    fx("table_low", cx, zL + 0.85, 0, { s: 0.6 }),
    fx("book_set", cx - 0.2, zL + 0.85, 0.3, { y: 0.21, s: 0.7 }),
    fx("couch", cx, zL + 2.05, Math.PI),
    fx("armchair", cx - 2.05, zL + 0.95, Math.PI / 2),
    fx("armchair", cx + 2.05, zL + 0.95, -Math.PI / 2),
    fx("lampRoundFloor", w - 0.4, zL + 2.3),
    fx("pottedPlant", 0.45, zL + 2.3),
  );
  const d = zL + 2.05 + 0.56 + 0.7;
  return {
    w, d, seats, fixtures,
    spots: [
      sitOn(cx - 0.5, zL + 1.95, Math.PI, SOFA_HIP), sitOn(cx + 0.5, zL + 1.95, Math.PI, SOFA_HIP),
      sitOn(cx - 1.95, zL + 0.95, Math.PI / 2, SOFA_HIP), sitOn(cx + 1.95, zL + 0.95, -Math.PI / 2, SOFA_HIP),
    ],
  };
}

/** Une salle tournée vers un grand écran : des rangées de postes à double écran. */
function labPlan(ids: Array<string | null>, _color: string): Plan {
  const slots = atLeast(ids, 2);
  const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(slots.length * 1.3))));
  const rows = Math.ceil(slots.length / cols);
  const SP = 1.85, RZ = 2.5, RSTEP = 2.5;
  const w = Math.max(6.6, cols * SP + 1.8);
  const x0 = (w - cols * SP) / 2;
  const seats: LocalSeat[] = [];
  const fixtures: LocalFix[] = [];
  slots.forEach((agentId, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const x = x0 + SP / 2 + c * SP, z = RZ + r * RSTEP;
    seats.push({ agentId, x, z: z + 0.8, facing: Math.PI, hip: CHAIR_HIP });
    fixtures.push(fx("workstation", x, z, Math.PI, { variant: "dual", seatIndex: i }));
  });
  const d = RZ + (rows - 1) * RSTEP + 0.8 + 0.7 + 1.0;
  fixtures.push(
    fx("cactus_medium_A", 0.5, 0.5), fx("cactus_medium_B", w - 0.5, 0.5),
    fx("sideTableDrawers", 0.75, d - 0.4), fx("radio", 0.6, d - 0.4, 0, { y: 0.79 }),
    fx("lampSquareFloor", w - 0.4, d - 0.4),
    fx("speakerSmall", w - 0.35, 1.5, -Math.PI / 2),
  );
  return {
    w, d, seats, fixtures,
    art: [{ x: w / 2, y: 0.95, kind: "screen" }],
    spots: [stand(w / 2 - 1.5, 1.2, Math.PI), stand(w / 2 + 1.5, 1.2, Math.PI), stand(w / 2, d - 0.5)],
  };
}

const PLAN_OF: Record<TeamStyle, (ids: Array<string | null>, color: string) => Plan> = {
  pods: podsPlan, bench: benchPlan, round: roundPlan, studio: studioPlan, lab: labPlan,
};

// ── Les coins du plateau ─────────────────────────────────────────────────────

function nookPlan(kind: NookKind, d: number, w: number, k: number): Plan {
  const cx = w / 2, cz = d / 2;
  const seats: LocalSeat[] = [];
  switch (kind) {
    case "sofa": {
      // Un canapé, deux fauteuils tournés vers lui, une table basse, un tapis.
      const ar = Math.PI - 0.46;
      return {
        w, d, seats,
        fixtures: [
          fx("rug", cx, cz + 0.2, 0, { len: 3.9, depth: 3.2, color: k % 2 ? "#c98b6b" : "#8fa98a" }),
          fx("couch_pillows", cx, cz - 0.9, 0),
          fx("tableCoffee", cx, cz + 0.3, 0, { s: 0.7 }),
          fx("plantSmall3", cx + 0.25, cz + 0.3, 0, { y: 0.33 }),
          fx("armchair_pillows", cx - 1.05, cz + 1.45, ar),
          fx("armchair_pillows", cx + 1.05, cz + 1.45, -ar),
          fx("lamp_standing", cx + 1.75, cz - 1.0),
          fx("pottedPlant", cx - 1.8, cz - 1.0),
        ],
        spots: [
          sitOn(cx - 0.5, cz - 0.8, 0, SOFA_HIP), sitOn(cx + 0.5, cz - 0.8, 0, SOFA_HIP),
          sitOn(cx - 1.0, cz + 1.36, ar, SOFA_HIP), sitOn(cx + 1.0, cz + 1.36, -ar, SOFA_HIP),
        ],
      };
    }
    case "booths": {
      // Deux cabines pour s'isoler, ouvertes vers l'allée.
      const bz = cz - 0.3;
      return {
        w, d, seats,
        fixtures: [
          fx("booth", cx - 1.05, bz, 0, { color: BOOTH_COLORS[k % BOOTH_COLORS.length] }),
          fx("booth", cx + 1.05, bz, 0, { color: BOOTH_COLORS[(k + 2) % BOOTH_COLORS.length] }),
          fx("pottedPlant", cx, cz + 1.55),
        ],
        spots: [
          sitOn(cx - 1.05, bz + 0.35, Math.PI, CHAIR_HIP, "back"),
          sitOn(cx + 1.05, bz + 0.35, Math.PI, CHAIR_HIP, "back"),
          stand(cx - 1.6, cz + 1.4),
        ],
      };
    }
    case "library": {
      return {
        w, d, seats,
        fixtures: [
          fx("rug", cx, cz + 0.45, 0, { len: 3.6, depth: 2.2, color: "#8fa3b8" }),
          fx("bookcaseOpen", cx - 0.9, cz - 1.35), fx("bookcaseOpen", cx, cz - 1.35), fx("bookcaseOpen", cx + 0.9, cz - 1.35),
          fx("plantSmall1", cx - 0.9, cz - 1.35, 0, { y: 1.8 }), fx("cactus_small_A", cx + 0.9, cz - 1.35, 0, { y: 1.8, s: 0.8 }),
          fx("armchair", cx - 1.25, cz + 0.55, Math.PI / 2),
          fx("armchair", cx + 1.25, cz + 0.55, -Math.PI / 2),
          fx("tableCoffeeSquare", cx, cz + 0.55, 0, { s: 0.6 }),
          fx("lampRoundTable", cx, cz + 0.55, 0, { y: 0.28, s: 0.8 }),
          fx("lampRoundFloor", cx + 2.0, cz - 1.2),
        ],
        spots: [
          sitOn(cx - 1.15, cz + 0.55, Math.PI / 2, SOFA_HIP), sitOn(cx + 1.15, cz + 0.55, -Math.PI / 2, SOFA_HIP),
          stand(cx - 0.45, cz - 0.55, Math.PI),
        ],
      };
    }
    case "coffee": {
      // Un comptoir, la machine à café, des tabourets : on s'y retrouve debout.
      const bz = cz - 0.9;
      return {
        w, d, seats,
        fixtures: [
          fx("kitchenBar", cx - 0.88, bz), fx("kitchenBar", cx, bz), fx("kitchenBar", cx + 0.88, bz),
          fx("kitchenCoffeeMachine", cx - 0.88, bz - 0.04, 0, { y: 0.86 }),
          fx("cactus_small_A", cx + 0.95, bz, 0, { y: 0.86, s: 0.7 }),
          fx("kitchenFridgeSmall", cx + 1.85, bz + 0.1),
          fx("stoolBarSquare", cx - 0.88, bz + 0.62, Math.PI), fx("stoolBarSquare", cx, bz + 0.62, Math.PI),
          fx("stoolBarSquare", cx + 0.88, bz + 0.62, Math.PI),
          fx("pottedPlant", cx - 1.95, bz),
        ],
        spots: [
          stand(cx - 0.44, bz + 0.68, 0 + Math.PI), stand(cx + 0.44, bz + 0.68, Math.PI),
          stand(cx - 0.3, cz + 0.9), stand(cx + 0.8, cz + 1.0),
        ],
      };
    }
    case "green":
    default: {
      return {
        w, d, seats,
        fixtures: [
          fx("planterBig", cx, cz - 0.35, 0, { len: 2.8, depth: 1.1 }),
          fx("benchCushion", cx - 0.75, cz + 0.65, 0), fx("benchCushion", cx + 0.75, cz + 0.65, 0),
          fx("pottedPlant", cx - 2.0, cz - 1.2), fx("pottedPlant", cx + 2.0, cz - 1.2),
          fx("cactus_medium_B", cx + 1.95, cz + 1.2),
          fx("lampSquareFloor", cx - 2.0, cz + 1.3),
        ],
        spots: [
          sitOn(cx - 0.75, cz + 0.72, 0, 0.48), sitOn(cx + 0.75, cz + 0.72, 0, 0.48),
          stand(cx, cz + 1.75),
        ],
      };
    }
  }
}

// ── Les pièces des bandeaux (profondeur BAND_D, porte en z = d) ──────────────

function meetingPlan(): Plan {
  const w = 7.6, d = BAND_D;
  const tx = w / 2, tz = 3.0;
  const spots: LocalSpot[] = [];
  const fixtures: LocalFix[] = [
    fx("rug", tx, tz, 0, { len: 5.8, depth: 3.5, color: "#6f7fa0" }),
    fx("meetingTable", tx, tz, 0, { len: 3.4 }),
  ];
  for (const side of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const x = tx - 1.15 + k * 1.15, z = tz + side * 1.05;
      const face = side > 0 ? Math.PI : 0;
      fixtures.push(fx("chairCushion", x, z, face));
      spots.push(sitOn(x, z, face, LOW_HIP, "back"));
    }
  }
  for (const end of [-1, 1]) {
    const x = tx + end * 2.2;
    const face = end > 0 ? -Math.PI / 2 : Math.PI / 2;
    fixtures.push(fx("chairCushion", x, tz, face));
    spots.push(sitOn(x, tz, face, LOW_HIP, "back"));
  }
  fixtures.push(
    fx("whiteboard", 0.45, tz, Math.PI / 2),
    fx("sideTableDrawers", w - 0.3, tz, -Math.PI / 2), fx("plantSmall1", w - 0.3, tz - 0.3, 0, { y: 0.79 }),
    fx("pottedPlant", w - 0.5, 0.5), fx("pottedPlant", 0.5, d - 0.5),
  );
  return { w, d, seats: [], fixtures, spots, art: [{ x: tx, y: 1.0, kind: "screen" }] };
}

function utilitiesPlan(): Plan {
  const w = 7.2, d = BAND_D;
  const core: [number, number] = [w / 2 + 0.4, 3.1];
  const dirs = [0, -0.8, 0.8, Math.PI];
  const at = (r: number, a: number): [number, number] => [core[0] + Math.sin(a) * r, core[1] + Math.cos(a) * r];
  return {
    w, d, seats: [], core,
    fixtures: [
      fx("serverRack", 1.0, 0.45), fx("serverRack", 1.75, 0.45), fx("serverRack", 2.5, 0.45),
      fx("hvac", w - 0.9, 0.5),
      fx("pipes", w - 0.3, d / 2 - 0.4, 0, { len: d - 2.2 }),
      fx("electricPanel", 0.2, d - 1.3, Math.PI / 2),
      fx("cardboardBoxClosed", 0.45, d - 0.5), fx("cardboardBoxClosed", 0.9, d - 0.45, 0.4, { s: 0.8 }),
      // L'armoire des skills : chaque compétence du service y a sa cartouche.
      fx("skillCabinet", 0.34, 2.75, Math.PI / 2, { len: 1.9 }),
    ],
    spots: [
      ...dirs.map((a): LocalSpot => {
        const [x, z] = at(1.75, a);
        return { x, z, face: a + Math.PI, sit: null, port: at(1.12, a) };
      }),
      // Devant l'armoire : on vient y chercher une compétence.
      { ...stand(1.4, 2.75, -Math.PI / 2), use: "skills" },
    ],
  };
}

/** L'atelier : on y réfléchit debout, au tableau, ou autour de la grande table. */
function creativePlan(): Plan {
  const w = 6.8, d = BAND_D;
  const tx = w / 2, tz = 3.1;
  const spots: LocalSpot[] = [];
  const fixtures: LocalFix[] = [
    fx("rug", tx, tz, 0, { len: 4.4, depth: 3.3, color: "#e0b85a" }),
    fx("table_medium_long", tx, tz, 0),
    fx("book_set", tx - 0.4, tz, 0.4, { y: 0.7, s: 0.6 }),
  ];
  for (const [dx, side] of [[-0.55, -1], [0.55, -1], [-0.55, 1], [0.55, 1]] as Array<[number, number]>) {
    const x = tx + dx, z = tz + side * 1.0;
    const face = side < 0 ? 0 : Math.PI;
    fixtures.push(fx("chair_A_wood", x, z, face));
    spots.push(sitOn(x, z, face, LOW_HIP, "back"));
  }
  fixtures.push(
    fx("lamp_standing", 0.6, 0.6), fx("pottedPlant", w - 0.5, 0.5),
    fx("cabinet_small_decorated", w - 0.5, d - 1.4, -Math.PI / 2),
    fx("pillow_A", 0.7, d - 0.9, 0.5), fx("pillow_B", 1.1, d - 0.6, -0.3),
  );
  spots.push(stand(w * 0.3, 0.85, Math.PI), stand(w * 0.72, 0.85, Math.PI));
  return {
    w, d, seats: [], fixtures, spots,
    art: [{ x: w * 0.3, y: 1.0, kind: "whiteboard" }, { x: w * 0.72, y: 1.05, kind: "pinboard" }],
  };
}

/** Une petite salle : une table ronde, quatre chaises, un écran. */
function huddlePlan(): Plan {
  const w = 5.4, d = BAND_D;
  const cx = w / 2, cz = 3.0;
  const spots: LocalSpot[] = [];
  const fixtures: LocalFix[] = [
    fx("rugDisc", cx, cz, 0, { len: 2.8, color: "#a7b8d6" }),
    fx("roundTable", cx, cz, 0),
  ];
  for (let k = 0; k < 4; k++) {
    const c = chairAround(cx, cz, Math.PI / 4 + k * (Math.PI / 2), 1.0);
    fixtures.push(fx("chairRounded", c.x, c.z, c.facing));
    spots.push(sitOn(c.x, c.z, c.facing, LOW_HIP, "back"));
  }
  fixtures.push(fx("pottedPlant", 0.5, 0.5), fx("pottedPlant", w - 0.5, d - 0.5));
  return { w, d, seats: [], fixtures, spots, art: [{ x: cx, y: 1.0, kind: "screen" }] };
}

/** Le café : la cuisine le long du mur, deux tables, la machine à café. */
function cafePlan(): Plan {
  const w = 7.8, d = BAND_D;
  const spots: LocalSpot[] = [];
  const fixtures: LocalFix[] = [
    fx("kitchenFridge", 0.55, 0.36),
    fx("kitchenCabinet", 1.45, 0.5), fx("kitchenMicrowave", 1.45, 0.45, 0, { y: 0.92 }),
    fx("kitchenSink", 2.33, 0.5),
    fx("kitchenCabinet", 3.21, 0.5), fx("kitchenCoffeeMachine", 3.21, 0.45, 0, { y: 0.92 }),
    fx("kitchenCabinet", 4.09, 0.5), fx("plantSmall2", 4.25, 0.45, 0, { y: 0.92 }),
  ];
  const table = (cx: number, cz: number) => {
    fixtures.push(fx("table_medium", cx, cz, 0), fx("plantSmall1", cx, cz, 0, { y: 0.7 }));
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const c = chairAround(cx, cz, a, 1.0);
      fixtures.push(fx("chair_A_wood", c.x, c.z, c.facing));
      spots.push(sitOn(c.x, c.z, c.facing, LOW_HIP, "back"));
    }
  };
  table(5.6, 2.9);
  table(2.4, 3.9);
  fixtures.push(fx("pottedPlant", w - 0.5, 0.5), fx("pottedPlant", w - 0.5, d - 0.6), fx("trashcan", 4.85, 0.45));
  spots.push(stand(1.9, 1.45, Math.PI), stand(2.8, 1.45, Math.PI));
  return {
    w, d, seats: [], fixtures, spots,
    art: [
      { x: 1.45, y: 1.5, kind: "upper" }, { x: 2.33, y: 1.5, kind: "upper" }, { x: 3.21, y: 1.5, kind: "upper" },
      { x: 5.6, y: 1.3, kind: "clock" }, { x: 6.9, y: 1.1, kind: "frameM" },
    ],
  };
}

/** Le salon : un grand canapé, deux fauteuils, une table basse, des lampes. */
function loungePlan(): Plan {
  const w = 7.4, d = BAND_D;
  const cx = w / 2;
  return {
    w, d, seats: [],
    fixtures: [
      fx("rug", cx, 2.85, 0, { len: 5.4, depth: 3.7, color: "#d9a679" }),
      fx("couch_pillows", cx, 1.35, 0),
      fx("pillow_A", cx - 0.6, 1.25, 0.2, { y: 0.45, s: 0.8 }),
      fx("armchair_pillows", 1.4, 3.0, Math.PI / 2),
      fx("armchair_pillows", w - 1.4, 3.0, -Math.PI / 2),
      fx("table_low", cx, 3.0, 0, { s: 0.75 }),
      fx("book_set", cx + 0.3, 3.0, 0.2, { y: 0.26, s: 0.7 }),
      fx("lamp_standing", 0.6, 0.6), fx("lamp_standing", w - 0.6, 0.6),
      fx("bookcaseClosedWide", w - 0.3, 4.9, -Math.PI / 2),
      fx("pottedPlant", 0.5, d - 0.6),
      fx("speaker", 0.35, 1.7, Math.PI / 2, { s: 0.7 }),
      // Des poufs de couleur, comme on en pousse au gré des conversations.
      fx("pouf", cx - 1.1, 4.75, 0, { color: "#e39b3b" }), fx("pouf", cx - 0.35, 5.15, 0, { color: "#6b4a3a", variant: "hex" }),
      fx("pouf", cx + 0.6, 4.8, 0, { color: "#f2c14e" }), fx("pouf", cx + 1.35, 5.2, 0, { color: "#c4553a", variant: "hex" }),
    ],
    spots: [
      sitOn(cx - 0.5, 1.45, 0, SOFA_HIP), sitOn(cx + 0.5, 1.45, 0, SOFA_HIP),
      sitOn(1.5, 3.0, Math.PI / 2, SOFA_HIP), sitOn(w - 1.5, 3.0, -Math.PI / 2, SOFA_HIP),
      sitOn(cx - 1.1, 4.75, Math.PI, 0.42), sitOn(cx + 0.6, 4.8, Math.PI, 0.42),
      stand(1.5, 5.1),
    ],
    art: [{ x: cx, y: 1.15, kind: "frameB" }, { x: 1.5, y: 1.1, kind: "frameS" }, { x: w - 1.6, y: 1.15, kind: "frameS2" }],
  };
}

/** La salle de jeux : un ping-pong, des poufs, un écran — on y décompresse. */
function gamesPlan(): Plan {
  const w = 6.6, d = BAND_D;
  return {
    w, d, seats: [],
    fixtures: [
      fx("rug", w / 2, 3.2, 0, { len: 5.2, depth: 3.6, color: "#3f6f73" }),
      fx("pingpong", w / 2, 3.0, 0),
      fx("pouf", 0.8, 1.0, 0, { color: "#e39b3b" }), fx("pouf", 1.45, 0.75, 0, { color: "#c4553a" }),
      fx("pouf", w - 0.9, 1.0, 0, { color: "#f2c14e", variant: "hex" }),
      fx("cabinetTelevision", w / 2, 0.4), fx("televisionModern", w / 2, 0.4, 0, { y: 0.63, s: 0.85 }),
      fx("speakerSmall", w / 2 - 1.1, 0.35), fx("speakerSmall", w / 2 + 1.1, 0.35),
      fx("pottedPlant", 0.5, d - 0.5), fx("pottedPlant", w - 0.5, d - 0.5),
    ],
    spots: [stand(w / 2, 1.1, 0), stand(w / 2, 4.9, Math.PI), stand(1.0, 4.6), sitOn(0.8, 1.0, Math.PI * 0.75, 0.42), sitOn(w - 0.9, 1.0, -Math.PI * 0.75, 0.42)],
    art: [{ x: 1.4, y: 1.25, kind: "frameM" }, { x: w - 1.3, y: 1.2, kind: "frameS2" }],
  };
}

/** La salle calme : des livres, deux fauteuils, une lampe — on y lit. */
function quietPlan(): Plan {
  const w = 6.0, d = BAND_D;
  return {
    w, d, seats: [],
    fixtures: [
      fx("rug", w / 2, 3.2, 0, { len: 4.2, depth: 3.0, color: "#a3b58f" }),
      fx("bookcaseOpen", 0.95, 0.4), fx("bookcaseOpen", 1.85, 0.4), fx("bookcaseOpen", w - 1.85, 0.4), fx("bookcaseOpen", w - 0.95, 0.4),
      fx("plantSmall2", 0.95, 0.4, 0, { y: 1.8 }), fx("cactus_small_A", w - 0.95, 0.4, 0, { y: 1.8, s: 0.8 }),
      fx("armchair_pillows", w / 2 - 1.2, 3.3, Math.PI / 2), fx("armchair_pillows", w / 2 + 1.2, 3.3, -Math.PI / 2),
      fx("tableCoffeeSquare", w / 2, 3.3, 0, { s: 0.55 }), fx("lampRoundTable", w / 2, 3.3, 0, { y: 0.26, s: 0.8 }),
      fx("lamp_standing", 0.6, d - 0.7), fx("pottedPlant", w - 0.5, d - 0.6),
    ],
    spots: [
      sitOn(w / 2 - 1.1, 3.3, Math.PI / 2, SOFA_HIP), sitOn(w / 2 + 1.1, 3.3, -Math.PI / 2, SOFA_HIP),
      stand(1.4, 1.05, Math.PI), stand(w - 1.4, 1.05, Math.PI),
    ],
  };
}

/** Les box de travail : trois cabines, une personne chacune. */
function focusPlan(): Plan {
  const w = 6.8, d = BAND_D;
  const fixtures: LocalFix[] = [fx("rug", w / 2, 4.1, 0, { len: 4.8, depth: 1.6, color: "#9db3c9" })];
  const spots: LocalSpot[] = [];
  [1.3, 3.4, 5.5].forEach((x, i) => {
    fixtures.push(fx("booth", x, 1.0, 0, { color: BOOTH_COLORS[i] }));
    spots.push(sitOn(x, 1.35, Math.PI, CHAIR_HIP, "back"));
  });
  fixtures.push(fx("pottedPlant", 0.5, d - 0.5), fx("pottedPlant", w - 0.5, d - 0.5), fx("coatRackStanding", 0.5, 3.0));
  spots.push(stand(w / 2, 4.1));
  return { w, d, seats: [], fixtures, spots };
}

// ── L'assemblage ─────────────────────────────────────────────────────────────

interface Draft {
  key: string; kind: ZoneKind; label: string; color: string | null; teamId: string | null;
  style: TeamStyle | null; nook: NookKind | null; floor: FloorKind; plan: Plan;
  /** Pour une pièce de bandeau : vitrée, ouverte ou à porte ; et sa teinte. */
  front?: "door" | "glass" | "open";
  tint?: string;
}

type LocalWall = Omit<WallSeg, "nx" | "nz" | "art"> & { n: [number, number]; art?: LocalArt[] };

/** Élargit une pièce : son contenu se recentre, des plantes comblent les côtés. */
function widen(plan: Plan, W: number): Plan {
  if (W <= plan.w + 0.01) return plan;
  const dx = (W - plan.w) / 2;
  const fixtures = plan.fixtures.map((f) => ({ ...f, x: f.x + dx }));
  if (dx > 0.8) fixtures.push(fx("pottedPlant", 0.5, plan.d - 0.5), fx("pottedPlant", W - 0.5, plan.d - 0.5));
  return {
    ...plan, w: W, fixtures,
    seats: plan.seats.map((s) => ({ ...s, x: s.x + dx })),
    spots: plan.spots.map((s) => ({ ...s, x: s.x + dx, port: s.port ? [s.port[0] + dx, s.port[1]] as [number, number] : undefined })),
    art: plan.art?.map((a) => ({ ...a, x: a.x + dx })),
    core: plan.core ? [plan.core[0] + dx, plan.core[1]] : undefined,
  };
}

/** Les murs d'une pièce de bandeau, en repère local. */
function roomWalls(z: Draft, first: boolean, last: boolean): LocalWall[] {
  const { w, d } = z.plan;
  const out: LocalWall[] = [];
  const seg = (x1: number, z1: number, x2: number, z2: number, kind: WallKind, n: [number, number], extra: Partial<LocalWall> = {}) =>
    out.push({ x1, z1, x2, z2, kind, n, height: kind === "planter" ? 1.0 : WALL_H, windows: 0, ...extra });
  const glass = z.front === "glass";
  // Le fond : le mur extérieur, percé de fenêtres là où rien n'est accroché.
  seg(0, 0, w, 0, "solid", [0, -1], { windows: z.plan.art?.length ? 0 : Math.max(1, Math.round(w / 3.2)), color: z.tint, art: z.plan.art });
  // Chaque pièce dessine son mur gauche (partagé avec la voisine) ; la dernière, aussi le droit.
  seg(0, 0, 0, d, z.kind === "meeting" ? "glass" : "solid", [-1, 0], { windows: first ? 2 : 0, color: z.tint });
  if (last) seg(w, 0, w, d, "solid", [1, 0], { windows: 2, color: z.tint });
  // L'avant : une porte, une vitre avec porte, ou une large ouverture
  // bordée de jardinières.
  if (z.front === "open") {
    seg(0, d, w * 0.22, d, "planter", [0, 1]);
    seg(w * 0.78, d, w, d, "planter", [0, 1]);
  } else {
    const door = 1.6;
    const kind: WallKind = glass ? "glass" : "solid";
    seg(0, d, w / 2 - door / 2, d, kind, [0, 1], { color: z.tint });
    seg(w / 2 + door / 2, d, w, d, kind, [0, 1], { color: z.tint });
  }
  return out;
}

function mixHex(a: string, b: string, t: number) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (v: number, sh: number) => (v >> sh) & 255;
  return `#${[16, 8, 0].map((sh) => Math.round(ch(pa, sh) + (ch(pb, sh) - ch(pa, sh)) * t).toString(16).padStart(2, "0")).join("")}`;
}

export function computeLayout(teams: LayoutTeam[], agentIds: string[]): Layout {
  const present = new Set(agentIds);
  const placed = new Set<string>();
  const teamDrafts: Draft[] = teams.map((t, i) => {
    const ids = t.agentIds.filter((id) => present.has(id) && !placed.has(id));
    ids.forEach((id) => placed.add(id));
    // Un aménagement par équipe, chacun différent de celui de sa voisine.
    const style = STYLES[i % STYLES.length];
    return {
      key: `team:${t.id}`, kind: "team", label: t.name, color: t.color, teamId: t.id, style, nook: null,
      floor: FLOOR_OF[style], plan: PLAN_OF[style](ids, t.color),
    };
  });
  const rest = agentIds.filter((id) => !placed.has(id));
  if (rest.length || teams.length === 0) {
    const style = STYLES[teams.length % STYLES.length];
    teamDrafts.push({
      key: "open", kind: "open", label: teams.length ? "Open space" : "Plateau", color: "#c9b79c", teamId: null,
      style, nook: null, floor: FLOOR_OF[style], plan: PLAN_OF[style](rest, "#c9b79c"),
    });
  }

  // ── Le plateau : deux rangées d'équipes, des coins entre elles ──
  // Chaque équipe rejoint la rangée la plus courte : une nouvelle équipe
  // allonge le plateau, elle ne déplace personne.
  const rows: Draft[][] = [[], []];
  const rowW = (r: Draft[]) => r.reduce((s, z) => s + z.plan.w, 0);
  for (const t of teamDrafts) (rowW(rows[0]) <= rowW(rows[1]) ? rows[0] : rows[1]).push(t);
  const depthOf = (r: Draft[]) => Math.max(MIN_ROW_D, ...r.map((z) => z.plan.d));
  const D = [depthOf(rows[0]), depthOf(rows[1])];
  // Un coin entre deux équipes ; d'autres aux bouts, seulement pour que les
  // deux rangées aillent d'un mur à l'autre.
  let nookCount = 0;
  const makeNook = (ri: number): Draft => {
    const kind = NOOKS[(nookCount + ri * 2) % NOOKS.length];
    const k = nookCount++;
    return {
      key: `nook:${k}`, kind: "nook", label: NOOK_LABEL[kind], color: null, teamId: null, style: null, nook: kind,
      floor: kind === "coffee" ? "tile" : "none", plan: nookPlan(kind, D[ri], NOOK_W, k),
    };
  };
  const rowItems: Draft[][] = rows.map((r, ri) => {
    const items: Draft[] = [];
    r.forEach((t, i) => { if (i > 0) items.push(makeNook(ri)); items.push(t); });
    if (!items.length) items.push(makeNook(ri));
    return items;
  });

  // ── Les bandeaux de pièces communes ──
  const room = (key: string, kind: ZoneKind, label: string, floor: FloorKind, plan: Plan, front: Draft["front"], tint?: string): Draft =>
    ({ key, kind, label, color: null, teamId: null, style: null, nook: null, floor, plan, front, tint });
  const north: Draft[] = [
    room("meeting", "meeting", "Salle de réunion", "meeting", meetingPlan(), "glass"),
    room("memory", "memory", "Utilities", "tech", utilitiesPlan(), "door", "#8d96a6"),
    room("creative", "creative", "Atelier", "cork", creativePlan(), "door", "#e6c25a"),
  ];
  const south: Draft[] = [
    room("cafe", "cafe", "Café", "tile", cafePlan(), "open", "#d98f6b"),
    room("lounge", "lounge", "Salon", "lounge", loungePlan(), "open", "#9fb59a"),
    room("focus", "focus", "Box de travail", "carpet", focusPlan(), "glass", "#7aa6d8"),
  ];

  const L = Math.max(rowW(rowItems[0]) + 2 * MARGIN, rowW(rowItems[1]) + 2 * MARGIN, rowW(north), rowW(south));
  // La rangée la plus courte reçoit des coins à ses bouts, en alternant ;
  // ce qui reste se partage entre ses coins.
  rowItems.forEach((items, ri) => {
    let atEnd = true;
    while (rowW(items) + NOOK_W <= L - 2 * MARGIN + 0.01) {
      if (atEnd) items.push(makeNook(ri)); else items.unshift(makeNook(ri));
      atEnd = !atEnd;
    }
    const nooks = items.filter((z) => z.kind === "nook");
    if (!nooks.length) return;
    const extra = (L - 2 * MARGIN - rowW(items)) / nooks.length;
    nooks.forEach((z) => { z.plan = nookPlan(z.nook!, D[ri], z.plan.w + extra, Number(z.key.split(":")[1])); });
  });
  // Les bandeaux : d'autres pièces communes tant qu'il y a la place, plutôt
  // que des salles étirées et vides.
  const fillers: Array<[Draft[], () => Draft]> = [
    [north, () => room("huddle", "huddle", "Petite salle", "meeting", huddlePlan(), "glass")],
    [south, () => room("games", "lounge", "Salle de jeux", "wood", gamesPlan(), "door", "#5fa8a0")],
    [north, () => room("quiet", "creative", "Salle calme", "lounge", quietPlan(), "door", "#7f9a6b")],
    [south, () => room("huddle2", "huddle", "Salle d'échange", "meeting", huddlePlan(), "glass")],
  ];
  for (const [band, make] of fillers) {
    const z = make();
    if (rowW(band) + z.plan.w <= L + 0.01) band.push(z);
  }
  for (const band of [north, south]) {
    const extra = (L - rowW(band)) / band.length;
    for (const z of band) z.plan = widen(z.plan, z.plan.w + extra);
  }

  // ── Les coordonnées, du nord au sud ──
  const half = BOULEVARD / 2;
  const zRowA = -half - D[0];             // le fond de la rangée nord
  const zRowB = half;                     // le fond de la rangée sud (contre le boulevard)
  const hz0 = zRowA - AISLE;              // le plateau commence sous les pièces du nord…
  const hz1 = zRowB + D[1] + AISLE;       // …et finit au-dessus de celles du sud
  const x0 = -L / 2;
  const zones: Zone[] = [];

  const build = (dz: Draft, zx: number, zz: number, side: Zone["side"], mirror: boolean, walls: LocalWall[]) => {
    const { w, d } = dz.plan;
    const toWorld = (lx: number, lz: number): [number, number] => (mirror ? [zx + lx, zz + (d - lz)] : [zx + lx, zz + lz]);
    const rot = (r: number) => (mirror ? Math.PI - r : r);
    const seats: Seat[] = dz.plan.seats.map((s) => {
      const [x, z] = toWorld(s.x, s.z);
      return { agentId: s.agentId, x, z, facing: rot(s.facing), hip: s.hip, ax: x, az: z };
    });
    const fixtures: Fixture[] = dz.plan.fixtures.map((f) => {
      const [x, z] = toWorld(f.x, f.z);
      const { seatIndex, ...restF } = f;
      return { ...restF, x, z, rot: rot(f.rot), seat: seatIndex !== undefined ? seats[seatIndex] : undefined };
    });
    const spots = dz.plan.spots.map((s) => {
      const [x, z] = toWorld(s.x, s.z);
      const port = s.port ? (() => { const [px, pz] = toWorld(s.port![0], s.port![1]); return { x: px, z: pz }; })() : undefined;
      return { x, z, face: Number.isNaN(s.face) ? NaN : rot(s.face), sit: s.sit, ax: x, az: z, port, from: s.from, use: s.use };
    });
    const zSign = mirror ? -1 : 1;
    const wallsW: WallSeg[] = walls.map((wl) => {
      const [x1, z1] = toWorld(wl.x1, wl.z1);
      const [x2, z2] = toWorld(wl.x2, wl.z2);
      const { n, art, ...restW } = wl;
      const len = Math.hypot(wl.x2 - wl.x1, wl.z2 - wl.z1) || 1;
      return {
        ...restW, x1, z1, x2, z2, nx: n[0], nz: n[1] * zSign,
        art: art?.map((a) => ({ t: (a.x - wl.x1) / len, y: a.y, kind: a.kind })),
      };
    });
    const core = dz.plan.core ? (() => { const [x, z] = toWorld(dz.plan.core![0], dz.plan.core![1]); return { x, z }; })() : null;
    zones.push({
      key: dz.key, kind: dz.kind, label: dz.label, color: dz.color, teamId: dz.teamId, style: dz.style, nook: dz.nook,
      floor: dz.floor, x: zx, z: mirror ? zz : zz, w, d, side, seats,
      spots: spots as Array<Spot & { from?: "front" | "back" }>, fixtures, walls: wallsW, core,
    });
  };

  // Les rangées du plateau : le mur peint au nord de chaque équipe, son nom
  // tourné vers le sud — vers la caméra.
  rowItems.forEach((items, ri) => {
    let cx = x0 + MARGIN;
    const zBack = ri === 0 ? zRowA : zRowB;
    for (const dz of items) {
      const walls: LocalWall[] = dz.kind === "team" || dz.kind === "open"
        ? [{
            x1: 0.15, z1: 0, x2: dz.plan.w - 0.15, z2: 0, kind: "feature", n: [0, -1], height: FEATURE_H,
            windows: 0, color: dz.color ?? "#c9c2b6", text: dz.label, art: dz.plan.art,
          }]
        : [];
      build(dz, cx, zBack, "open", false, walls);
      cx += dz.plan.w;
    }
  });
  // Les bandeaux : au nord, la porte au sud ; au sud, en miroir.
  for (const [band, side] of [[north, "north"], [south, "south"]] as Array<[Draft[], "north" | "south"]>) {
    let cx = x0;
    band.forEach((dz, i) => {
      const zz = side === "north" ? hz0 - dz.plan.d : hz1;
      build(dz, cx, zz, side, side === "south", roomWalls(dz, i === 0, i === band.length - 1));
      cx += dz.plan.w;
    });
  }

  // ── Le plateau lui-même : ses murs, ses entrées, son boulevard ──
  const x1 = L / 2;
  const shell: WallSeg[] = [];
  for (const [x, nx] of [[x0, -1], [x1, 1]] as Array<[number, number]>) {
    shell.push(
      { x1: x, z1: hz0, x2: x, z2: -half, kind: "solid", height: WALL_H, nx, nz: 0, windows: Math.max(1, Math.round((-half - hz0) / 3)) },
      { x1: x, z1: half, x2: x, z2: hz1, kind: "solid", height: WALL_H, nx, nz: 0, windows: Math.max(1, Math.round((hz1 - half) / 3)) },
    );
  }
  const hallFixtures: Fixture[] = [];
  const hallSpots: Array<Spot & { from?: "front" | "back" }> = [];
  for (const [x, r] of [[x0 + 1.1, Math.PI / 2], [x1 - 1.1, -Math.PI / 2]] as Array<[number, number]>) {
    hallFixtures.push({ kind: "rug", x, z: 0, rot: r, len: 2.4, depth: 1.5, color: "#8b6f5a" });
    for (const sz of [-1, 1]) hallFixtures.push({ kind: "pottedPlant", x: x + (r > 0 ? -0.6 : 0.6), z: sz * (half - 0.35), rot: 0 });
  }
  // Des jardinières le long du boulevard, devant les coins de la rangée nord,
  // et de quoi s'y arrêter pour discuter.
  for (const z of zones) {
    if (z.kind !== "nook" || z.z + z.d > -half + 0.01 || z.z > -half) continue;
    const cx = z.x + z.w / 2;
    hallFixtures.push({ kind: "planterBox", x: cx, z: -half + 0.35, rot: 0, len: Math.min(2.0, z.w - 2.0), depth: 0.45 });
    hallSpots.push({ x: cx - 0.6, z: -half + 1.05, face: NaN, sit: null, ax: cx - 0.6, az: -half + 1.05 });
    hallSpots.push({ x: cx + 0.7, z: -half + 1.15, face: NaN, sit: null, ax: cx + 0.7, az: -half + 1.15 });
  }

  const building = { minX: x0, maxX: x1, minZ: hz0 - BAND_D, maxZ: hz1 + BAND_D };
  const hall: Hall = { x0, x1, z0: hz0, z1: hz1, half, spots: hallSpots, fixtures: hallFixtures };
  const nav = buildNavGrid(zones, hall, shell, building);

  // ── La vérification : chaque siège s'aborde, chaque halte est accessible ──
  const issues: string[] = [];
  for (const z of zones) {
    for (const s of z.seats) {
      const a = approachPoint(nav, s.x, s.z, s.facing, "back") ?? nearestFree(nav, s.x, s.z);
      if (!a) issues.push(`${z.key}: siège sans accès (${s.x.toFixed(1)}, ${s.z.toFixed(1)})`);
      else { s.ax = a.x; s.az = a.z; }
    }
    z.spots = settleSpots(nav, z.spots as Array<Spot & { from?: "front" | "back" }>, z.key, issues);
  }
  hall.spots = settleSpots(nav, hallSpots, "hall", issues);

  const seatOf = new Map<string, { seat: Seat; zone: Zone }>();
  for (const z of zones) for (const s of z.seats) if (s.agentId) seatOf.set(s.agentId, { seat: s, zone: z });
  const find = (k: ZoneKind) => zones.find((z) => z.kind === k) ?? null;

  return {
    zones, seatOf, hall, shell, building, nav, issues,
    lounge: find("lounge"), cafe: find("cafe"), memory: find("memory"), meeting: find("meeting"), focus: find("focus"),
    commons: zones.filter((z) => (z.kind === "nook" || z.kind === "lounge" || z.kind === "cafe" || z.kind === "focus" || z.kind === "creative" || z.kind === "huddle") && z.spots.length > 0),
    bounds: {
      minX: building.minX - GARDEN, maxX: building.maxX + GARDEN,
      minZ: building.minZ - GARDEN, maxZ: building.maxZ + GARDEN,
    },
  };
}

/** Garde les haltes qu'on peut atteindre, et calcule d'où aborder chaque place
 *  assise. Une halte inaccessible est écartée plutôt que d'y envoyer un agent
 *  à travers un meuble. */
function settleSpots(nav: NavGrid, spots: Array<Spot & { from?: "front" | "back" }>, key: string, issues: string[]): Spot[] {
  const out: Spot[] = [];
  for (const s of spots) {
    const { from, ...spot } = s;
    if (spot.sit === null) {
      if (isFree(nav, spot.x, spot.z)) { out.push({ ...spot, ax: spot.x, az: spot.z }); continue; }
      const p = nearestFree(nav, spot.x, spot.z, 0.5);
      if (p) { out.push({ ...spot, x: p.x, z: p.z, ax: p.x, az: p.z }); continue; }
      issues.push(`${key}: halte bloquée (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)})`);
      continue;
    }
    const a = approachPoint(nav, spot.x, spot.z, spot.face, from ?? "front");
    if (a) out.push({ ...spot, ax: a.x, az: a.z });
    else issues.push(`${key}: place sans accès (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)})`);
  }
  return out;
}
