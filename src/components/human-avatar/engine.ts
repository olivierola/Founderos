import {
  BoxGeometry, CanvasTexture, CapsuleGeometry, CircleGeometry, ClampToEdgeWrapping, Color, ConeGeometry, CylinderGeometry, RepeatWrapping, DataTexture, DirectionalLight,
  DoubleSide, Group, HemisphereLight, InstancedMesh, LatheGeometry, Mesh, MeshBasicMaterial,
  MeshPhysicalMaterial, MeshStandardMaterial, MeshToonMaterial, NearestFilter, NeutralToneMapping,
  Object3D, PerspectiveCamera, RedFormat, Scene, SphereGeometry, SplineCurve, SRGBColorSpace,
  TorusGeometry, Vector2, Vector3, WebGLRenderer,
  type BufferGeometry, type Material, type Side,
} from "three";
import type { Build, FaceShape, HumanMaterial, Mouth, ResolvedHumanLook } from "@/lib/human-avatar-look";
import { Motion, followTarget, type HumanState } from "./motion";

// The 3D humanoid avatars — a stylised bust built from primitives, lit like a
// toy and animated: it breathes, blinks, looks around, follows the pointer,
// waves when poked, types when it works, dozes when it sleeps.
//
// ONE WebGL context draws every one of them. Browsers allow only a handful of
// contexts per page (the orb already ran out of them once), so a context per
// avatar was never an option on a grid of cards. Each avatar keeps a plain 2D
// canvas; every frame the shared renderer draws the avatars that are due into
// a corner of its own canvas and copies that corner across. Avatars off screen
// or in a hidden tab are not drawn at all; idle ones at 30 frames a second,
// the ones being played with at 60.
//
// This module is loaded on demand (see HumanAvatar.tsx): three.js stays out of
// the page until a person is actually on screen.

export type { HumanState };

export interface HumanOptions {
  look: ResolvedHumanLook;
  state: HumanState;
  paused: boolean;
  interactive: boolean;
  /** Head and shoulders only — small avatars, where a whole bust would leave a face of a few pixels. */
  closeUp: boolean;
  /** 0–1: offsets the idle loops so a row of them does not blink in unison. */
  offset: number;
}

export interface HumanHandle {
  update(opts: Partial<HumanOptions>): void;
  /** The canvas changed size. */
  resize(): void;
  /** A wave and a little hop — what a click does. */
  poke(): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ *
 * The shared renderer and the frame loop.
 * ------------------------------------------------------------------ */

let renderer: WebGLRenderer | null = null;
let unavailable = false;
let contextLost = false;
let bufW = 0;
let bufH = 0;
const instances = new Set<Human>();
const byCanvas = new WeakMap<Element, Human>();
const pointer = { x: -1e5, y: -1e5 };
let raf = 0;

function sharedRenderer(): WebGLRenderer | null {
  if (renderer || unavailable) return renderer;
  try {
    const canvas = document.createElement("canvas");
    const r = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    r.setPixelRatio(1);
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = NeutralToneMapping;
    r.setClearColor(0x000000, 0);
    r.autoClear = false;
    canvas.addEventListener("webglcontextlost", () => { contextLost = true; });
    canvas.addEventListener("webglcontextrestored", () => {
      contextLost = false;
      for (const h of instances) h.dirty = true;
    });
    renderer = r;
  } catch {
    // WebGL refused (blocked after a GPU reset, turned off…): the component
    // shows its fallback instead.
    unavailable = true;
  }
  return renderer;
}

const visibility = typeof IntersectionObserver !== "undefined"
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        const h = byCanvas.get(e.target);
        if (h) { h.visible = e.isIntersecting; if (h.visible) h.dirty = true; }
      }
    }, { rootMargin: "120px" })
  : null;

const onPointer = (e: PointerEvent) => { pointer.x = e.clientX; pointer.y = e.clientY; };

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function tick(now: number) {
  raf = 0;
  if (!instances.size) return;
  raf = requestAnimationFrame(tick);
  if (document.hidden || contextLost) return;
  const r = sharedRenderer();
  if (!r) return;
  const still = reducedMotion();
  const due: Human[] = [];
  for (const h of instances) if (h.isDue(now, still)) due.push(h);
  if (!due.length) return;

  // The drawing buffer only grows: resizing it is a reallocation.
  let w = bufW;
  let hgt = bufH;
  for (const h of due) { w = Math.max(w, h.pw); hgt = Math.max(hgt, h.ph); }
  if (w !== bufW || hgt !== bufH) { r.setSize(w, hgt, false); bufW = w; bufH = hgt; }

  r.setScissorTest(true);
  for (const h of due) {
    try { h.draw(r, now, still); } catch { /* one broken avatar must not stop the others */ }
  }
}

