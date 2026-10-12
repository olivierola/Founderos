import {
  botAvatarPalette, botAvatarPresets, botAvatarTypes,
  type BotAvatarFace, type BotAvatarGlasses, type BotAvatarHat, type BotAvatarProps,
  type BotAvatarShading, type BotAvatarSquashEase, type BotAvatarType,
} from "bot-avatars";

// An agent's bot as the avatar studio dresses it — and how that is stored.
//
// Everything lives in `avatar_url`, behind the `bot:` prefix the picker already
// used: `bot:drop` for a body alone, `bot:drop?color=ff7a00&shading=plastic&hat=crown`
// once it is dressed. No migration, the value reads for itself in the database,
// and every surface that has the URL draws the same bot — its colour included,
// which is why the colour is no longer borrowed from the agent's accent: half
// the screens passed the accent and half did not, so one agent wore two colours.
// Only what was actually chosen is written, so the string stays short.

export const BOT_PREFIX = "bot:";
/** Written when the name still picks the body but the rest was chosen. */
const AUTO_BODY = "auto";

/* ------------------------------------------------------------------ *
 * Bodies of our own drawing. The library inflates, lights and animates any
 * outline (`path`, SVG data in its 100×100 box centred on 50,50), but the face
 * still sits where a stock type puts it — `base` is the type whose face fits
 * the outline. Bases are picked among types without their own brightness or
 * saturation preset, so a body keeps the colour it is given.
 * ------------------------------------------------------------------ */

/** A ring of scallops round the centre: a badge, a seal, a burst. */
function scallops(count: number, radius: number, bulge: number): string {
  const f = (v: number) => v.toFixed(2);
  const pts = Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 - Math.PI / 2;
    return [50 + radius * Math.cos(a), 50 + radius * Math.sin(a)];
  });
  const r = radius * Math.sin(Math.PI / count) * bulge;
  return `M${f(pts[0][0])} ${f(pts[0][1])}`
    + pts.map((_, i) => { const p = pts[(i + 1) % count]; return `A${f(r)} ${f(r)} 0 0 1 ${f(p[0])} ${f(p[1])}`; }).join("")
    + "Z";
}

export const CUSTOM_BODIES = {
  egg: {
    label: "Œuf", base: "cloud", color: "#F4B183",
    path: "M50 8C71 8 85 37 85 59C85 79 70 92 50 92C30 92 15 79 15 59C15 37 29 8 50 8Z",
  },
  squircle: {
    label: "Galet carré", base: "square", color: "#FF9F5A",
    path: "M50 9C81 9 91 19 91 50C91 81 81 91 50 91C19 91 9 81 9 50C9 19 19 9 50 9Z",
  },
  burst: { label: "Sceau", base: "circle", color: "#FF7A59", path: scallops(12, 38, 1.2) },
  heart: {
    label: "Cœur", base: "circle", color: "#FF5C8A",
    path: "M50 88C50 88 12 64 12 38C12 24 23 14 35 14C42 14 47 18 50 23C53 18 58 14 65 14C77 14 88 24 88 38C88 64 50 88 50 88Z",
  },
  shield: {
    label: "Bouclier", base: "alien", color: "#4D7CFF",
    path: "M50 8C61 14 73 17 86 17C86 53 75 78 50 92C25 78 14 53 14 17C27 17 39 14 50 8Z",
  },
  diamond: {
    label: "Losange", base: "hexagon", color: "#3CCFE0",
    path: "M50 6C54 6 57 8 60 12L88 44C91 47.5 91 52.5 88 56L60 88C57 92 54 94 50 94C46 94 43 92 40 88L12 56C9 52.5 9 47.5 12 44L40 12C43 8 46 6 50 6Z",
  },
  bubble: {
    label: "Bulle", base: "alien", color: "#6FA8FF",
    path: "M24 12H76C85 12 92 19 92 28V58C92 67 85 74 76 74H46L30 90C28.5 91.5 26 90.6 26 88.5V74H24C15 74 8 67 8 58V28C8 19 15 12 24 12Z",
  },
  capsule: {
    label: "Capsule", base: "pill", color: "#FFB547",
    path: "M50 6C65 6 75 17 75 32V68C75 83 65 94 50 94C35 94 25 83 25 68V32C25 17 35 6 50 6Z",
  },
  // A round head and two round ears, as ONE outline (the arcs meet where the
  // circles cross) — overlapping sub-paths could be read as holes.
  bear: {
    label: "Ourson", base: "cloud", color: "#C68B59",
    path: "M19.61 38.71A12 12 0 1 1 36.51 24.63A36 36 0 0 1 63.49 24.63A12 12 0 1 1 80.39 38.71A36 36 0 1 1 19.61 38.71Z",
  },
  bunny: {
    label: "Lapin", base: "drop", color: "#F3E3EE",
    path: "M34 34.3C30 22 31 6 39 6C47 6 46 22 44 30.6A32 32 0 0 1 56 30.6C54 22 53 6 61 6C69 6 70 22 66 34.3A32 32 0 1 1 34 34.3Z",
  },
} satisfies Record<string, { label: string; base: BotAvatarType; color: string; path: string }>;

