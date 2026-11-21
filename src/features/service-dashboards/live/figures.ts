import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import {
  autoInk, botAvatarPalette, botAvatarParts, botAvatarShapes,
  type BotAvatarProps, type BotAvatarType,
} from "bot-avatars";
import { autoBody, botAvatarLookProps, parseBotLook } from "@/lib/bot-avatar-look";
import { parseHumanLook, resolveHumanLook, type ResolvedHumanLook } from "@/lib/human-avatar-look";
import { buildFigure, disposeFigure } from "@/components/human-avatar/engine";

// Les PERSONNAGES du Live Space : chaque agent tel que son avatar le montre.
//
// Deux familles, comme dans le studio d'avatar :
//
//   · un HUMAIN : le buste 3D du studio lui-même (crâne, visage, cheveux,
//     barbe, tenue, lunettes, coiffe…), auquel on ajoute des jambes ;
//   · un BOT : la silhouette exacte de sa forme — le tracé SVG que dessine la
//     bibliothèque, extrudé et bombé — à sa couleur, avec son visage et ses
//     accessoires, et cette fois des bras et des jambes.
//
// Les deux répondent à la même interface : la scène dit ce que fait l'agent
// (marche, assis, au travail, fait signe, danse), le personnage s'anime.

export interface FigurePose {
  t: number;
  /** Phase de la marche, qui avance avec la distance parcourue. */
  stride: number;
  walking: boolean;
  seated: boolean;
  working: boolean;
  waving: boolean;
  dancing: boolean;
  /** Branché au silo : les deux mains tiennent le connecteur, bras tendus. */
  reaching: boolean;
  /** En pleine conversation : les mains accompagnent la parole. */
  talking?: boolean;
}

export interface Figure {
  /** Pieds à y = 0 quand il est debout ; il regarde vers +z. */
  root: THREE.Group;
  /** La hauteur des hanches debout : assis, la scène pose les hanches sur la chaise. */
  hip: number;
  /** Sa couleur dominante — l'écran de son poste s'allume à cette teinte. */
  color: string;
  update(p: FigurePose): void;
  dispose(): void;
}

export type AvatarSpec =
  | { kind: "human"; look: ResolvedHumanLook }
  | { kind: "bot"; look: BotAvatarProps & { type: BotAvatarType }; color: string };

/** L'avatar d'un agent, lu dans son `avatar_url` comme le fait AgentIdentity.
 *  Un portrait téléversé n'a pas de corps : il prend le bot que son nom choisit. */
export function describeAvatar(url: string | null | undefined, seed: string): AvatarSpec {
  const human = parseHumanLook(url);
  if (human) return { kind: "human", look: resolveHumanLook(human, seed) };
  const look = botAvatarLookProps(parseBotLook(url) ?? {}, autoBody(seed || "agent"));
  return { kind: "bot", look, color: look.color ?? botAvatarPalette[look.type] ?? "#8b7bd8" };
}

/** La couleur dominante d'un avatar : la tenue d'un humain, le corps d'un bot. */
export function avatarColor(spec: AvatarSpec): string {
  return spec.kind === "human" ? spec.look.outfitColor : spec.color;
}

export function buildAgentFigure(spec: AvatarSpec): Figure {
  return spec.kind === "human" ? humanFigure(spec.look) : botFigure(spec.look, spec.color);
}

/* ------------------------------------------------------------------ *
 * Un humain.
 * ------------------------------------------------------------------ */

const darken = (hex: string, f: number) => `#${new THREE.Color(hex).multiplyScalar(f).getHexString()}`;