function start() {
  if (!raf) raf = requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ *
 * Materials and shared geometry.
 * ------------------------------------------------------------------ */

let toonRamp: DataTexture | null = null;
function ramp(): DataTexture {
  if (!toonRamp) {
    toonRamp = new DataTexture(new Uint8Array([96, 178, 255]), 3, 1, RedFormat);
    toonRamp.minFilter = NearestFilter;
    toonRamp.magFilter = NearestFilter;
    toonRamp.needsUpdate = true;
  }
  return toonRamp;
}

// Strands: thin streaks of grey, read as bumps, so the light breaks along the
// hair instead of sliding over a helmet. On a sphere the texture runs from the
// crown down, the way hair is combed.
let strandTexture: CanvasTexture | null = null;
function strands(): CanvasTexture {
  if (!strandTexture) {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 128;
    const g = c.getContext("2d")!;
    g.fillStyle = "#808080";
    g.fillRect(0, 0, c.width, c.height);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 420; i++) {
      const x = rand() * c.width;
      g.strokeStyle = rand() < 0.5 ? `rgba(40,40,40,${0.25 + rand() * 0.4})` : `rgba(220,220,220,${0.2 + rand() * 0.35})`;
      g.lineWidth = 1 + rand() * 2.2;
      g.beginPath();
      g.moveTo(x, 0);
      g.bezierCurveTo(x + (rand() - 0.5) * 14, c.height * 0.35, x + (rand() - 0.5) * 14, c.height * 0.7, x + (rand() - 0.5) * 10, c.height);
      g.stroke();
    }
    strandTexture = new CanvasTexture(c);
    strandTexture.wrapS = RepeatWrapping;
    strandTexture.wrapT = ClampToEdgeWrapping;
  }
  return strandTexture;
}

/**
 * A material for a part. `fabric` gives clay cloth a velvet sheen, `soft`
 * gives clay skin and hair a faint one — the light catching at the edges is
 * what reads as cloth and skin rather than painted plaster.
 */
function surface(
  kind: HumanMaterial,
  colour: Color | string,
  opts: { gloss?: boolean; opacity?: number; side?: Side; fabric?: boolean; soft?: boolean; strands?: boolean } = {},
): Material {
  const color = colour instanceof Color ? colour : new Color(colour);
  let m: Material;
  if (kind === "toon") m = new MeshToonMaterial({ color, gradientMap: ramp() });
  else if (opts.gloss) m = new MeshPhysicalMaterial({ color, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08 });
  else if (kind === "vinyl") m = new MeshPhysicalMaterial({ color, roughness: 0.36, clearcoat: 0.75, clearcoatRoughness: 0.22 });
  else if (opts.fabric) m = new MeshPhysicalMaterial({ color, roughness: 0.85, sheen: 0.8, sheenRoughness: 0.55, sheenColor: color.clone().lerp(new Color(0xffffff), 0.45) });
  else if (opts.soft) m = new MeshPhysicalMaterial({ color, roughness: 0.62, sheen: 0.35, sheenRoughness: 0.7, sheenColor: color.clone().lerp(new Color(0xffffff), 0.5) });
  else m = new MeshStandardMaterial({ color, roughness: 0.8, metalness: 0 });
  if (opts.strands) {
    const lit = m as MeshStandardMaterial;
    lit.bumpMap = strands();
    lit.bumpScale = 2.2;
  }
  if (opts.opacity !== undefined) { m.transparent = true; m.opacity = opts.opacity; m.depthWrite = false; }
  if (opts.side !== undefined) m.side = opts.side;
  return m;
}

const shade = (hex: string, f: number) => new Color(hex).multiplyScalar(f);

// Geometry is shared by every avatar on the page and never disposed: there
// are a few dozen shapes, and rebuilding them per avatar would only churn.
const geometries = new Map<string, BufferGeometry>();
function geo<T extends BufferGeometry>(key: string, make: () => T): T {
  let g = geometries.get(key);
  if (!g) { g = make(); geometries.set(key, g); }
  return g as T;
}

const sphere = (r: number, w = 32, h = 20) => geo(`sphere:${r}:${w}`, () => new SphereGeometry(r, w, h));
/** The top of a sphere, down to `theta` from the pole. */
const cap = (r: number, theta: number) => geo(`cap:${r}:${theta}`, () => new SphereGeometry(r, 40, 24, 0, Math.PI * 2, 0, theta));
/** A band of a sphere round the back and sides, open at the face. */
const curtain = (r: number, from: number, length: number, gap: number) =>
  geo(`curtain:${r}:${from}:${length}:${gap}`, () =>
    new SphereGeometry(r, 40, 20, Math.PI / 2 + gap, Math.PI * 2 - gap * 2, from, length));
/** A band of a sphere round the front, under the face (beards). */
const jaw = (r: number, from: number, length: number, width: number) =>
  geo(`jaw:${r}:${from}:${length}:${width}`, () =>
    new SphereGeometry(r, 40, 16, Math.PI / 2 - width / 2, width, from, length));

// The torso: a rounded bean, as a profile turned round the vertical axis and
// then flattened front to back.
const TORSO = new SplineCurve([
  [0, -2.45], [0.7, -2.42], [1.0, -2.3], [1.15, -2.05], [1.2, -1.7], [1.18, -1.4],
  [1.08, -1.18], [0.85, -1.0], [0.55, -0.9], [0.32, -0.86], [0, -0.84],
].map(([x, y]) => new Vector2(x, y))).getPoints(48);
const TORSO_DEPTH = 0.62;

/** Even points over a unit sphere (a Fibonacci lattice). */
function lattice(n: number): Vector3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    return new Vector3(Math.cos(golden * i) * r, y, Math.sin(golden * i) * r);
  });
}

/* ------------------------------------------------------------------ *
 * The figure.
 * ------------------------------------------------------------------ */

const HEAD_PIVOT_Y = -0.6;
/** From the neck pivot to the centre of the head. */
const HEAD_RISE = 0.95;
/** The skull is a sphere of radius 1, a little shallow — then shaped by the face. */
const SKULLS: Record<FaceShape, Vector3> = {
  round: new Vector3(1, 1.02, 0.94),
  oval: new Vector3(0.95, 1.08, 0.94),
  square: new Vector3(1.03, 1.0, 0.94),
};
const BUILD_WIDTH: Record<Build, number> = { slim: 0.9, regular: 1, broad: 1.12 };

