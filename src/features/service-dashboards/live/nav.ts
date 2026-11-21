import type { Fixture, Hall, Zone, WallSeg } from "./layout";

// La NAVIGATION du Live Space : où l'on peut marcher, et par où passer.
//
// Une grille de cellules de 20 cm sur tout le bâtiment. Une cellule est
// libre si elle est dans une pièce ou dans le couloir, hors de tout mur, de
// toute cloison et de tout meuble — chaque obstacle étant GONFLÉ du rayon
// d'un agent, pour qu'on ne frôle pas les arêtes. Les trajets se calculent
// par A* sur cette grille, puis se lissent : on coupe en ligne droite partout
// où rien ne s'interpose, ce qui donne des chemins naturels plutôt que des
// escaliers de cellules.
//
// La grille est tirée du MÊME plan que celui que dessine la scène : un meuble
// qu'on voit est un meuble qui bloque.

export interface NavGrid {
  cell: number;
  x0: number;
  z0: number;
  cols: number;
  rows: number;
  /** 1 = bloqué. */
  blocked: Uint8Array;
}

export interface P { x: number; z: number }

/** Le rayon d'un agent : la marge laissée autour de chaque obstacle. */
export const AGENT_RADIUS = 0.24;
const CELL = 0.2;

/** L'emprise au sol d'un meuble, dans son propre repère (largeur x, profondeur z),
 *  avant mise à l'échelle. Absent : il ne bloque pas (on s'assoit dessus, ou il
 *  est accroché au mur). */
const FOOTPRINT: Record<string, Array<[number, number, number, number]>> = {
  // [centre x, centre z, largeur, profondeur]
  workstation: [[0, 0, 1.5, 0.8]],
  benchTable: [[0, 0, 1, 0.95]],          // la largeur est prise sur `len`
  roundTable: [[0, 0, 1.45, 1.45]],
  meetingTable: [[0, 0, 1, 1.3]],         // idem
  whiteboard: [[0, 0, 1.6, 0.3]],
  cabinetTelevision: [[0, 0, 1.63, 0.51]],
  loungeChairRelax: [[0, 0, 0.95, 1.2]],
  tableCoffee: [[0, 0, 1.35, 0.82]],
  tableCoffeeGlass: [[0, 0, 1.35, 0.82]],
  tableCoffeeSquare: [[0, 0, 0.82, 0.82]],
  couch_pillows: [[0, 0, 2.1, 1.12]],
  couch: [[0, 0, 2.1, 1.12]],
  armchair_pillows: [[0, 0, 1.26, 1.12]],
  armchair: [[0, 0, 1.26, 1.12]],
  table_low: [[0, 0, 1.68, 1.05]],
  table_medium: [[0, 0, 1.4, 1.4]],
  table_medium_long: [[0, 0, 2.1, 1.4]],
  lamp_standing: [[0, 0, 0.5, 0.5]],
  lampRoundFloor: [[0, 0, 0.35, 0.35]],
  lampSquareFloor: [[0, 0, 0.28, 0.28]],
  cabinet_medium_decorated: [[0, 0, 1.43, 0.7]],
  cabinet_small_decorated: [[0, 0, 0.73, 0.77]],
  kitchenBar: [[0, 0, 0.88, 0.43]],
  kitchenCabinet: [[0, 0, 0.88, 0.92]],
  kitchenSink: [[0, 0, 0.88, 0.92]],
  kitchenFridge: [[0, 0, 0.88, 0.6]],
  kitchenFridgeSmall: [[0, 0, 0.88, 0.6]],
  stoolBar: [[0, 0, 0.45, 0.45]],
  stoolBarSquare: [[0, 0, 0.31, 0.3]],
  speaker: [[0, 0, 0.3, 0.3]],
  speakerSmall: [[0, 0, 0.3, 0.27]],
  pottedPlant: [[0, 0, 0.45, 0.5]],
  serverRack: [[0, 0, 0.7, 0.6]],
  hvac: [[0, 0, 1.1, 0.7]],
  pipes: [[0, 0, 0.3, 1]],                // la profondeur est prise sur `len`
  electricPanel: [[0, 0, 0.7, 0.2]],
  // Une cabine : ses deux parois latérales et la tablette du fond ; l'avant
  // est ouvert, on y entre.
  booth: [[-0.8, 0, 0.1, 1.6], [0.8, 0, 0.1, 1.6], [0, -0.55, 1.0, 0.4]],
  sideTable: [[0, 0, 1.09, 0.45]],
  sideTableDrawers: [[0, 0, 1.09, 0.45]],
  bookcaseOpen: [[0, 0, 0.82, 0.51]],
  bookcaseOpenLow: [[0, 0, 0.82, 0.51]],
  bookcaseClosedWide: [[0, 0, 1.63, 0.51]],
  coatRackStanding: [[0, 0, 0.5, 0.5]],
  trashcan: [[0, 0, 0.42, 0.45]],
  cactus_medium_A: [[0, 0, 0.6, 0.6]],
  cactus_medium_B: [[0, 0, 0.6, 0.6]],
  benchCushion: [[0, 0, 0.82, 0.41]],
  cardboardBoxClosed: [[0, 0, 0.43, 0.43]],
  planterBox: [[0, 0, 1, 0.45]],          // `len` × `depth`
  planterBig: [[0, 0, 1, 1]],             // idem
  pingpong: [[0, 0, 1.5, 2.6]],
  skillCabinet: [[0, 0, 1, 0.55]],        // la largeur est prise sur `len`
  pouf: [[0, 0, 0.52, 0.52]],
};