function humanFigure(look: ResolvedHumanLook): Figure {
  const rig = buildFigure(look);
  rig.laptop.visible = false;
  for (const [k, m] of Object.entries(rig.mouths)) m.visible = k === look.mouth;

  // L'échelle de la scène : le buste mesure environ 3,9 unités, les jambes en
  // ajoutent 1,5. La silhouette garde la grosse tête du studio — c'est elle
  // qu'on reconnaît.
  const S = 0.235;
  const root = new THREE.Group();
  const fig = new THREE.Group();
  fig.scale.setScalar(S);
  root.add(fig);
  fig.add(rig.root);

  // Un pantalon sobre assorti à la tenue, des chaussures foncées.
  const formal = look.outfit === "suit" || look.outfit === "jacket";
  const trouser = new THREE.MeshStandardMaterial({ color: formal ? darken(look.outfitColor, 0.7) : "#3c4660", roughness: 0.85 });
  const shoe = new THREE.MeshStandardMaterial({ color: "#2a2a31", roughness: 0.55 });
  const legGeo = new THREE.CapsuleGeometry(0.28, 0.85, 6, 14);
  const footGeo = new THREE.SphereGeometry(0.3, 16, 12);
  const HIP_Y = -2.3, LEG = 1.4;
  const legs = [-1, 1].map((side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.44, HIP_Y, 0);
    const leg = new THREE.Mesh(legGeo, trouser);
    leg.position.y = -LEG / 2;
    const foot = new THREE.Mesh(footGeo, shoe);
    foot.scale.set(1, 0.6, 1.45);
    foot.position.set(0, -LEG, 0.12);
    pivot.add(leg, foot);
    rig.root.add(pivot);
    return pivot;
  });
  const FOOT_BOTTOM = HIP_Y - LEG - 0.18;
  fig.position.y = -FOOT_BOTTOM * S;
  shadows(root);

  return {
    root,
    hip: (HIP_Y - FOOT_BOTTOM) * S,
    color: look.outfitColor,
    update(p) {
      const { t } = p;
      rig.body.scale.set(1, 1 + Math.sin(t * 2.2) * 0.01, 1);
      // Il cligne des yeux de temps en temps.
      for (const e of rig.eyes) e.scale.y = (t % 3.9) < 0.12 ? 0.12 : 1;
      const swing = p.walking ? Math.sin(p.stride) : 0;
      legs.forEach((l, i) => { l.rotation.x = p.seated ? -Math.PI / 2 : (i ? -swing : swing) * 0.6; });

      rig.arms.forEach((arm, i) => {
        const side = i === 0 ? 1 : -1;
        let rx = -0.12, rz = side * -0.16;
        if (p.walking) rx = (i ? swing : -swing) * 0.5 - 0.1;
        if (p.seated && p.working) { rx = -1.15 + Math.sin(t * 15 + i * 1.7) * 0.1; rz = side * -0.08; }
        else if (p.seated) { rx = -0.7; rz = side * -0.12; }
        if (p.dancing) { rx = -0.3; rz = side * (1.6 + Math.sin(t * 6 + i * Math.PI) * 0.6); }
        if (p.waving && i === 1) { rx = 0; rz = side * (2.55 + Math.sin(t * 8) * 0.35); }
        if (p.reaching) { rx = -1.3 + Math.sin(t * 2.5 + i) * 0.04; rz = side * -0.02; }
        if (p.talking && !p.walking && !p.reaching) {
          rx = -0.75 + Math.sin(t * 4.2 + i * 2.1) * 0.3;
          rz = side * (-0.25 + Math.sin(t * 3.1 + i) * 0.12);
        }
        arm.rotation.set(rx, 0, rz);
      });

      const look2 = p.walking ? 0 : Math.sin(t * 0.55) * (p.seated && p.working ? 0.12 : 0.4);
      rig.head.rotation.set(p.seated && p.working ? 0.18 : 0, look2, p.dancing ? Math.sin(t * 6) * 0.15 : 0);
      rig.root.position.y = p.dancing ? Math.abs(Math.sin(t * 6)) * 0.35 : p.walking ? Math.abs(Math.sin(p.stride)) * 0.08 : 0;
      rig.root.rotation.z = p.dancing ? Math.sin(t * 3) * 0.12 : 0;
    },
    dispose() {
      disposeFigure(rig);
      trouser.dispose(); shoe.dispose(); legGeo.dispose(); footGeo.dispose();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Un bot.
 * ------------------------------------------------------------------ */

/** La forme d'un bot, extrudée une fois par tracé et partagée ensuite. */
const blobCache = new Map<string, { geos: THREE.BufferGeometry[]; box: THREE.Box3; main: THREE.Box3 }>();

const BLOB = 0.82;       // la largeur de la boîte 100×100 du tracé, en mètres
const DEPTH = 0.3;

function extrudeOutline(d: string): { geos: THREE.BufferGeometry[]; box: THREE.Box3; main: THREE.Box3 } {
  const hit = blobCache.get(d);
  if (hit) return hit;
  const k = BLOB / 100;
  const data = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`);
  const geos: THREE.BufferGeometry[] = [];
  const box = new THREE.Box3();
  let main = new THREE.Box3(), mainArea = -1;
  for (const path of data.paths) {
    // Chaque sous-tracé à part : le chat a une tête et deux oreilles qui se
    // chevauchent, et lus ensemble, les oreilles deviendraient des trous.
    for (const sub of path.subPaths) {
      const pts = sub.getPoints(28).map((v) => new THREE.Vector2((v.x - 50) * k, (50 - v.y) * k));
      if (pts.length < 3) continue;
      const shape = new THREE.Shape(pts);
      const g = new THREE.ExtrudeGeometry(shape, {
        depth: DEPTH, bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.05, bevelSegments: 5, curveSegments: 20,
      });
      g.translate(0, 0, -DEPTH / 2);
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      box.union(bb);
      const area = (bb.max.x - bb.min.x) * (bb.max.y - bb.min.y);
      if (area > mainArea) { mainArea = area; main = bb.clone(); }
      geos.push(g);
    }
  }
  const out = { geos, box, main };
  blobCache.set(d, out);
  return out;
}

function botFigure(look: BotAvatarProps & { type: BotAvatarType }, color: string): Figure {
  const ink = look.ink ?? autoInk(color);
  const plastic = look.shading === "plastic" || look.shading === "crisp";
  const bodyMat = plastic
    ? new THREE.MeshPhysicalMaterial({ color, roughness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.2 })
    : new THREE.MeshPhysicalMaterial({ color, roughness: 0.9, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.5) });
  const limbMat = new THREE.MeshStandardMaterial({ color: darken(color, 0.82), roughness: 0.8 });
  const inkMat = new THREE.MeshStandardMaterial({ color: ink, roughness: 0.4 });
  const white = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const accColor = look.accessoryColor ?? "#e8505b";
  const accMat = new THREE.MeshStandardMaterial({ color: accColor, roughness: 0.6 });
  const mats: THREE.Material[] = [bodyMat, limbMat, inkMat, white, accMat];
  const geos: THREE.BufferGeometry[] = [];
  const own = <G extends THREE.BufferGeometry>(g: G) => { geos.push(g); return g; };

  const root = new THREE.Group();
  const LEG = 0.3;
  const blob = extrudeOutline(look.path ?? botAvatarShapes[look.type]);
  const parts = !look.path ? botAvatarParts[look.type] : undefined;

  // Le corps-tête, posé sur les jambes.
  const body = new THREE.Group();
  body.position.y = LEG - blob.box.min.y - 0.02;
  root.add(body);
  for (const g of blob.geos) body.add(new THREE.Mesh(g, bodyMat));
  if (parts) for (const g of extrudeOutline(parts).geos) body.add(new THREE.Mesh(g, limbMat));

  const m = blob.main;
  const cx = (m.min.x + m.max.x) / 2;
  const cy = (m.min.y + m.max.y) / 2;
  const w = m.max.x - m.min.x;
  const h = m.max.y - m.min.y;
  const front = DEPTH / 2 + 0.09;

  // Le visage : deux yeux d'encre avec leur reflet, une bouche si l'avatar en a une.
  const eyes: THREE.Group[] = [];
  const eyeGeo = own(new THREE.SphereGeometry(1, 16, 12));
  for (const side of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(cx + side * w * 0.16, cy + h * 0.06, front);
    const ball = new THREE.Mesh(eyeGeo, inkMat);
    ball.scale.set(0.045, 0.065, 0.03);
    const glint = new THREE.Mesh(eyeGeo, white);
    glint.scale.setScalar(0.014);
    glint.position.set(0.014, 0.022, 0.025);
    eye.add(ball, glint);
    body.add(eye);
    eyes.push(eye);
  }
  if (look.face === "mouth") {
    const mouth = new THREE.Mesh(own(new THREE.TorusGeometry(0.05, 0.012, 8, 16, Math.PI)), inkMat);
    mouth.rotation.z = Math.PI;
    mouth.position.set(cx, cy - h * 0.1, front + 0.005);
    body.add(mouth);
  }

  // Les accessoires du studio.
  const top = m.max.y;
  if (look.hat && look.hat !== "none") {
    const hat = new THREE.Group();
    hat.position.set(cx, top - 0.02, 0);
    if (look.hat === "crown") {
      const gold = new THREE.MeshStandardMaterial({ color: look.accessoryColor ?? "#f5c542", roughness: 0.3, metalness: 0.6 });
      mats.push(gold);
      hat.add(new THREE.Mesh(own(new THREE.CylinderGeometry(0.15, 0.15, 0.08, 20, 1, true)), gold));
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const spike = new THREE.Mesh(own(new THREE.ConeGeometry(0.035, 0.09, 6)), gold);
        spike.position.set(Math.cos(a) * 0.15, 0.08, Math.sin(a) * 0.15);
        hat.add(spike);
      }
    } else if (look.hat === "party") {
      const cone = new THREE.Mesh(own(new THREE.ConeGeometry(0.11, 0.3, 18)), accMat);
      cone.position.y = 0.15;
      const pom = new THREE.Mesh(own(new THREE.SphereGeometry(0.04, 10, 8)), white);
      pom.position.y = 0.31;
      hat.add(cone, pom);
      hat.rotation.z = -0.25;
    } else if (look.hat === "beanie") {
      const cap = new THREE.Mesh(own(new THREE.SphereGeometry(0.2, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2)), accMat);
      cap.scale.set(1, 0.8, 0.85);
      const rim = new THREE.Mesh(own(new THREE.TorusGeometry(0.19, 0.035, 8, 22)), accMat);
      rim.rotation.x = Math.PI / 2;
      const pom = new THREE.Mesh(own(new THREE.SphereGeometry(0.05, 10, 8)), white);
      pom.position.y = 0.17;
      hat.add(cap, rim, pom);
    } else {
      const beret = new THREE.Mesh(own(new THREE.SphereGeometry(0.19, 18, 10)), accMat);
      beret.scale.set(1, 0.32, 0.95);
      beret.position.y = 0.04;
      beret.rotation.z = 0.25;
      hat.add(beret);
    }
    body.add(hat);
  }
  if (look.glasses && look.glasses !== "none") {
    const frame = look.glasses === "shades"
      ? new THREE.MeshStandardMaterial({ color: "#16161d", roughness: 0.2, metalness: 0.3 })
      : new THREE.MeshStandardMaterial({ color: look.accessoryColor ?? "#2a2a31", roughness: 0.4 });
    mats.push(frame);
    for (const e of eyes) {
      const lens = look.glasses === "shades"
        ? new THREE.Mesh(own(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 18)), frame)
        : new THREE.Mesh(own(new THREE.TorusGeometry(0.07, 0.012, 8, look.glasses === "square" ? 4 : 20)), frame);
      if (look.glasses === "shades") lens.rotation.x = Math.PI / 2;
      if (look.glasses === "square") lens.rotation.z = Math.PI / 4;
      lens.position.set(e.position.x, e.position.y, front + 0.03);
      body.add(lens);
    }
    const bridge = new THREE.Mesh(UNIT_BOX, frame);
    bridge.scale.set(Math.abs(eyes[1].position.x - eyes[0].position.x) - 0.14, 0.012, 0.012);
    bridge.position.set(cx, eyes[0].position.y + 0.02, front + 0.03);
    body.add(bridge);
  }
  if (look.headphones) {
    const band = new THREE.Mesh(own(new THREE.TorusGeometry(w * 0.5, 0.02, 8, 24, Math.PI)), inkMat);
    band.position.set(cx, cy + h * 0.05, 0);
    body.add(band);
    for (const side of [-1, 1]) {
      const cup = new THREE.Mesh(own(new THREE.CylinderGeometry(0.075, 0.075, 0.07, 18)), accMat);
      cup.rotation.z = Math.PI / 2;
      cup.position.set(cx + side * w * 0.5, cy + h * 0.05, 0);
      body.add(cup);
    }
  }
  if (look.bowTie) {
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(own(new THREE.ConeGeometry(0.05, 0.09, 4)), accMat);
      wing.rotation.z = side * Math.PI / 2;
      wing.position.set(cx + side * 0.045, m.min.y + h * 0.18, front);
      body.add(wing);
    }
  }

  // Des bras et des jambes : ce qui manquait au bot pour aller et venir.
  const limb = own(new THREE.CapsuleGeometry(0.05, 0.16, 4, 10));
  const footGeo = own(new THREE.SphereGeometry(0.075, 12, 10));
  const legs = [-1, 1].map((side) => {
    const pivot = new THREE.Group();
    pivot.position.set(cx + side * Math.min(0.12, w * 0.22), LEG, 0);
    const leg = new THREE.Mesh(limb, limbMat);
    leg.position.y = -LEG / 2 + 0.02;
    const foot = new THREE.Mesh(footGeo, inkMat);
    foot.scale.set(1, 0.6, 1.35);
    foot.position.set(0, -LEG + 0.05, 0.03);
    pivot.add(leg, foot);
    root.add(pivot);
    return pivot;
  });
  const arms = [-1, 1].map((side) => {
    const pivot = new THREE.Group();
    pivot.position.set(cx + side * (w / 2 + 0.01), cy - h * 0.12, 0);
    const arm = new THREE.Mesh(limb, limbMat);
    arm.position.y = -0.11;
    const hand = new THREE.Mesh(footGeo, bodyMat);
    hand.scale.setScalar(0.75);
    hand.position.y = -0.22;
    pivot.add(arm, hand);
    body.add(pivot);
    return pivot;
  });
  shadows(root);

  return {
    root,
    hip: LEG,
    color,
    update(p) {
      const { t } = p;
      for (const e of eyes) e.scale.y = (t % 3.7) < 0.12 ? 0.12 : 1;
      const swing = p.walking ? Math.sin(p.stride) : 0;
      legs.forEach((l, i) => { l.rotation.x = p.seated ? -Math.PI / 2 : (i ? -swing : swing) * 0.7; });
      arms.forEach((a, i) => {
        const side = i === 0 ? -1 : 1;
        let rx = 0, rz = side * 0.15;
        if (p.walking) rx = (i ? swing : -swing) * 0.6;
        if (p.seated && p.working) { rx = -1.2 + Math.sin(t * 15 + i * 1.7) * 0.15; rz = side * 0.05; }
        if (p.dancing) { rz = side * (2.2 + Math.sin(t * 6 + i * Math.PI) * 0.5); }
        if (p.waving && i === 1) { rx = 0; rz = side * (2.6 + Math.sin(t * 8) * 0.35); }
        if (p.reaching) { rx = -1.35 + Math.sin(t * 2.5 + i) * 0.05; rz = side * 0.02; }
        if (p.talking && !p.walking && !p.reaching) {
          rx = -0.8 + Math.sin(t * 4.2 + i * 2.1) * 0.35;
          rz = side * (0.3 + Math.sin(t * 3.1 + i) * 0.15);
        }
        a.rotation.set(rx, 0, rz);
      });
      // Un corps vivant : il respire, rebondit en marchant, se dandine en dansant.
      const breathe = 1 + Math.sin(t * 2.4) * 0.015;
      body.scale.set(1 / Math.sqrt(breathe), breathe, 1);
      body.rotation.z = p.dancing ? Math.sin(t * 6) * 0.18 : p.walking ? Math.sin(p.stride) * 0.06 : 0;
      body.rotation.x = p.seated && p.working ? 0.12 : 0;
      root.position.y = 0;
      body.position.y = LEG - blob.box.min.y - 0.02 + (p.dancing ? Math.abs(Math.sin(t * 6)) * 0.12 : p.walking ? Math.abs(Math.sin(p.stride)) * 0.03 : 0);
    },
    dispose() {
      for (const mt of mats) mt.dispose();
      for (const g of geos) g.dispose();
    },
  };
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/** Les grandes pièces portent une ombre ; les petits détails (yeux, boutons,
 *  mèches) non — ils doubleraient le coût du rendu des ombres pour rien. */
function shadows(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const s = new THREE.Vector3();
    mesh.getWorldScale(s);
    const r = (mesh.geometry.boundingSphere?.radius ?? 0) * Math.max(s.x, s.y, s.z);
    mesh.castShadow = r > 0.06;
  });
}
