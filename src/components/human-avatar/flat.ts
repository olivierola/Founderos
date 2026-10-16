import type { HumanMaterial, ResolvedHumanLook } from "@/lib/human-avatar-look";
import type { HumanHandle, HumanOptions } from "./engine";
import { Motion, followTarget, type Pose } from "./motion";

// The person drawn in plain Canvas 2D — for browsers that give no WebGL.
//
// Chrome no longer falls back to software WebGL when the GPU is blocked
// (after a GPU reset, on a VM, on a remote desktop, on many locked-down work
// machines), and there the 3D engine cannot start. This draws the same person
// from the same look — the same traits, outfit, accessories and material —
// with gradients for the volume, and moves it with the same pose (motion.ts),
// so the agent is still a person, just without real depth.
//
// Coordinates are the 3D engine's — the head a circle of radius 1 — with y
// pointing down, as a canvas has it.

/* ------------------------------------------------------------------ *
 * Colour and shading.
 * ------------------------------------------------------------------ */

type RGB = [number, number, number];
const TAU = Math.PI * 2;

function rgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (c: RGB, d: RGB, t: number): RGB => [c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t, c[2] + (d[2] - c[2]) * t];
const css = (c: RGB, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const lighten = (c: RGB, t: number) => mix(c, [255, 255, 255], t);
const darken = (c: RGB, t: number) => mix(c, [0, 0, 0], t);

interface Box { x: number; y: number; w: number; h: number }

/** Fills a shape as a lit volume: light from the upper left, the far side in
 *  shade; a hard two-tone for « cartoon », a hot spot for « vinyl ». */
function paint(ctx: CanvasRenderingContext2D, path: Path2D, box: Box, colour: string | RGB, mat: HumanMaterial) {
  const c = typeof colour === "string" ? rgb(colour) : colour;
  if (mat === "toon") {
    ctx.fillStyle = css(darken(c, 0.22));
    ctx.fill(path);
    ctx.save();
    ctx.clip(path);
    ctx.fillStyle = css(c);
    ctx.beginPath();
    ctx.ellipse(box.x + box.w * 0.44, box.y + box.h * 0.4, box.w * 0.56, box.h * 0.56, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
    return;
  }
  const r = Math.max(box.w, box.h);
  const g = ctx.createRadialGradient(box.x + box.w * 0.33, box.y + box.h * 0.28, r * 0.02, box.x + box.w * 0.42, box.y + box.h * 0.4, r * 0.78);
  g.addColorStop(0, css(lighten(c, mat === "vinyl" ? 0.3 : 0.17)));
  g.addColorStop(0.5, css(c));
  g.addColorStop(1, css(darken(c, 0.3)));
  ctx.fillStyle = g;
  ctx.fill(path);
  if (mat === "vinyl") {
    const hx = box.x + box.w * 0.3, hy = box.y + box.h * 0.24;
    const spot = ctx.createRadialGradient(hx, hy, 0, hx, hy, r * 0.2);
    spot.addColorStop(0, "rgba(255,255,255,0.55)");
    spot.addColorStop(1, "rgba(255,255,255,0)");
    ctx.save();
    ctx.clip(path);
    ctx.fillStyle = spot;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.restore();
  }
}

function ellipse(cx: number, cy: number, rx: number, ry: number, rot = 0): [Path2D, Box] {
  const p = new Path2D();
  p.ellipse(cx, cy, rx, ry, rot, 0, TAU);
  return [p, { x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 }];
}

/** A rounded stroke from one point to another, as a shape (sleeves, tails). */
function capsule(x1: number, y1: number, x2: number, y2: number, r: number): [Path2D, Box] {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const p = new Path2D();
  p.arc(x1, y1, r, a + Math.PI / 2, a + Math.PI * 1.5);
  p.arc(x2, y2, r, a - Math.PI / 2, a + Math.PI / 2);
  p.closePath();
  const x = Math.min(x1, x2) - r, y = Math.min(y1, y2) - r;
  return [p, { x, y, w: Math.abs(x2 - x1) + r * 2, h: Math.abs(y2 - y1) + r * 2 }];
}

function roundRect(x: number, y: number, w: number, h: number, r: number): [Path2D, Box] {
  const p = new Path2D();
  p.roundRect(x, y, w, h, r);
  return [p, { x, y, w, h }];
}

// The torso's outline: the 3D engine's turned profile, seen from the front.
const PROFILE: [number, number][] = [
  [0, 2.45], [0.7, 2.42], [1.0, 2.3], [1.15, 2.05], [1.2, 1.7], [1.18, 1.4],
  [1.08, 1.18], [0.85, 1.0], [0.55, 0.9], [0.32, 0.86], [0, 0.84],
];
function torsoPath(): [Path2D, Box] {
  const pts = [...PROFILE.map(([x, y]) => [x, y]), ...PROFILE.slice(0, -1).reverse().map(([x, y]) => [-x, y])];
  const p = new Path2D();
  p.moveTo(pts[0][0], pts[0][1]);
  // A curve through the midpoints, so the outline stays round.
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    p.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  p.closePath();
  return [p, { x: -1.2, y: 0.84, w: 2.4, h: 1.61 }];
}

/* ------------------------------------------------------------------ *
 * The figure.
 * ------------------------------------------------------------------ */

const NECK_Y = 0.6;
const HEAD_RISE = 0.95;
const SKULLS = { round: [1, 1.02], oval: [0.95, 1.08], square: [1.03, 1.0] } as const;
const BUILD_WIDTH = { slim: 0.9, regular: 1, broad: 1.12 } as const;

function drawFigure(ctx: CanvasRenderingContext2D, look: ResolvedHumanLook, pose: Pose) {
  const mat = look.material;
  const skin = rgb(look.skin);
  const skinShade = darken(skin, 0.12);
  const hair = rgb(look.hairColor);
  const cloth = rgb(look.outfitColor);
  const clothShade = darken(cloth, 0.22);
  const ink = "#2a1a1c";
  const fx = pose.yaw * 0.45;
  const fy = pose.pitch * 0.35;
  const neckY = NECK_Y - pose.breath * 0.025;

  /** Runs `draw` in the head's own space: its centre at the origin, turned and tilted with it. */
  const inHead = (draw: () => void) => {
    ctx.save();
    ctx.translate(pose.yaw * 0.08, neckY);
    ctx.rotate(-pose.roll);
    ctx.translate(0, -HEAD_RISE);
    draw();
    ctx.restore();
  };

  // — Hair behind the head —
  inHead(() => {
    switch (look.hair) {
      case "bob":
      case "long": {
        const bottom = look.hair === "long" ? 1.9 : 0.75;
        const half = look.hair === "long" ? 1.2 : 1.13;
        const p = new Path2D();
        p.ellipse(0, 0, 1.13, 1.1, 0, Math.PI, TAU);
        p.lineTo(half, bottom - 0.2);
        p.quadraticCurveTo(half, bottom, half - 0.25, bottom);
        p.lineTo(-half + 0.25, bottom);
        p.quadraticCurveTo(-half, bottom, -half, bottom - 0.2);
        p.closePath();
        paint(ctx, p, { x: -half, y: -1.1, w: half * 2, h: bottom + 1.1 }, hair, mat);
        break;
      }
      case "afro": {
        const p = new Path2D();
        for (let a = -200; a <= 20; a += 22) {
          const r = (a * Math.PI) / 180;
          p.moveTo(Math.cos(r) * 0.95 + 0.42, -0.2 + Math.sin(r) * 0.95);
          p.arc(Math.cos(r) * 0.95, -0.2 + Math.sin(r) * 0.95, 0.42, 0, TAU);
        }
        p.ellipse(0, -0.2, 1.2, 1.1, 0, 0, TAU);
        paint(ctx, p, { x: -1.4, y: -1.6, w: 2.8, h: 2.4 }, hair, mat);
        break;
      }
      case "bun": {
        const [p, b] = ellipse(0, -1.05, 0.42, 0.4);
        paint(ctx, p, b, hair, mat);
        break;
      }
      case "pigtails":
        for (const side of [1, -1]) {
          const [p, b] = capsule(side * 1.0, 0.2, side * 1.18, 0.85, 0.19);
          paint(ctx, p, b, hair, mat);
          const [t, tb] = ellipse(side * 0.98, 0.18, 0.12, 0.12);
          paint(ctx, t, tb, look.accentColor, mat);
        }
        break;
      case "ponytail": {
        const [p, b] = capsule(0.82, 0.05, 1.0, 0.85, 0.19);
        paint(ctx, p, b, hair, mat);
        const [t, tb] = ellipse(0.8, 0.02, 0.13, 0.13);
        paint(ctx, t, tb, look.accentColor, mat);
        break;
      }
    }
  });

  // — Neck, then the body over its base —
  {
    const [p, b] = roundRect(-0.3, neckY - 0.25, 0.6, 0.75, 0.15);
    paint(ctx, p, b, skinShade, mat);
  }
  if (look.outfit === "hoodie") {
    const [p, b] = ellipse(0, 0.93, 0.85, 0.3);
    paint(ctx, p, b, clothShade, mat);
  }
  ctx.save();
  const width = BUILD_WIDTH[look.build];
  ctx.translate(0, 2.45);
  ctx.scale((1 - pose.breath * 0.006) * width, 1 + pose.breath * 0.012);
  ctx.translate(0, -2.45);
  {
    const [p, b] = torsoPath();
    paint(ctx, p, b, cloth, mat);
  }
  ctx.save();
  ctx.scale(1 / width, 1);
  drawOutfit(ctx, look, cloth, clothShade, mat);
  drawNeckwear(ctx, look, mat);
  ctx.restore();
  ctx.restore();

  // — Arms: the one on the viewer's left waves; both type while working —
  [1, -1].forEach((side, i) => {
    const px = side * 1.1 * width, py = 1.3;
    // Hands together in front at rest, as in 3D.
    const rest = [side * 0.72, 2.02];
    const typing = [side * 0.5, 2.05 + pose.typing[i] * 0.3];
    let ex = rest[0] + (typing[0] - rest[0]) * pose.work;
    let ey = rest[1] + (typing[1] - rest[1]) * pose.work;
    if (i === 1 && pose.armUp > 0) {
      const a = 2.55 + pose.wave;
      ex += (px + side * Math.sin(a) * 0.98 - ex) * pose.armUp;
      ey += (py + Math.cos(a) * 0.98 - ey) * pose.armUp;
    }
    const sx = px + (ex - px) * 0.78, sy = py + (ey - py) * 0.78;
    const [sleeve, sb] = capsule(px, py, sx, sy, 0.25);
    paint(ctx, sleeve, sb, cloth, mat);
    const [hand, hb] = ellipse(ex, ey, 0.2, 0.2);
    paint(ctx, hand, hb, skin, mat);
  });

  // — The head —
  inHead(() => {
    for (const side of [1, -1]) {
      const [p, b] = ellipse(side * 0.97 - pose.yaw * 0.3, 0.02, 0.13, 0.22);
      paint(ctx, p, b, skin, mat);
    }
    const [rx, ry] = SKULLS[look.face];
    const [skull, sb] = ellipse(0, 0, rx, ry);
    paint(ctx, skull, sb, skin, mat);
    if (look.face === "square") {
      const [jaw, jb] = ellipse(0, 0.32, 0.95, 0.64);
      paint(ctx, jaw, { ...jb, y: sb.y, h: sb.h }, skin, mat);
    }
    if (look.freckles) {
      ctx.fillStyle = css(darken(skin, 0.32), 0.8);
      for (const side of [1, -1]) {
        for (const [dx, dy] of [[0.5, 0.12], [0.6, 0.08], [0.55, 0.2], [0.68, 0.17], [0.45, 0.2]]) {
          ctx.beginPath();
          ctx.arc(side * dx + fx * 0.8, dy + fy, 0.024, 0, TAU);
          ctx.fill();
        }
      }
    }

    if (look.blush) {
      for (const side of [1, -1]) {
        const x = side * 0.6 + fx * 0.8, y = 0.2 + fy;
        const g = ctx.createRadialGradient(x, y, 0, x, y, 0.18);
        g.addColorStop(0, "rgba(255,127,134,0.42)");
        g.addColorStop(1, "rgba(255,127,134,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x - 0.2, y - 0.2, 0.4, 0.4);
      }
    }

    // Beard under the mouth, before it.
    ctx.save();
    ctx.clip(ellipse(0, 0, 1.04, 1.06)[0]);
    if (look.beard === "stubble" || look.beard === "full") {
      const p = new Path2D();
      p.moveTo(-1.1, 0.1 + fy);
      p.lineTo(-0.6, 0.48 + fy);
      p.quadraticCurveTo(fx, 0.62 + fy, 0.6, 0.48 + fy);
      p.lineTo(1.1, 0.1 + fy);
      p.lineTo(1.1, 1.2);
      p.lineTo(-1.1, 1.2);
      p.closePath();
      if (look.beard === "full") paint(ctx, p, { x: -1.1, y: 0.1, w: 2.2, h: 1.1 }, hair, mat);
      else { ctx.fillStyle = css(hair, 0.32); ctx.fill(p); }
    }
    ctx.restore();
    if (look.beard === "goatee") {
      const [p, b] = ellipse(fx, 0.7 + fy, 0.2, 0.16);
      paint(ctx, p, b, hair, mat);
    }

    // Eyes, brows, nose, mouth — they follow the turn of the head.
    for (const side of [1, -1]) {
      const x = side * 0.36 + fx, y = -0.06 + fy;
      const big = look.eyeStyle === "big";
      const erx = big ? 0.15 : 0.12, ery = big ? 0.19 : 0.155;
      ctx.fillStyle = look.eyes;
      ctx.beginPath();
      ctx.ellipse(x, y, erx, ery * pose.lid, 0, 0, TAU);
      ctx.fill();
      if (pose.lid > 0.5) {
        // Two catchlights, a large and a small one.
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(x + erx * 0.33, y - ery * 0.38, big ? 0.048 : 0.035, 0, TAU);
        ctx.arc(x - erx * 0.35, y + ery * 0.4, big ? 0.022 : 0.017, 0, TAU);
        ctx.fill();
      }
      if (look.eyeStyle === "sleepy" && pose.lid > 0.5) {
        const lid = new Path2D();
        lid.ellipse(x, y, erx + 0.02, ery + 0.02, 0, Math.PI, TAU);
        lid.closePath();
        paint(ctx, lid, { x: x - erx, y: y - ery, w: erx * 2, h: ery }, skinShade, mat);
      }
      if (look.eyeStyle === "lashes" && pose.lid > 0.5) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 0.028;
        ctx.lineCap = "round";
        for (let k = 0; k < 3; k++) {
          const a = -0.35 - k * 0.32;
          const bx = x + side * Math.cos(a) * erx * 0.95, by2 = y + Math.sin(a) * ery * 0.95;
          ctx.beginPath();
          ctx.moveTo(bx, by2);
          ctx.lineTo(bx + side * Math.cos(a) * 0.07, by2 + Math.sin(a) * 0.07);
          ctx.stroke();
        }
      }
      if (look.brows === "none") continue;
      ctx.strokeStyle = css(darken(hair, 0.2));
      ctx.lineWidth = look.brows === "fine" ? 0.05 : look.brows === "thick" ? 0.13 : 0.085;
      ctx.lineCap = "round";
      ctx.beginPath();
      const by = -0.38 - pose.brow + fy;
      ctx.moveTo(side * 0.23 + fx, by + 0.02);
      ctx.quadraticCurveTo(side * 0.37 + fx, by - 0.05, side * 0.5 + fx, by + 0.03);
      ctx.stroke();
    }
    {
      const [p, b] = ellipse(fx * 1.1, 0.12 + fy, 0.1, 0.085);
      paint(ctx, p, b, skinShade, mat);
    }
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.lineCap = "round";
    switch (pose.mouth) {
      case "smile":
        ctx.lineWidth = 0.065;
        ctx.beginPath();
        ctx.arc(fx, 0.3 + fy, 0.16, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.stroke();
        break;
      case "grin":
        ctx.beginPath();
        ctx.arc(fx, 0.33 + fy, 0.2, 0, Math.PI);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#e86a7a";
        ctx.beginPath();
        ctx.ellipse(fx, 0.47 + fy, 0.09, 0.045, 0, 0, TAU);
        ctx.fill();
        break;
      case "neutral":
        ctx.lineWidth = 0.06;
        ctx.beginPath();
        ctx.moveTo(fx - 0.1, 0.38 + fy);
        ctx.lineTo(fx + 0.1, 0.38 + fy);
        ctx.stroke();
        break;
      case "o":
        ctx.beginPath();
        ctx.ellipse(fx, 0.38 + fy, 0.065, 0.08, 0, 0, TAU);
        ctx.fill();
        break;
    }
    if (look.beard === "mustache" || look.beard === "goatee" || look.beard === "full") {
      ctx.strokeStyle = css(hair);
      ctx.lineWidth = 0.09;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.ellipse(fx, 0.33 + fy, 0.19, 0.1, 0, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    }

    drawHairFront(ctx, look, hair, mat, fx, fy);
    if (look.earrings) {
      for (const side of [1, -1]) {
        const [p, b] = ellipse(side * 0.97 - pose.yaw * 0.3, 0.3, 0.06, 0.06);
        paint(ctx, p, b, "#e8c15a", "vinyl");
      }
    }
    drawGlasses(ctx, look, fx, fy);
    drawHeadwear(ctx, look, mat, fx);
  });

  // — The laptop, last: in front of the hands typing on it —
  if (pose.work > 0.01) {
    ctx.save();
    ctx.translate(0, 2.3);
    ctx.scale(pose.work, pose.work);
    const [lid, lb] = roundRect(-0.75, -0.95, 1.5, 0.95, 0.07);
    paint(ctx, lid, lb, "#c9ced8", mat === "toon" ? "toon" : "vinyl");
    const [dot, db] = ellipse(0, -0.47, 0.08, 0.08);
    paint(ctx, dot, db, look.accentColor, mat);
    const [base, bb] = roundRect(-0.85, -0.02, 1.7, 0.1, 0.04);
    paint(ctx, base, bb, "#a9afbb", mat);
    ctx.restore();
  }
}

function drawOutfit(ctx: CanvasRenderingContext2D, look: ResolvedHumanLook, cloth: RGB, clothShade: RGB, mat: HumanMaterial) {
  const collar = (colour: RGB | string) => {
    ctx.strokeStyle = typeof colour === "string" ? colour : css(colour);
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.ellipse(0, 0.9, 0.36, 0.1, 0, 0, Math.PI);
    ctx.stroke();
  };
  switch (look.outfit) {
    case "tshirt":
      collar(clothShade);
      break;
    case "turtleneck": {
      const [p, b] = roundRect(-0.4, 0.52, 0.8, 0.5, 0.18);
      paint(ctx, p, b, cloth, mat);
      break;
    }
    case "hoodie":
      for (const side of [1, -1]) {
        ctx.strokeStyle = look.accentColor;
        ctx.lineWidth = 0.05;
        ctx.beginPath();
        ctx.moveTo(side * 0.17, 1.02);
        ctx.lineTo(side * 0.19, 1.55);
        ctx.stroke();
        ctx.fillStyle = look.accentColor;
        ctx.beginPath();
        ctx.arc(side * 0.19, 1.58, 0.05, 0, TAU);
        ctx.fill();
      }
      break;
    case "shirt":
      collar(look.accentColor);
      for (const side of [1, -1]) {
        const [p, b] = ellipse(side * 0.14, 1.0, 0.2, 0.1, side * 0.6);
        paint(ctx, p, b, look.accentColor, mat);
      }
      ctx.fillStyle = look.accentColor;
      for (const y of [1.3, 1.65, 2.0]) { ctx.beginPath(); ctx.arc(0, y, 0.045, 0, TAU); ctx.fill(); }
      break;
    case "polo":
      collar(clothShade);
      for (const side of [1, -1]) {
        const [p, b] = ellipse(side * 0.15, 0.99, 0.22, 0.11, side * 0.55);
        paint(ctx, p, b, cloth, mat);
      }
      ctx.fillStyle = look.accentColor;
      for (const y of [1.18, 1.36]) { ctx.beginPath(); ctx.arc(0, y, 0.04, 0, TAU); ctx.fill(); }
      break;
    case "jacket": {
      // An open jacket over a tee: the tee (the accent) down the front.
      const tee = new Path2D();
      tee.moveTo(-0.38, 0.9);
      tee.lineTo(0.38, 0.9);
      tee.lineTo(0.3, 2.42);
      tee.lineTo(-0.3, 2.42);
      tee.closePath();
      paint(ctx, tee, { x: -0.38, y: 0.9, w: 0.76, h: 1.5 }, look.accentColor, mat);
      collar(look.accentColor);
      for (const side of [1, -1]) {
        const lapel = new Path2D();
        lapel.moveTo(side * 0.38, 0.9);
        lapel.lineTo(side * 0.56, 1.2);
        lapel.lineTo(side * 0.4, 1.25);
        lapel.lineTo(side * 0.3, 1.9);
        lapel.lineTo(side * 0.28, 1.8);
        lapel.closePath();
        ctx.fillStyle = css(clothShade);
        ctx.fill(lapel);
      }
      break;
    }
    case "suit": {
      // The white shirt in the V of the jacket, the tie down it, the lapels.
      const v = new Path2D();
      v.moveTo(-0.34, 0.92);
      v.lineTo(0.34, 0.92);
      v.lineTo(0, 1.75);
      v.closePath();
      paint(ctx, v, { x: -0.34, y: 0.92, w: 0.68, h: 0.83 }, "#f4f2fa", mat);
      const tie = new Path2D();
      tie.moveTo(-0.08, 1.02);
      tie.lineTo(0.08, 1.02);
      tie.lineTo(0.14, 1.65);
      tie.lineTo(0, 1.8);
      tie.lineTo(-0.14, 1.65);
      tie.closePath();
      paint(ctx, tie, { x: -0.14, y: 1.0, w: 0.28, h: 0.8 }, look.accentColor, mat);
      const [knot, kb] = ellipse(0, 0.99, 0.09, 0.075);
      paint(ctx, knot, kb, look.accentColor, mat);
      for (const side of [1, -1]) {
        const lapel = new Path2D();
        lapel.moveTo(side * 0.34, 0.9);
        lapel.lineTo(side * 0.5, 1.2);
        lapel.lineTo(side * 0.3, 1.25);
        lapel.lineTo(side * 0.04, 1.78);
        lapel.lineTo(side * 0.02, 1.7);
        lapel.closePath();
        ctx.fillStyle = css(clothShade);
        ctx.fill(lapel);
      }
      break;
    }
  }
}

function drawNeckwear(ctx: CanvasRenderingContext2D, look: ResolvedHumanLook, mat: HumanMaterial) {
  switch (look.neckwear) {
    case "scarf": {
      const [wrap, wb] = ellipse(0, 0.9, 0.58, 0.2);
      paint(ctx, wrap, wb, look.accentColor, mat);
      const [end, eb] = capsule(0.28, 1.0, 0.33, 1.62, 0.14);
      paint(ctx, end, eb, look.accentColor, mat);
      break;
    }
    case "necklace":
      ctx.strokeStyle = "#e8c15a";
      ctx.lineWidth = 0.035;
      ctx.beginPath();
      ctx.ellipse(0, 0.98, 0.4, 0.3, 0, 0.1 * Math.PI, 0.9 * Math.PI);
      ctx.stroke();
      paint(ctx, ...ellipse(0, 1.3, 0.07, 0.07), "#e8c15a", "vinyl");
      break;
    case "badge": {
      ctx.strokeStyle = look.accentColor;
      ctx.lineWidth = 0.05;
      ctx.beginPath();
      ctx.moveTo(-0.3, 0.92);
      ctx.lineTo(-0.06, 1.55);
      ctx.moveTo(0.3, 0.92);
      ctx.lineTo(0.06, 1.55);
      ctx.stroke();
      const [card, cb] = roundRect(-0.2, 1.52, 0.4, 0.52, 0.05);
      paint(ctx, card, cb, "#f4f2fa", mat);
      ctx.fillStyle = look.accentColor;
      ctx.fillRect(-0.2, 1.57, 0.4, 0.1);
      paint(ctx, ...ellipse(0, 1.8, 0.07, 0.07), darken(rgb(look.skin), 0.1), mat);
      break;
    }
  }
}

function drawHairFront(ctx: CanvasRenderingContext2D, look: ResolvedHumanLook, hair: RGB, mat: HumanMaterial, fx: number, fy: number) {
  if (look.hair === "bald") return;
  const sx = fx * 0.6, sy = fy * 0.5;
  // The hairline across the forehead: [temple height, curve under it].
  const shape = (p: Path2D) => {
    switch (look.hair) {
      case "short":
        p.bezierCurveTo(-0.55, -0.8 + sy, 0.25 + sx, -0.35 + sy, 1.1, -0.05);
        break;
      case "sidepart":
        p.bezierCurveTo(-0.7, -0.45 + sy, -0.2 + sx, -0.25 + sy, 1.1, -0.2);
        break;
      case "mohawk":
        p.quadraticCurveTo(sx, -0.85 + sy, 1.1, -0.1);
        break;
      case "bob":
      case "long":
        p.lineTo(-1.1, 0.35);
        p.quadraticCurveTo(-0.75, -0.25 + sy, sx, -0.68 + sy);
        p.quadraticCurveTo(0.75, -0.25 + sy, 1.1, 0.35);
        break;
      default:
        p.quadraticCurveTo(sx, -0.75 + sy, 1.1, -0.05);
        break;
    }
  };
  ctx.save();
  ctx.clip(ellipse(0, 0, 1.07, 1.09)[0]);
  const p = new Path2D();
  p.moveTo(-1.2, -1.3);
  p.lineTo(-1.2, -0.05);
  p.lineTo(-1.1, -0.05);
  shape(p);
  p.lineTo(1.2, -0.05);
  p.lineTo(1.2, -1.3);
  p.closePath();
  if (look.hair === "buzz" || look.hair === "mohawk") { ctx.fillStyle = css(hair, look.hair === "mohawk" ? 0.55 : 0.82); ctx.fill(p); }
  else paint(ctx, p, { x: -1.1, y: -1.1, w: 2.2, h: 1.3 }, hair, mat);
  ctx.restore();

  if (look.hair === "quiff") {
    const [t, b] = ellipse(sx, -0.98 + sy, 0.62, 0.36, -0.1);
    paint(ctx, t, b, hair, mat);
  }
  if (look.hair === "mohawk") {
    for (let k = 0; k < 6; k++) {
      const [c, b] = ellipse(sx * 0.5, -0.62 - k * 0.12 + sy * 0.3, 0.17 - k * 0.006, 0.26, 0);
      paint(ctx, c, b, hair, mat);
    }
  }
  if (look.hair === "spiky") {
    const spikes = new Path2D();
    for (let a = -165; a <= -15; a += 15) {
      const r = (a * Math.PI) / 180, w = 0.13;
      const bx = Math.cos(r) * 0.95 + sx * 0.4, by = Math.sin(r) * 0.95 + sy * 0.3;
      spikes.moveTo(bx + Math.cos(r + Math.PI / 2) * w, by + Math.sin(r + Math.PI / 2) * w);
      spikes.lineTo(bx + Math.cos(r) * 0.42, by + Math.sin(r) * 0.42);
      spikes.lineTo(bx - Math.cos(r + Math.PI / 2) * w, by - Math.sin(r + Math.PI / 2) * w);
      spikes.closePath();
    }
    paint(ctx, spikes, { x: -1.4, y: -1.4, w: 2.8, h: 1.4 }, hair, mat);
  }
  if (look.hair === "curly" || look.hair === "afro") {
    const size = look.hair === "afro" ? 0.24 : 0.19;
    for (let a = -170; a <= -10; a += 20) {
      const r = (a * Math.PI) / 180;
      const [c, b] = ellipse(Math.cos(r) * 0.98 + sx * 0.4, Math.sin(r) * 0.98 + sy * 0.3, size, size);
      paint(ctx, c, b, hair, mat);
    }
  }
}

function drawGlasses(ctx: CanvasRenderingContext2D, look: ResolvedHumanLook, fx: number, fy: number) {
  if (look.glasses === "none") return;
  const frame = look.glasses === "shades" ? "#16161d" : look.accessoryColor;
  ctx.strokeStyle = frame;
  ctx.lineWidth = 0.05;
  ctx.lineCap = "round";
  for (const side of [1, -1]) {
    const x = side * 0.36 + fx, y = -0.06 + fy;
    ctx.beginPath();
    if (look.glasses === "square") ctx.roundRect(x - 0.22, y - 0.17, 0.44, 0.34, 0.06);
    else ctx.arc(x, y, 0.2, 0, TAU);
    if (look.glasses === "shades") {
      ctx.fillStyle = "rgba(13,13,18,0.88)";
      ctx.fill();
    }
    ctx.stroke();
    if (look.glasses === "shades") {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 0.03;
      ctx.beginPath();
      ctx.moveTo(x - 0.1, y - 0.08);
      ctx.lineTo(x - 0.02, y - 0.13);
      ctx.stroke();
      ctx.strokeStyle = frame;
      ctx.lineWidth = 0.05;
    }
    ctx.beginPath();
    ctx.moveTo(side * 0.56 + fx, y - 0.02);
    ctx.lineTo(side * 0.99, -0.02);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(-0.16 + fx, -0.1 + fy);
  ctx.quadraticCurveTo(fx, -0.16 + fy, 0.16 + fx, -0.1 + fy);
  ctx.stroke();
}

function drawHeadwear(ctx: CanvasRenderingContext2D, look: ResolvedHumanLook, mat: HumanMaterial, fx: number) {
  const acc = rgb(look.accessoryColor);
  if (look.headwear === "beret") {
    const [b, bb] = ellipse(0.12, -0.92, 1.12, 0.36, -0.22);
    paint(ctx, b, bb, acc, mat);
    const [stalk, sb] = roundRect(0.2, -1.36, 0.08, 0.16, 0.03);
    paint(ctx, stalk, sb, acc, mat);
  } else if (look.headwear === "beanie") {
    const dome = new Path2D();
    dome.ellipse(0, -0.55, 1.13, 0.78, 0, Math.PI, TAU);
    dome.closePath();
    paint(ctx, dome, { x: -1.13, y: -1.33, w: 2.26, h: 0.8 }, acc, mat);
    const [band, bb] = roundRect(-1.16, -0.72, 2.32, 0.3, 0.15);
    paint(ctx, band, bb, darken(acc, 0.08), mat);
    const [pom, pb] = ellipse(0, -1.38, 0.26, 0.26);
    paint(ctx, pom, pb, acc, mat);
  } else if (look.headwear === "cap") {
    const dome = new Path2D();
    dome.ellipse(0, -0.5, 1.1, 0.72, 0, Math.PI, TAU);
    dome.closePath();
    paint(ctx, dome, { x: -1.1, y: -1.22, w: 2.2, h: 0.75 }, acc, mat);
    const visor = new Path2D();
    visor.ellipse(fx * 0.6, -0.5, 0.88, 0.2, 0, 0, Math.PI);
    visor.closePath();
    paint(ctx, visor, { x: -0.88, y: -0.5, w: 1.76, h: 0.2 }, darken(acc, 0.15), mat);
  }
  if (look.headphones) {
    ctx.strokeStyle = css(acc);
    ctx.lineWidth = 0.14;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(0, -0.02, 1.16, Math.PI, TAU);
    ctx.stroke();
    for (const side of [1, -1]) {
      const [cup, cb] = roundRect(side * 1.08 - 0.14, -0.3, 0.28, 0.6, 0.13);
      paint(ctx, cup, cb, acc, mat);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Avatars and the frame loop — the 3D engine's, without the GPU.
 * ------------------------------------------------------------------ */

const pointer = { x: -1e5, y: -1e5 };
const onPointer = (e: PointerEvent) => { pointer.x = e.clientX; pointer.y = e.clientY; };
const instances = new Set<Flat>();
const byCanvas = new WeakMap<Element, Flat>();
let raf = 0;

const visibility = typeof IntersectionObserver !== "undefined"
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        const f = byCanvas.get(e.target);
        if (f) { f.visible = e.isIntersecting; if (f.visible) f.dirty = true; }
      }
    }, { rootMargin: "120px" })
  : null;

const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function tick(now: number) {
  raf = 0;
  if (!instances.size) return;
  raf = requestAnimationFrame(tick);
  if (document.hidden) return;
  const still = reducedMotion();
  for (const f of instances) {
    if (!f.isDue(now, still)) continue;
    try { f.draw(now, still); } catch { /* one broken avatar must not stop the others */ }
  }
}

class Flat {
  visible = true;
  dirty = true;
  private lastDraw = 0;
  private lastTick = 0;
  private following = false;
  private readonly motion: Motion;

  constructor(readonly canvas: HTMLCanvasElement, readonly ctx: CanvasRenderingContext2D, public opts: HumanOptions) {
    this.motion = new Motion(opts.offset);
  }

  poke() { if (this.motion.poke()) this.dirty = true; }

  isDue(now: number, still: boolean): boolean {
    if (!this.visible || !this.canvas.width) return false;
    if (this.opts.paused || still) return this.dirty;
    return this.dirty || now - this.lastDraw >= (this.following || this.motion.busy ? 15 : 32);
  }

  draw(now: number, still: boolean) {
    const frozen = this.opts.paused || still;
    const dt = frozen || !this.lastTick ? 0 : Math.min(0.1, (now - this.lastTick) / 1000) * this.opts.look.speed;
    this.lastTick = now;
    const follow = !frozen && this.opts.interactive ? followTarget(this.canvas.getBoundingClientRect(), pointer.x, pointer.y) : null;
    this.following = !!follow;
    const pose = this.motion.step(dt, frozen, this.opts.state, this.opts.look.mouth, follow);

    const { ctx, canvas } = this;
    // The same framing as the 3D camera: a bust, or head and shoulders.
    const [centre, height] = this.opts.closeUp ? [-0.35, 3.1] : [0.3, 4.6];
    const scale = canvas.height / height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(scale, scale);
    ctx.translate(0, -centre - pose.hop);
    drawFigure(ctx, this.opts.look, pose);
    this.lastDraw = now;
    this.dirty = false;
  }
}

/** Starts a flat avatar on a 2D canvas. */
export function mountFlatHuman(canvas: HTMLCanvasElement, opts: HumanOptions): HumanHandle | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const flat = new Flat(canvas, ctx, opts);
  if (!instances.size) window.addEventListener("pointermove", onPointer, { passive: true });
  instances.add(flat);
  byCanvas.set(canvas, flat);
  visibility?.observe(canvas);
  if (!raf) raf = requestAnimationFrame(tick);
  return {
    update: (next) => { flat.opts = { ...flat.opts, ...next }; flat.dirty = true; },
    resize: () => { flat.dirty = true; },
    poke: () => flat.poke(),
    dispose: () => {
      instances.delete(flat);
      byCanvas.delete(canvas);
      visibility?.unobserve(canvas);
      if (!instances.size) window.removeEventListener("pointermove", onPointer);
    },
  };
}