/** Les éléments dessinés à la mesure : leur emprise suit `len` et `depth`. */
const MEASURED = new Set(["benchTable", "meetingTable", "planterBox", "planterBig", "skillCabinet"]);

export function buildNavGrid(
  zones: Zone[],
  hall: Hall,
  shell: WallSeg[],
  building: { minX: number; maxX: number; minZ: number; maxZ: number },
): NavGrid {
  const x0 = building.minX - 0.4, z0 = building.minZ - 0.4;
  const cols = Math.ceil((building.maxX - building.minX + 0.8) / CELL);
  const rows = Math.ceil((building.maxZ - building.minZ + 0.8) / CELL);
  const blocked = new Uint8Array(cols * rows).fill(1);
  const grid: NavGrid = { cell: CELL, x0, z0, cols, rows, blocked };

  // 1. Le sol praticable : tout le plateau, et chaque pièce des bandeaux.
  const floor = (minX: number, maxX: number, minZ: number, maxZ: number) => {
    forCells(grid, minX, maxX, minZ, maxZ, (i) => { blocked[i] = 0; });
  };
  floor(hall.x0, hall.x1, hall.z0, hall.z1);
  for (const z of zones) floor(z.x, z.x + z.w, z.z, z.z + z.d);

  // 2. Les murs, cloisons et façades.
  const R = AGENT_RADIUS;
  for (const z of zones) for (const w of z.walls) blockWall(grid, w, R);
  for (const w of shell) blockWall(grid, w, R);

  // 3. Les meubles.
  const blockFix = (f: Fixture) => {
    const fp = FOOTPRINT[f.kind];
    // Ce qui est posé SUR un meuble ne bloque rien de plus que lui.
    if (!fp || (f.y ?? 0) > 0) return;
    const s = f.s ?? 1;
    for (const [cx, cz, w, d] of fp) {
      const ww = MEASURED.has(f.kind) ? (f.len ?? w) : w * s;
      const dd = f.kind === "pipes" ? (f.len ?? d) : MEASURED.has(f.kind) && f.kind.startsWith("planter") ? (f.depth ?? d) : d * s;
      // Le centre local tourne avec le meuble.
      const wx = f.x + cx * Math.cos(f.rot) + cz * Math.sin(f.rot);
      const wz = f.z - cx * Math.sin(f.rot) + cz * Math.cos(f.rot);
      blockRect(grid, wx, wz, ww / 2 + R, dd / 2 + R, f.rot);
    }
  };
  for (const z of zones) {
    for (const f of z.fixtures) blockFix(f);
    // Le silo et ses bornes.
    if (z.core) {
      blockDisc(grid, z.core.x, z.core.z, 1.2 + R);
      for (const s of z.spots) if (s.port) blockRect(grid, s.port.x, s.port.z, 0.15 + R * 0.6, 0.15 + R * 0.6, 0);
    }
  }
  for (const f of hall.fixtures) blockFix(f);

  // 4. Les points où l'on doit pouvoir se tenir restent libres, quoi qu'il
  //    arrive : une chaise rangée trop près d'une table ne doit pas devenir
  //    inaccessible.
  const keep = (x: number, z: number) => forCells(grid, x - 0.15, x + 0.15, z - 0.15, z + 0.15, (i) => { blocked[i] = 0; });
  for (const z of zones) {
    for (const s of z.seats) keep(s.x, s.z);
    for (const s of z.spots) if (s.sit === null) keep(s.x, s.z);
  }
  return grid;
}