export type CustomBody = keyof typeof CUSTOM_BODIES;
export type BotBody = BotAvatarType | CustomBody;

const STOCK_LABELS: Record<BotAvatarType, string> = {
  clover: "Trèfle", flower: "Fleur", triangle: "Triangle", square: "Carré", blob: "Blob",
  ghost: "Fantôme", circle: "Cercle", drop: "Goutte", star: "Étoile", droid: "Droïde",
  mech: "Méca", alien: "Alien", hexagon: "Hexagone", cat: "Chat", cloud: "Nuage",
  pill: "Gélule", pebble: "Galet", puddle: "Flaque",
};

export const botBodies: BotBody[] = [...botAvatarTypes, ...(Object.keys(CUSTOM_BODIES) as CustomBody[])];

const isCustomBody = (b: string): b is CustomBody => b in CUSTOM_BODIES;
const isBody = (b: string): b is BotBody => (botAvatarTypes as string[]).includes(b) || isCustomBody(b);

export const bodyLabel = (b: BotBody): string => (isCustomBody(b) ? CUSTOM_BODIES[b].label : STOCK_LABELS[b]);
/** The colour a body wears when none was chosen. */
export const bodyColor = (b: BotBody): string => (isCustomBody(b) ? CUSTOM_BODIES[b].color : botAvatarPalette[b]);
/** The stock type that carries the body: itself, or the base of a drawn one. */
export const bodyType = (b: BotBody): BotAvatarType => (isCustomBody(b) ? CUSTOM_BODIES[b].base : b);

/** Stable 32-bit hash — same agent, same body, on every screen and reload. */
export function nameHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The body an agent's name picks when none was chosen — among the stock
 *  bodies only: the drawn ones came later, and a wider pool would have handed
 *  every existing agent a new body. */
export const autoBody = (seed: string): BotAvatarType =>
  botAvatarTypes[nameHash(seed || "agent") % botAvatarTypes.length];

/* ------------------------------------------------------------------ *
 * The look.
 * ------------------------------------------------------------------ */

export interface BotLook {
  /** Unset: the agent's name picks the body. */
  body?: BotBody;
  face?: BotAvatarFace;
  color?: string;
  ink?: string;
  brightness?: number;
  saturation?: number;
  shading?: BotAvatarShading;
  depth?: number;
  roundness?: number;
  furLength?: number;
  furDensity?: number;
  furFuzz?: number;
  furClumps?: number;
  furCurl?: number;
  furGravity?: number;
  shine?: number;
  sheen?: number;
  light?: number;
  shadow?: number;
  highlight?: number;
  rim?: number;
  spread?: number;
  lightFront?: number;
  backLight?: number;
  backSoftness?: number;
  hat?: BotAvatarHat;
  glasses?: BotAvatarGlasses;
  headphones?: boolean;
  bowTie?: boolean;
  accessoryColor?: string;
  speed?: number;
  turn?: number;
  whirl?: number;
  jumpHeight?: number;
  jumpSpin?: number;
  jumpEvery?: number;
  jumpSquashEase?: BotAvatarSquashEase;
}

/** The house style: a long, dense plush. What an untouched bot wears. */
export const HOUSE_LOOK = { shading: "fabric", furLength: 2.3, furDensity: 2, furFuzz: 1 } as const satisfies BotLook;

type NumberKey = { [K in keyof BotLook]-?: NonNullable<BotLook[K]> extends number ? K : never }[keyof BotLook];
export type LookGroup = "colour" | "material" | "fur" | "light" | "motion";

export interface NumberSpec {
  key: NumberKey;
  label: string;
  group: LookGroup;
  min: number;
  max: number;
  step: number;
  unit?: string;
  /** What the library draws when the value is unset; null when it decides by itself. */
  def: (type: BotAvatarType, shading: BotAvatarShading) => number | null;
  /** The textures it has an effect on; every one when absent. */
  only?: BotAvatarShading[];
  /** How to read 0, when 0 means "none". */
  zero?: string;
}

const LIT: BotAvatarShading[] = ["fabric", "plastic", "crisp", "smooth"];
const fab = (s: BotAvatarShading) => s === "fabric";