interface Rig {
  root: Group;
  body: Group;
  head: Group;
  eyes: Group[];
  brows: Object3D[];
  mouths: Record<Mouth | "o", Object3D>;
  arms: [Group, Group];
  laptop: Group;
  materials: Material[];
  disposables: { dispose(): void }[];
}

function buildFigure(look: ResolvedHumanLook): Rig {
  const materials: Material[] = [];
  const disposables: { dispose(): void }[] = [];
  const mat = (colour: Color | string, opts?: Parameters<typeof surface>[2]) => {
    const m = surface(look.material, colour, opts);
    materials.push(m);
    return m;
  };
  const mesh = (g: BufferGeometry, m: Material, x = 0, y = 0, z = 0) => {
    const o = new Mesh(g, m);
    o.position.set(x, y, z);
    return o;
  };

  const SKULL = SKULLS[look.face];
  const width = BUILD_WIDTH[look.build];
  const skin = mat(look.skin, { soft: true });
  const skinShade = mat(shade(look.skin, 0.88), { soft: true });
  const hair = mat(look.hairColor, { side: DoubleSide, soft: true, strands: true });
  const brow = mat(shade(look.hairColor, 0.8));
  const cloth = mat(look.outfitColor, { fabric: true });
  const clothShade = mat(shade(look.outfitColor, 0.78), { fabric: true });
  const accent = mat(look.accentColor);
  const acc = mat(look.accessoryColor);
  const ink = mat("#2a1a1c");
  const iris = mat(look.eyes, { gloss: true });
  const spark = new MeshBasicMaterial({ color: 0xffffff });
  materials.push(spark);

  const root = new Group();
  const body = new Group();
  root.add(body);

  // — Body —
  const torso = mesh(geo("torso", () => new LatheGeometry(TORSO, 48)), cloth);
  torso.scale.set(width, 1, TORSO_DEPTH);
  body.add(torso);
  body.add(mesh(geo("neck", () => new CylinderGeometry(0.3, 0.34, 0.6, 24)), skinShade, 0, -0.75, 0));

  const arm = (side: 1 | -1) => {
    const pivot = new Group();
    pivot.position.set(side * 1.1 * width, -1.3, 0);
    pivot.add(mesh(geo("sleeve", () => new CapsuleGeometry(0.25, 0.7, 6, 16)), cloth, 0, -0.45, 0));
    pivot.add(mesh(sphere(0.2, 20, 14), skin, 0, -0.98, 0));
    body.add(pivot);
    return pivot;
  };
  const arms: [Group, Group] = [arm(1), arm(-1)];

  // Outfit details, on the chest.
  const chestZ = (y: number) => {
    // The torso's front surface at a height, read off its profile.
    let r = 0;
    for (let i = 1; i < TORSO.length; i++) {
      const a = TORSO[i - 1], b = TORSO[i];
      if ((a.y - y) * (b.y - y) <= 0) { r = a.x + ((y - a.y) / (b.y - a.y || 1)) * (b.x - a.x); break; }
    }
    return r * TORSO_DEPTH;
  };
  switch (look.outfit) {
    case "tshirt": {
      const collar = mesh(geo("collar", () => new TorusGeometry(0.36, 0.06, 10, 32)), clothShade, 0, -0.9, 0);
      collar.rotation.x = Math.PI / 2;
      body.add(collar);
      break;
    }
    case "turtleneck": {
      body.add(mesh(geo("turtle", () => new CylinderGeometry(0.37, 0.42, 0.46, 28)), cloth, 0, -0.82, 0));
      const rim = mesh(geo("turtle-rim", () => new TorusGeometry(0.37, 0.07, 10, 32)), clothShade, 0, -0.6, 0);
      rim.rotation.x = Math.PI / 2;
      body.add(rim);
      break;
    }
    case "hoodie": {
      const hood = mesh(geo("hood", () => new TorusGeometry(0.62, 0.26, 12, 36)), clothShade, 0, -0.95, -0.3);
      hood.rotation.x = Math.PI / 2 - 0.35;
      body.add(hood);
      for (const side of [1, -1]) {
        const y = -1.3;
        const cord = mesh(geo("cord", () => new CylinderGeometry(0.025, 0.025, 0.5, 8)), accent, side * 0.17, y, chestZ(y) + 0.03);
        cord.rotation.x = -0.25;
        body.add(cord, mesh(sphere(0.05, 10, 8), accent, side * 0.17, y - 0.27, chestZ(y - 0.27) + 0.05));
      }
      break;
    }
    case "shirt": {
      const collar = mesh(geo("collar", () => new TorusGeometry(0.36, 0.06, 10, 32)), accent, 0, -0.9, 0);
      collar.rotation.x = Math.PI / 2;
      body.add(collar);
      for (const side of [1, -1]) {
        const tab = mesh(sphere(0.1, 16, 10), accent, side * 0.14, -1.0, chestZ(-1.0) + 0.02);
        tab.scale.set(2.1, 1.1, 0.4);
        tab.rotation.z = side * 0.6;
        body.add(tab);
      }
      for (const y of [-1.3, -1.65, -2.0]) body.add(mesh(sphere(0.045, 10, 8), accent, 0, y, chestZ(y) + 0.02));
      break;
    }
    case "suit": {
      // The shirt under the jacket shows at the collar; the tie takes the accent.
      const collar = mesh(geo("collar", () => new TorusGeometry(0.36, 0.06, 10, 32)), mat("#f4f2fa"), 0, -0.9, 0);
      collar.rotation.x = Math.PI / 2;
      body.add(collar);
      const tieY = -1.42;
      const tie = mesh(geo("tie", () => new CylinderGeometry(0.0, 0.15, 0.78, 4)), accent, 0, tieY, chestZ(tieY) + 0.05);
      tie.rotation.x = Math.PI - 0.15;
      tie.scale.z = 0.35;
      body.add(tie, mesh(sphere(0.09, 14, 10), accent, 0, -1.0, chestZ(-1.0) + 0.04));
      for (const side of [1, -1]) {
        const y = -1.32;
        const lapel = mesh(geo("lapel", () => new BoxGeometry(0.17, 0.72, 0.05)), clothShade, side * 0.25, y, chestZ(y) + 0.03);
        lapel.rotation.set(-0.2, 0, side * 0.38);
        body.add(lapel);
      }
      break;
    }
    case "polo": {
      const collar = mesh(geo("collar", () => new TorusGeometry(0.36, 0.06, 10, 32)), clothShade, 0, -0.9, 0);
      collar.rotation.x = Math.PI / 2;
      body.add(collar);
      for (const side of [1, -1]) {
        const flap = mesh(sphere(0.1, 16, 10), cloth, side * 0.15, -0.99, chestZ(-0.99) + 0.02);
        flap.scale.set(2.2, 1.2, 0.4);
        flap.rotation.z = side * 0.55;
        body.add(flap);
      }
      for (const y of [-1.18, -1.36]) body.add(mesh(sphere(0.04, 10, 8), accent, 0, y, chestZ(y) + 0.02));
      break;
    }
    case "jacket": {
      // An open jacket over a tee: the tee (the accent) shows down the front.
      const tee = mesh(sphere(0.5, 24, 16), accent, 0, -1.55, chestZ(-1.55) - 0.03);
      tee.scale.set(0.62, 1.45, 0.12);
      body.add(tee);
      const collar = mesh(geo("collar", () => new TorusGeometry(0.36, 0.06, 10, 32)), accent, 0, -0.9, 0);
      collar.rotation.x = Math.PI / 2;
      body.add(collar);
      for (const side of [1, -1]) {
        const y = -1.32;
        const lapel = mesh(geo("lapel", () => new BoxGeometry(0.17, 0.72, 0.05)), clothShade, side * 0.36, y, chestZ(y) + 0.03);
        lapel.rotation.set(-0.2, 0, side * 0.3);
        body.add(lapel);
      }
      break;
    }
  }

  // Round the neck.
  switch (look.neckwear) {
    case "scarf": {
      const knit = mat(look.accentColor, { fabric: true });
      const wrap = mesh(geo("scarf", () => new TorusGeometry(0.42, 0.17, 14, 36)), knit, 0, -0.88, 0.02);
      wrap.rotation.x = Math.PI / 2 - 0.12;
      const end = mesh(geo("scarf-end", () => new CapsuleGeometry(0.15, 0.6, 6, 14)), knit, 0.28, -1.32, chestZ(-1.32) + 0.1);
      end.rotation.z = 0.12;
      end.scale.z = 0.55;
      body.add(wrap, end);
      break;
    }
    case "necklace": {
      const gold = mat("#e8c15a", { gloss: true });
      const chain = mesh(geo("chain", () => new TorusGeometry(0.42, 0.022, 8, 40)), gold, 0, -1.0, 0.12);
      chain.rotation.x = Math.PI / 2 - 0.55;
      body.add(chain, mesh(sphere(0.07, 14, 10), gold, 0, -1.3, chestZ(-1.3) + 0.04));
      break;
    }
    case "badge": {
      // A lanyard and a card — the agent at work.
      for (const side of [1, -1]) {
        const strap = mesh(geo("strap", () => new CylinderGeometry(0.03, 0.03, 0.75, 6)), accent, side * 0.17, -1.25, chestZ(-1.25) + 0.03);
        strap.rotation.set(-0.3, 0, side * 0.32);
        body.add(strap);
      }
      const card = mesh(geo("card", () => new BoxGeometry(0.4, 0.52, 0.03)), mat("#f4f2fa"), 0, -1.78, chestZ(-1.78) + 0.05);
      card.rotation.x = -0.12;
      card.add(mesh(geo("card-band", () => new BoxGeometry(0.4, 0.12, 0.035)), accent, 0, 0.17, 0));
      card.add(mesh(sphere(0.07, 12, 10), mat(shade(look.skin, 0.9)), 0, 0.0, 0.025));
      body.add(card);
      break;
    }
  }

  // The laptop it types on when it works — scaled in and out with the state.
  // Its screen faces the person, hinged on the far edge: the camera sees the
  // back of the lid, with a dot of the accent on it.
  const laptop = new Group();
  laptop.position.set(0, -2.3, 1.15);
  const metal = mat("#c9ced8");
  laptop.add(mesh(geo("laptop-base", () => new BoxGeometry(1.5, 0.08, 0.95)), metal));
  const screen = mesh(geo("laptop-screen", () => new BoxGeometry(1.5, 0.95, 0.06)), metal, 0, 0.48, 0.45);
  screen.rotation.x = 0.2;
  screen.add(mesh(sphere(0.09, 14, 10), accent, 0, 0.02, 0.04));
  laptop.add(screen);
  laptop.scale.setScalar(0.0001);
  body.add(laptop);

  // — Head — pivots at the neck, so a nod or a turn moves it like a head.
  const head = new Group();
  head.position.y = HEAD_PIVOT_Y;
  root.add(head);
  const face = new Group();
  face.position.y = HEAD_RISE;
  head.add(face);
  // Hair, beard and hats are shaped on the skull's own proportions.
  const shell = new Group();
  shell.scale.copy(SKULL);
  face.add(shell);

  const skull = mesh(sphere(1, 48, 32), skin);
  skull.scale.copy(SKULL);
  face.add(skull);
  if (look.face === "square") {
    const jaw = mesh(sphere(0.85, 32, 20), skin, 0, -0.3, 0.04);
    jaw.scale.set(1.12, 0.78, 1.02);
    face.add(jaw);
  }
  for (const side of [1, -1]) {
    const ear = mesh(sphere(0.22, 16, 12), skin, side * 0.97, -0.02, 0);
    ear.scale.set(0.55, 1, 0.8);
    face.add(ear);
  }
  const nose = mesh(sphere(0.11, 16, 12), skinShade, 0, -0.12, 0.93);
  nose.scale.set(1, 0.85, 0.9);
  face.add(nose);

  const eyes: Group[] = [];
  const brows: Object3D[] = [];
  for (const side of [1, -1]) {
    const eye = new Group();
    eye.position.set(side * 0.36, 0.06, 0.86);
    eye.rotation.y = side * 0.32;
    const big = look.eyeStyle === "big";
    const ball = mesh(sphere(0.13, 24, 16), iris);
    ball.scale.set(big ? 1.25 : 1, big ? 1.45 : 1.22, 0.55);
    // Two catchlights, a large and a small one: what makes a dot an eye.
    eye.add(
      ball,
      mesh(sphere(big ? 0.05 : 0.038, 10, 8), spark, big ? 0.06 : 0.045, big ? 0.09 : 0.065, 0.07),
      mesh(sphere(big ? 0.024 : 0.018, 8, 6), spark, -0.045, -0.06, 0.07),
    );
    if (look.eyeStyle === "lashes") {
      for (let k = 0; k < 3; k++) {
        const lash = mesh(geo("lash", () => new CapsuleGeometry(0.012, 0.07, 3, 6)), ink, side * (0.07 + k * 0.035), 0.16 - k * 0.03, 0.04);
        lash.rotation.z = -side * (0.5 + k * 0.35);
        eye.add(lash);
      }
    }
    if (look.eyeStyle === "sleepy") {
      // A heavy upper lid, in skin.
      const lid = mesh(sphere(0.14, 20, 12, ), skinShade, 0, 0.07, 0.01);
      lid.scale.set(1.08, 0.75, 0.62);
      eye.add(lid);
    }
    face.add(eye);
    eyes.push(eye);

    const browR = look.brows === "fine" ? 0.026 : look.brows === "thick" ? 0.07 : 0.045;
    const b = mesh(geo(`brow:${browR}`, () => new CapsuleGeometry(browR, 0.2, 4, 10)), brow, side * 0.37, 0.37, 0.84);
    b.rotation.set(-0.3, side * 0.3, Math.PI / 2 + side * 0.08);
    b.visible = look.brows !== "none";
    face.add(b);
    brows.push(b);

    if (look.freckles) {
      const dot = mat(shade(look.skin, 0.68));
      for (const [dx, dy] of [[0.5, -0.12], [0.6, -0.08], [0.55, -0.2], [0.68, -0.17], [0.45, -0.2]]) {
        const x = side * dx, y = dy;
        const z = Math.sqrt(Math.max(0, 1 - x * x - y * y)) * SKULL.z + 0.005;
        face.add(mesh(sphere(0.022, 8, 6), dot, x * SKULL.x, y, z));
      }
    }

    if (look.blush) {
      const cheek = mesh(geo("cheek", () => new CircleGeometry(0.15, 24)), mat("#ff7f86", { opacity: 0.32 }), side * 0.6, -0.2, 0.76);
      cheek.rotation.y = side * 0.68;
      face.add(cheek);
    }
    if (look.earrings) face.add(mesh(sphere(0.06, 12, 10), mat("#e8c15a", { gloss: true }), side * 0.98, -0.3, 0.05));
  }

  const smile = mesh(geo("smile", () => new TorusGeometry(0.16, 0.034, 10, 28, Math.PI)), ink, 0, -0.33, 0.9);
  smile.rotation.set(-0.25, 0, Math.PI);
  const grin = mesh(geo("grin", () => new CircleGeometry(0.2, 28, Math.PI, Math.PI)), ink, 0, -0.32, 0.915);
  grin.rotation.x = -0.3;
  const neutral = mesh(geo("neutral", () => new CapsuleGeometry(0.03, 0.18, 4, 10)), ink, 0, -0.36, 0.9);
  neutral.rotation.z = Math.PI / 2;
  const o = mesh(sphere(0.07, 14, 10), ink, 0, -0.36, 0.89);
  o.scale.set(1, 1.2, 0.4);
  const mouths = { smile, grin, neutral, o };
  face.add(smile, grin, neutral, o);

  // — Hair —
  const hairCap = (r: number, theta: number, tilt: number) => {
    const m = mesh(cap(r, theta), hair);
    m.rotation.x = tilt;
    shell.add(m);
    return m;
  };
  const curls = (count: number, radius: number, size: number, keep: (p: Vector3) => boolean) => {
    const points = lattice(count).filter(keep);
    const inst = new InstancedMesh(sphere(1, 16, 12), hair, points.length);
    const dummy = new Object3D();
    points.forEach((p, i) => {
      dummy.position.copy(p).multiplyScalar(radius);
      dummy.scale.setScalar(size);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    disposables.push(inst);
    shell.add(inst);
  };
  /** Shapes standing out of the scalp along its normal: spikes, a crest. */
  const tufts = (g: BufferGeometry, points: Vector3[], radius: number, scale: Vector3) => {
    const inst = new InstancedMesh(g, hair, points.length);
    const dummy = new Object3D();
    const up = new Vector3(0, 1, 0);
    points.forEach((p, i) => {
      const n = p.clone().normalize();
      dummy.position.copy(n).multiplyScalar(radius);
      dummy.quaternion.setFromUnitVectors(up, n);
      dummy.scale.copy(scale);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    disposables.push(inst);
    shell.add(inst);
  };
  switch (look.hair) {
    case "sidepart": {
      hairCap(1.07, 1.45, -0.55);
      // A deep swoop from a parting on one side, over the forehead.
      const swoop = mesh(sphere(0.5, 28, 16), hair, -0.25, 0.78, 0.5);
      swoop.scale.set(1.25, 0.42, 0.75);
      swoop.rotation.set(0.35, 0, 0.3);
      shell.add(swoop);
      break;
    }
    case "spiky":
      hairCap(1.04, 1.4, -0.5);
      tufts(
        geo("spike", () => new ConeGeometry(0.17, 0.5, 10)),
        lattice(70).filter((p) => p.y > 0.42 && !(p.z > 0.7 && p.y < 0.75)),
        1.12,
        new Vector3(1, 1, 1),
      );
      break;
    case "mohawk": {
      hairCap(1.015, 1.45, -0.45);
      // A crest along the middle of the scalp, from the forehead to the nape.
      const crest: Vector3[] = [];
      for (let a = -0.55; a <= 1.5; a += 0.29) crest.push(new Vector3(0, Math.cos(a), -Math.sin(a)));
      tufts(sphere(1, 16, 12), crest, 1.12, new Vector3(0.16, 0.36, 0.22));
      break;
    }
    case "pigtails": {
      hairCap(1.06, 1.45, -0.45);
      for (const side of [1, -1]) {
        shell.add(mesh(sphere(0.13, 12, 10), accent, side * 0.98, 0.25, -0.3));
        const tail = mesh(geo("pigtail", () => new CapsuleGeometry(0.19, 0.62, 6, 14)), hair, side * 1.13, -0.3, -0.3);
        tail.rotation.z = side * 0.22;
        shell.add(tail);
      }
      break;
    }
    case "buzz": hairCap(1.025, 1.5, -0.5); break;
    case "short": {
      hairCap(1.07, 1.45, -0.55);
      const fringe = mesh(sphere(0.5, 24, 14), hair, 0.22, 0.72, 0.6);
      fringe.scale.set(0.8, 0.28, 0.42);
      fringe.rotation.z = -0.35;
      shell.add(fringe);
      break;
    }
    case "quiff": {
      hairCap(1.06, 1.45, -0.55);
      const tuft = mesh(sphere(0.5, 24, 14), hair, 0, 1.0, 0.45);
      tuft.scale.set(1.2, 0.7, 1.05);
      tuft.rotation.x = 0.5;
      shell.add(tuft);
      break;
    }
    case "curly":
      hairCap(1.03, 1.4, -0.5);
      curls(90, 1.06, 0.2, (p) => (p.y > 0.3 || (p.z < -0.1 && p.y > -0.45)) && !(p.z > 0.45 && p.y < 0.6));
      break;
    case "afro":
      hairCap(1.05, 1.45, -0.45);
      curls(110, 1.2, 0.36, (p) => (p.y > 0.25 || (p.z < -0.15 && p.y > -0.5)) && !(p.z > 0.35 && p.y < 0.72));
      break;
    case "bob":
      hairCap(1.08, 1.5, -0.35);
      shell.add(mesh(curtain(1.1, 0.9, 1.3, 1.0), hair));
      break;
    case "long": {
      hairCap(1.08, 1.5, -0.35);
      shell.add(mesh(curtain(1.1, 0.9, 1.6, 1.0), hair));
      const fall = mesh(geo("hair-fall", () => new CapsuleGeometry(0.75, 1.1, 8, 20)), hair, 0, -1.05, -0.62);
      fall.scale.set(1.25, 1, 0.45);
      face.add(fall);
      break;
    }
    case "bun":
      hairCap(1.06, 1.45, -0.45);
      shell.add(mesh(sphere(0.42, 24, 16), hair, 0, 1.02, -0.55));
      break;
    case "ponytail": {
      hairCap(1.06, 1.45, -0.5);
      shell.add(mesh(sphere(0.16, 14, 10), accent, 0, 0.55, -1.0));
      const tail = mesh(geo("tail", () => new CapsuleGeometry(0.2, 0.8, 6, 14)), hair, 0, 0.05, -1.12);
      tail.rotation.x = 0.35;
      shell.add(tail);
      break;
    }
    case "bald":
      break;
  }

  // — Beard —
  // An arch over the lip, thick in the middle and thin at the tips — an arc
  // of a torus, flattened against the face.
  const mustache = () => {
    const m = mesh(geo("mustache", () => new TorusGeometry(0.17, 0.05, 10, 24, Math.PI)), hair, 0, -0.3, 0.92);
    m.scale.set(1.15, 0.55, 0.6);
    m.rotation.x = -0.2;
    face.add(m);
  };
  switch (look.beard) {
    case "stubble":
      shell.add(mesh(jaw(1.012, 2.0, 0.85, 3.6), mat(look.hairColor, { opacity: 0.35 })));
      break;
    case "mustache":
      mustache();
      break;
    case "goatee": {
      mustache();
      const chin = mesh(sphere(0.2, 18, 12), hair, 0, -0.66, 0.72);
      chin.scale.set(1, 0.8, 0.6);
      face.add(chin);
      break;
    }
    case "full":
      mustache();
      shell.add(mesh(jaw(1.05, 2.0, 1.0, 3.5), hair));
      for (const side of [1, -1]) face.add(mesh(geo("sideburn", () => new CapsuleGeometry(0.09, 0.4, 4, 10)), hair, side * 0.93, -0.25, 0.15));
      break;
    case "none":
      break;
  }

  // — Accessories —
  if (look.glasses !== "none") {
    const frame = look.glasses === "shades" ? mat("#16161d", { gloss: true }) : acc;
    for (const side of [1, -1]) {
      const rim = look.glasses === "square"
        ? mesh(geo("rim-square", () => new TorusGeometry(0.21, 0.026, 8, 4)), frame, side * 0.36, 0.06, 0.98)
        : mesh(geo("rim-round", () => new TorusGeometry(0.19, 0.026, 10, 32)), frame, side * 0.36, 0.06, 0.98);
      if (look.glasses === "square") { rim.rotation.z = Math.PI / 4; rim.scale.set(1.1, 0.85, 1); }
      rim.rotation.y = side * 0.25;
      face.add(rim);
      if (look.glasses === "shades") {
        const lens = mesh(geo("lens", () => new CircleGeometry(0.19, 28)), mat("#0d0d12", { gloss: true, opacity: 0.88 }), side * 0.36, 0.06, 0.99);
        lens.rotation.y = side * 0.25;
        face.add(lens);
      }
      // From the rim's outer edge back past the side of the head — a straight
      // line from the lens to the ear would run through the skull.
      const from = new Vector3(side * 0.56, 0.08, 0.96);
      const to = new Vector3(side * 1.0, 0.08, 0.3);
      const temple = mesh(geo("temple", () => new CylinderGeometry(0.018, 0.018, 1, 6)), frame);
      temple.position.copy(from).add(to).multiplyScalar(0.5);
      temple.scale.y = from.distanceTo(to);
      temple.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), to.clone().sub(from).normalize());
      face.add(temple);
    }
    const bridge = mesh(geo("bridge", () => new CylinderGeometry(0.02, 0.02, 0.22, 6)), frame, 0, 0.1, 1.0);
    bridge.rotation.z = Math.PI / 2;
    face.add(bridge);
  }

  if (look.headwear === "beret") {
    const beret = mesh(sphere(1, 32, 20), acc, 0.1, 0.92, -0.05);
    beret.scale.set(1.12, 0.36, 1.06);
    beret.rotation.z = -0.22;
    shell.add(beret, mesh(geo("stalk", () => new CylinderGeometry(0.035, 0.05, 0.16, 8)), acc, 0.2, 1.32, -0.05));
  } else if (look.headwear === "beanie") {
    const hat = new Group();
    hat.rotation.x = -0.3;
    hat.add(mesh(cap(1.12, 1.5), acc));
    const cuff = mesh(geo("cuff", () => new TorusGeometry(1.1, 0.14, 12, 40)), acc, 0, 0.1, 0);
    cuff.rotation.x = Math.PI / 2;
    hat.add(cuff, mesh(sphere(0.26, 18, 12), acc, 0, 1.2, 0));
    shell.add(hat);
  } else if (look.headwear === "cap") {
    const hat = new Group();
    hat.rotation.x = -0.35;
    hat.add(mesh(cap(1.1, 1.35), acc), mesh(sphere(0.07, 10, 8), acc, 0, 1.1, 0));
    shell.add(hat);
    const visor = mesh(geo("visor", () => new CylinderGeometry(0.78, 0.78, 0.05, 32, 1, false, -Math.PI / 2, Math.PI)), acc, 0, 0.58, 0.55);
    visor.rotation.x = 0.12;
    visor.scale.z = 0.9;
    face.add(visor);
  }

  if (look.headphones) {
    const band = mesh(geo("band", () => new TorusGeometry(1.14, 0.07, 10, 40, Math.PI)), acc, 0, 0, 0);
    face.add(band);
    for (const side of [1, -1]) {
      const cup = mesh(geo("cup", () => new CylinderGeometry(0.32, 0.32, 0.22, 24)), acc, side * 1.08, -0.02, 0);
      cup.rotation.z = Math.PI / 2;
      face.add(cup);
    }
  }

  return { root, body, head, eyes, brows, mouths, arms, laptop, materials, disposables };
}

/* ------------------------------------------------------------------ *
 * One avatar.
 * ------------------------------------------------------------------ */

class Human {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(22, 1, 0.1, 60);
  readonly ctx: CanvasRenderingContext2D;
  rig: Rig;
  opts: HumanOptions;
  pw = 0;
  ph = 0;
  visible = true;
  dirty = true;
  private lastDraw = 0;
  private lastTick = 0;
  private readonly motion: Motion;
  private following = false;

  constructor(readonly canvas: HTMLCanvasElement, opts: HumanOptions) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    this.opts = opts;
    this.motion = new Motion(opts.offset);
    // A warm key from the upper left, a cool rim behind, a soft fill: the
    // light of a toy photographed by a window.
    this.scene.add(new HemisphereLight(0xfff8f0, 0x5d6678, 1.1));
    const key = new DirectionalLight(0xfff1e2, 2.4);
    key.position.set(-3.5, 4.5, 6);
    const rim = new DirectionalLight(0xd6e4ff, 1.8);
    rim.position.set(4, 3, -5);
    const fill = new DirectionalLight(0xffffff, 0.45);
    fill.position.set(4, -1, 4);
    this.scene.add(key, rim, fill);
    this.rig = buildFigure(opts.look);
    this.scene.add(this.rig.root);
    this.frame();
    this.resize();
  }

  /** Bust, or head and shoulders for a small avatar. */
  private frame() {
    const [centre, height] = this.opts.closeUp ? [0.35, 3.1] : [-0.3, 4.6];
    const distance = height / (2 * Math.tan((this.camera.fov / 2) * (Math.PI / 180)));
    this.camera.position.set(0, centre, distance);
    this.camera.lookAt(0, centre, 0);
  }

  resize() {
    this.pw = this.canvas.width;
    this.ph = this.canvas.height;
    this.dirty = true;
  }

  update(next: Partial<HumanOptions>) {
    const prev = this.opts;
    this.opts = { ...prev, ...next };
    if (next.look && next.look !== prev.look) {
      this.scene.remove(this.rig.root);
      disposeRig(this.rig);
      this.rig = buildFigure(this.opts.look);
      this.scene.add(this.rig.root);
    }
    if (next.closeUp !== undefined && next.closeUp !== prev.closeUp) this.frame();
    this.dirty = true;
  }

  poke() {
    if (this.motion.poke()) this.dirty = true;
  }

  isDue(now: number, still: boolean): boolean {
    if (!this.visible || this.pw === 0 || this.ph === 0) return false;
    if (this.opts.paused || still) return this.dirty;
    const busy = this.following || this.motion.busy;
    return this.dirty || now - this.lastDraw >= (busy ? 15 : 32);
  }

  draw(r: WebGLRenderer, now: number, still: boolean) {
    const frozen = this.opts.paused || still;
    const dt = frozen || !this.lastTick ? 0 : Math.min(0.1, (now - this.lastTick) / 1000) * this.opts.look.speed;
    this.lastTick = now;
    this.animate(dt, frozen);

    r.setViewport(0, 0, this.pw, this.ph);
    r.setScissor(0, 0, this.pw, this.ph);
    r.clear();
    r.render(this.scene, this.camera);
    this.ctx.clearRect(0, 0, this.pw, this.ph);
    // WebGL counts rows from the bottom: our corner is the bottom-left one.
    this.ctx.drawImage(r.domElement, 0, bufH - this.ph, this.pw, this.ph, 0, 0, this.pw, this.ph);
    this.lastDraw = now;
    this.dirty = false;
  }

  private animate(dt: number, frozen: boolean) {
    const { rig, opts } = this;
    const follow = !frozen && opts.interactive ? followTarget(this.canvas.getBoundingClientRect(), pointer.x, pointer.y) : null;
    this.following = !!follow;
    const pose = this.motion.step(dt, frozen, opts.state, opts.look.mouth, follow);

    // The chest swells, the head rides on it.
    rig.body.scale.set(1 - pose.breath * 0.006, 1 + pose.breath * 0.012, 1);
    rig.head.position.y = HEAD_PIVOT_Y + pose.breath * 0.025;
    rig.head.rotation.set(pose.pitch, pose.yaw, pose.roll);

    for (const eye of rig.eyes) eye.scale.y = pose.lid;
    for (const [i, brow] of rig.brows.entries()) {
      const side = i === 0 ? 1 : -1;
      brow.position.y = 0.37 + pose.brow;
      brow.rotation.z = Math.PI / 2 + side * (opts.state === "working" ? -0.05 : 0.08);
    }
    for (const [k, m] of Object.entries(rig.mouths)) m.visible = k === pose.mouth;

    // Arms: one waves when poked; both type while working.
    rig.laptop.scale.setScalar(Math.max(0.0001, pose.work));
    rig.arms.forEach((arm, i) => {
      const side = i === 0 ? 1 : -1;
      // At rest the hands sit together in front, low on the body; working,
      // they reach a little further, onto the keys.
      let rx = -0.8 + (-0.25 + pose.typing[i]) * pose.work;
      let rz = side * (-0.22 + 0.04 * pose.work);
      if (i === 1 && pose.armUp > 0) {
        rz = rz * (1 - pose.armUp) + side * (2.55 + pose.wave) * pose.armUp;
        rx *= 1 - pose.armUp;
      }
      arm.rotation.set(rx, 0, rz);
    });

    rig.root.position.y = pose.hop;
  }

  dispose() {
    this.scene.remove(this.rig.root);
    disposeRig(this.rig);
  }
}

function disposeRig(rig: Rig) {
  for (const m of rig.materials) m.dispose();
  for (const d of rig.disposables) d.dispose();
}

/* ------------------------------------------------------------------ *
 * Mounting.
 * ------------------------------------------------------------------ */

/** Starts an avatar on a 2D canvas; null when WebGL is not available. */
export function mountHuman(canvas: HTMLCanvasElement, opts: HumanOptions): HumanHandle | null {
  if (!sharedRenderer()) return null;
  let human: Human;
  try {
    human = new Human(canvas, opts);
  } catch {
    return null;
  }
  if (!instances.size) window.addEventListener("pointermove", onPointer, { passive: true });
  instances.add(human);
  byCanvas.set(canvas, human);
  visibility?.observe(canvas);
  start();
  return {
    update: (next) => human.update(next),
    resize: () => human.resize(),
    poke: () => human.poke(),
    dispose: () => {
      instances.delete(human);
      byCanvas.delete(canvas);
      visibility?.unobserve(canvas);
      human.dispose();
      if (!instances.size) window.removeEventListener("pointermove", onPointer);
    },
  };
}