function forCells(g: NavGrid, minX: number, maxX: number, minZ: number, maxZ: number, fn: (i: number) => void) {
  const c0 = Math.max(0, Math.floor((minX - g.x0) / g.cell));
  const c1 = Math.min(g.cols - 1, Math.floor((maxX - g.x0) / g.cell));
  const r0 = Math.max(0, Math.floor((minZ - g.z0) / g.cell));
  const r1 = Math.min(g.rows - 1, Math.floor((maxZ - g.z0) / g.cell));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const cx = g.x0 + (c + 0.5) * g.cell, cz = g.z0 + (r + 0.5) * g.cell;
    if (cx >= minX && cx <= maxX && cz >= minZ && cz <= maxZ) fn(r * g.cols + c);
  }
}

/** Un rectangle tourné : `rot` est sa direction de façade (local +z). */
function blockRect(g: NavGrid, cx: number, cz: number, hw: number, hd: number, rot: number) {
  const reach = Math.hypot(hw, hd);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  forCells(g, cx - reach, cx + reach, cz - reach, cz + reach, (i) => {
    const px = g.x0 + ((i % g.cols) + 0.5) * g.cell - cx;
    const pz = g.z0 + (Math.floor(i / g.cols) + 0.5) * g.cell - cz;
    const lx = px * cos - pz * sin;
    const lz = px * sin + pz * cos;
    if (Math.abs(lx) <= hw && Math.abs(lz) <= hd) g.blocked[i] = 1;
  });
}

function blockDisc(g: NavGrid, cx: number, cz: number, r: number) {
  forCells(g, cx - r, cx + r, cz - r, cz + r, (i) => {
    const px = g.x0 + ((i % g.cols) + 0.5) * g.cell - cx;
    const pz = g.z0 + (Math.floor(i / g.cols) + 0.5) * g.cell - cz;
    if (px * px + pz * pz <= r * r) g.blocked[i] = 1;
  });
}

function blockWall(g: NavGrid, w: WallSeg, r: number) {
  const cx = (w.x1 + w.x2) / 2, cz = (w.z1 + w.z2) / 2;
  const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
  // La direction du mur sert d'axe local x : sa « façade » est perpendiculaire.
  const along = Math.atan2(w.x2 - w.x1, w.z2 - w.z1);
  blockRect(g, cx, cz, 0.06 + r, len / 2 + r * 0.5, along);
}

const idx = (g: NavGrid, x: number, z: number) => {
  const c = Math.floor((x - g.x0) / g.cell), r = Math.floor((z - g.z0) / g.cell);
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return -1;
  return r * g.cols + c;
};

export function isFree(g: NavGrid, x: number, z: number): boolean {
  const i = idx(g, x, z);
  return i >= 0 && g.blocked[i] === 0;
}

/** La cellule libre la plus proche — un point légèrement dans un meuble
 *  (le bord d'une chaise, un pas de côté) se rabat sur le sol praticable. */
export function nearestFree(g: NavGrid, x: number, z: number, maxR = 1.6): P | null {
  if (isFree(g, x, z)) return { x, z };
  for (let r = g.cell; r <= maxR; r += g.cell) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
      if (isFree(g, px, pz)) return { x: px, z: pz };
    }
  }
  return null;
}

/**
 * D'où aborder une place assise : un point libre du côté voulu (`back`,
 * derrière une chaise ; `front`, devant un canapé), d'où le dernier pas, en
 * ligne droite, ne traverse QUE le meuble de la place — jamais une table
 * basse, un voisin ou un mur en chemin. On essaie droit devant, puis de
 * biais, puis plus loin.
 */
export function approachPoint(g: NavGrid, x: number, z: number, facing: number, side: "front" | "back"): P | null {
  const base = side === "front" ? facing : facing + Math.PI;
  for (const r of [0.7, 0.9, 1.15]) {
    for (const a of [0, 0.45, -0.45, 0.9, -0.9, 1.3, -1.3]) {
      const px = x + Math.sin(base + a) * r, pz = z + Math.cos(base + a) * r;
      if (isFree(g, px, pz) && cleanLeg(g, { x: px, z: pz }, { x, z })) return { x: px, z: pz };
    }
  }
  return null;
}