/** Every numeric knob of the library, with its range — the studio's sliders
 *  and the parser's clamps both read it. */
export const NUMBER_SPECS: NumberSpec[] = [
  { key: "brightness", label: "Luminosité", group: "colour", min: 0.5, max: 1.5, step: 0.01, def: (t) => botAvatarPresets[t].brightness ?? 1 },
  { key: "saturation", label: "Saturation", group: "colour", min: 0.5, max: 2.5, step: 0.01, def: (t) => botAvatarPresets[t].saturation ?? 1.5 },

  { key: "depth", label: "Épaisseur", group: "material", min: 0.2, max: 2, step: 0.01, def: () => 0.65 },
  { key: "roundness", label: "Rondeur", group: "material", min: 0, max: 1, step: 0.01, def: () => 1, only: ["fabric", "plastic"] },

  { key: "furLength", label: "Longueur des poils", group: "fur", min: 0.3, max: 2.5, step: 0.01, def: () => HOUSE_LOOK.furLength, only: ["fabric"] },
  { key: "furDensity", label: "Densité", group: "fur", min: 0.3, max: 2, step: 0.01, def: () => HOUSE_LOOK.furDensity, only: ["fabric"] },
  { key: "furFuzz", label: "Duvet du contour", group: "fur", min: 0, max: 1, step: 0.01, def: () => HOUSE_LOOK.furFuzz, only: ["fabric"] },
  { key: "furClumps", label: "Mèches", group: "fur", min: 0, max: 1, step: 0.01, def: () => 0.4, only: ["fabric"] },
  { key: "furCurl", label: "Ondulation", group: "fur", min: 0, max: 1, step: 0.01, def: () => 0.7, only: ["fabric"] },
  { key: "furGravity", label: "Tombé", group: "fur", min: 0, max: 1, step: 0.01, def: () => 0.9, only: ["fabric"] },
  { key: "shine", label: "Reflets des fibres", group: "fur", min: 0, max: 2, step: 0.01, def: () => 0, only: ["fabric"] },
  { key: "sheen", label: "Satiné", group: "fur", min: 0, max: 2, step: 0.01, def: () => 0, only: ["fabric"] },

  { key: "light", label: "Direction de la lumière", group: "light", min: 0, max: 359, step: 1, unit: "°", def: (_, s) => (fab(s) ? 295 : 300), only: LIT },
  { key: "shadow", label: "Ombre", group: "light", min: 0, max: 2, step: 0.01, def: (_, s) => (fab(s) ? 1.15 : 0.35), only: LIT },
  { key: "highlight", label: "Éclat", group: "light", min: 0, max: 2, step: 0.01, def: (_, s) => (fab(s) ? 1.45 : 1.3), only: LIT },
  { key: "rim", label: "Contour lumineux", group: "light", min: 0, max: 2, step: 0.01, def: (_, s) => (fab(s) ? 0.6 : 0.5), only: ["fabric", "plastic", "crisp"] },
  { key: "spread", label: "Diffusion", group: "light", min: 0.4, max: 2.5, step: 0.01, def: (_, s) => (fab(s) ? 1.6 : 1.55), only: ["fabric", "plastic", "smooth"] },
  { key: "lightFront", label: "Lumière de face", group: "light", min: 0, max: 85, step: 1, unit: "°", def: () => 32, only: ["fabric"] },
  { key: "backLight", label: "Contre-jour", group: "light", min: 0, max: 359, step: 1, unit: "°", def: () => null, only: ["fabric"] },
  { key: "backSoftness", label: "Douceur du contre-jour", group: "light", min: 0, max: 1, step: 0.01, def: () => 1, only: ["fabric"] },

  { key: "speed", label: "Vitesse", group: "motion", min: 0.25, max: 2.5, step: 0.05, unit: "×", def: () => 1 },
  { key: "turn", label: "Regard alentour", group: "motion", min: 0, max: 2, step: 0.05, def: () => 1 },
  { key: "whirl", label: "Tourbillon", group: "motion", min: 0, max: 2, step: 0.05, def: () => 0, zero: "aucun" },
  { key: "jumpHeight", label: "Hauteur des sauts", group: "motion", min: 0, max: 60, step: 1, def: () => 26 },
  { key: "jumpSpin", label: "Tours en l'air", group: "motion", min: 0, max: 2, step: 0.05, def: () => 1, zero: "aucun" },
  { key: "jumpEvery", label: "Un saut toutes les", group: "motion", min: 0, max: 30, step: 1, unit: " s", def: () => 8, zero: "jamais" },
];

export const FACES: { value: BotAvatarFace; label: string }[] = [
  { value: "eyes", label: "Les yeux" },
  { value: "mouth", label: "Yeux et bouche" },
];
export const SHADINGS: { value: BotAvatarShading; label: string; hint: string }[] = [
  { value: "fabric", label: "Peluche", hint: "Fourrure douce" },
  { value: "plastic", label: "Plastique", hint: "Brillant, laqué" },
  { value: "crisp", label: "Net", hint: "Liseré lumineux" },
  { value: "smooth", label: "Doux", hint: "Ombre estompée" },
  { value: "flat", label: "Mat", hint: "Sans lumière" },
];
export const HATS: { value: BotAvatarHat; label: string }[] = [
  { value: "none", label: "Aucun" },
  { value: "beret", label: "Béret" },
  { value: "beanie", label: "Bonnet" },
  { value: "party", label: "Cône de fête" },
  { value: "crown", label: "Couronne" },
];
export const GLASSES: { value: BotAvatarGlasses; label: string }[] = [
  { value: "none", label: "Aucune" },
  { value: "round", label: "Rondes" },
  { value: "square", label: "Carrées" },
  { value: "shades", label: "Solaires" },
];
export const LANDINGS: { value: BotAvatarSquashEase; label: string }[] = [
  { value: "pulse", label: "Ferme" },
  { value: "sharp", label: "Sec" },
  { value: "soft", label: "Souple" },
  { value: "bouncy", label: "Rebondi" },
];

const ENUMS = {
  face: FACES.map((o) => o.value),
  shading: SHADINGS.map((o) => o.value),
  hat: HATS.map((o) => o.value),
  glasses: GLASSES.map((o) => o.value),
  jumpSquashEase: LANDINGS.map((o) => o.value),
} as const;
const COLOURS = ["color", "ink", "accessoryColor"] as const;
const FLAGS = ["headphones", "bowTie"] as const;

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The look stored in an avatar value, or null when it is not a bot (an
 *  uploaded portrait, a DiceBear URL, nothing). Unknown or out-of-range
 *  entries are dropped or clamped, never trusted. */
export function parseBotLook(url: string | null | undefined): BotLook | null {
  if (!url?.startsWith(BOT_PREFIX)) return null;
  const rest = url.slice(BOT_PREFIX.length);
  const q = rest.indexOf("?");
  const head = q < 0 ? rest : rest.slice(0, q);
  const params = new URLSearchParams(q < 0 ? "" : rest.slice(q + 1));
  const look: BotLook = {};
  if (isBody(head)) look.body = head;

  for (const [key, allowed] of Object.entries(ENUMS)) {
    const v = params.get(key);
    if (v && (allowed as readonly string[]).includes(v)) (look as Record<string, unknown>)[key] = v;
  }
  for (const key of COLOURS) {
    const m = params.get(key)?.match(HEX);
    if (m) look[key] = `#${m[1].toLowerCase()}`;
  }
  for (const key of FLAGS) if (params.get(key) === "1") look[key] = true;
  for (const spec of NUMBER_SPECS) {
    const raw = params.get(spec.key);
    const n = raw == null || raw === "" ? NaN : Number(raw);
    if (Number.isFinite(n)) look[spec.key] = Math.min(spec.max, Math.max(spec.min, n));
  }
  return look;
}

/** The avatar value for a look; "" when nothing is chosen at all — the
 *  agent's name then picks everything, as it always did. */
export function serializeBotLook(look: BotLook): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(ENUMS) as (keyof typeof ENUMS)[]) {
    const v = look[key];
    if (v) params.set(key, v);
  }
  for (const key of COLOURS) {
    const m = look[key]?.match(HEX);
    if (m) params.set(key, m[1].toLowerCase());
  }
  for (const key of FLAGS) if (look[key]) params.set(key, "1");
  for (const spec of NUMBER_SPECS) {
    const v = look[spec.key];
    if (typeof v === "number" && Number.isFinite(v)) params.set(spec.key, String(Math.round(v * 1000) / 1000));
  }
  const query = params.toString();
  if (!look.body && !query) return "";
  return `${BOT_PREFIX}${look.body ?? AUTO_BODY}${query ? `?${query}` : ""}`;
}

/** The props `<BotAvatar>` takes for a look; `fallback` is the body the name
 *  picked, worn when none was chosen. */
export function botAvatarLookProps(look: BotLook, fallback: BotBody): BotAvatarProps & { type: BotAvatarType } {
  const body = look.body ?? fallback;
  const custom = isCustomBody(body) ? CUSTOM_BODIES[body] : null;
  const { body: _body, ...rest } = look;
  return {
    ...HOUSE_LOOK,
    ...rest,
    type: custom ? custom.base : (body as BotAvatarType),
    path: custom?.path,
    color: look.color ?? custom?.color,
  };
}