/** Le dernier pas : libre, puis — s'il entre dans un meuble — il y reste
 *  jusqu'à la place, sur moins d'un mètre. Ressortir puis rentrer voudrait
 *  dire traverser autre chose. */
function cleanLeg(g: NavGrid, a: P, b: P): boolean {
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(2, Math.ceil(d / 0.05));
  let entered = -1;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const free = isFree(g, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    if (!free && entered < 0) entered = k;
    if (free && entered >= 0) return false;
  }
  return entered < 0 || ((n - entered) / n) * d <= 0.95;
}

/** Rien ne s'interpose entre deux points : on peut y aller tout droit. */
export function lineOfSight(g: NavGrid, a: P, b: P): boolean {
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(d / (g.cell * 0.5)));
  for (let k = 1; k < n; k++) {
    const t = k / n;
    if (!isFree(g, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false;
  }
  return true;
}

/** A* sur la grille, en 8 directions sans couper les coins, puis lissage. */
export function findPath(g: NavGrid, from: P, to: P): P[] | null {
  const s = nearestFree(g, from.x, from.z);
  const t = nearestFree(g, to.x, to.z);
  if (!s || !t) return null;
  const start = idx(g, s.x, s.z), goal = idx(g, t.x, t.z);
  if (start < 0 || goal < 0) return null;
  if (start === goal || lineOfSight(g, s, t)) return [t];

  const n = g.cols * g.rows;
  const gScore = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  const gc = goal % g.cols, gr = Math.floor(goal / g.cols);
  const h = (i: number) => {
    const dc = Math.abs((i % g.cols) - gc), dr = Math.abs(Math.floor(i / g.cols) - gr);
    return (dc + dr) + (Math.SQRT2 - 2) * Math.min(dc, dr);
  };
  gScore[start] = 0;
  heap.push(start, h(start));
  const DIRS: Array<[number, number, number]> = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];
  let found = false;
  let guard = 0;
  while (heap.size && guard++ < 200000) {
    const cur = heap.pop();
    if (cur === goal) { found = true; break; }
    if (closed[cur]) continue;
    closed[cur] = 1;
    const c = cur % g.cols, r = Math.floor(cur / g.cols);
    for (const [dc, dr, cost] of DIRS) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue;
      const ni = nr * g.cols + nc;
      if (g.blocked[ni] || closed[ni]) continue;
      // En diagonale, les deux cellules voisines doivent être libres : on ne
      // rase pas l'angle d'un meuble.
      if (dc && dr && (g.blocked[r * g.cols + nc] || g.blocked[nr * g.cols + c])) continue;
      const ng = gScore[cur] + cost;
      if (ng < gScore[ni]) {
        gScore[ni] = ng;
        came[ni] = cur;
        heap.push(ni, ng + h(ni));
      }
    }
  }
  if (!found) return null;

  const cells: P[] = [];
  for (let i = goal; i !== -1 && i !== start; i = came[i]) {
    cells.push({ x: g.x0 + ((i % g.cols) + 0.5) * g.cell, z: g.z0 + (Math.floor(i / g.cols) + 0.5) * g.cell });
  }
  cells.reverse();
  cells[cells.length - 1] = t;

  // Lissage : de chaque point, on file au plus loin qu'on voit.
  const out: P[] = [];
  let anchor = s;
  let k = 0;
  while (k < cells.length) {
    let far = k;
    for (let j = cells.length - 1; j > k; j--) {
      if (lineOfSight(g, anchor, cells[j])) { far = j; break; }
    }
    out.push(cells[far]);
    anchor = cells[far];
    k = far + 1;
  }
  return out;
}

class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];
  get size() { return this.items.length; }
  push(item: number, key: number) {
    this.items.push(item); this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      [this.items[p], this.items[i]] = [this.items[i], this.items[p]];
      [this.keys[p], this.keys[i]] = [this.keys[i], this.keys[p]];
      i = p;
    }
  }
  pop(): number {
    const top = this.items[0];
    const lastI = this.items.pop()!, lastK = this.keys.pop()!;
    if (this.items.length) {
      this.items[0] = lastI; this.keys[0] = lastK;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.items.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.items.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        [this.items[m], this.items[i]] = [this.items[i], this.items[m]];
        [this.keys[m], this.keys[i]] = [this.keys[i], this.keys[m]];
        i = m;
      }
    }
    return top;
  }
}
