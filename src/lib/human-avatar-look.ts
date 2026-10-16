import { nameHash } from "@/lib/bot-avatar-look";

// A 3D humanoid avatar — the other kind of avatar the studio makes, next to
// the bots. Stored like them in `avatar_url`, behind its own prefix:
// `human:` alone is a person whose every trait the agent's name picks,
// `human:?hair=bun&hairColor=b5482b&outfit=suit` once traits are chosen. Only
// what was chosen is written; the rest stays derived from the name, so two
// untouched agents never look alike.

export const HUMAN_PREFIX = "human:";

export type HairStyle =
  | "bald" | "buzz" | "short" | "sidepart" | "quiff" | "spiky" | "mohawk" | "curly" | "afro"
  | "bob" | "long" | "bun" | "ponytail" | "pigtails";
export type Beard = "none" | "stubble" | "mustache" | "goatee" | "full";
export type Outfit = "tshirt" | "polo" | "hoodie" | "shirt" | "jacket" | "suit" | "turtleneck";
export type HumanGlasses = "none" | "round" | "square" | "shades";
export type Headwear = "none" | "beanie" | "cap" | "beret";
export type FaceShape = "round" | "oval" | "square";
export type EyeStyle = "dots" | "big" | "lashes" | "sleepy";
export type Brows = "fine" | "normal" | "thick" | "none";
export type Build = "slim" | "regular" | "broad";
export type Neckwear = "none" | "scarf" | "necklace" | "badge";
export type Mouth = "smile" | "grin" | "neutral";
export type HumanMaterial = "clay" | "vinyl" | "toon";

export interface HumanLook {
  face?: FaceShape;
  skin?: string;
  freckles?: boolean;
  eyes?: string;
  eyeStyle?: EyeStyle;
  brows?: Brows;
  mouth?: Mouth;
  blush?: boolean;
  hair?: HairStyle;
  hairColor?: string;
  beard?: Beard;
  build?: Build;
  outfit?: Outfit;
  outfitColor?: string;
  accentColor?: string;
  neckwear?: Neckwear;
  glasses?: HumanGlasses;
  headwear?: Headwear;
  headphones?: boolean;
  earrings?: boolean;
  accessoryColor?: string;
  material?: HumanMaterial;
  speed?: number;
}

/** Every trait settled — what the renderer draws. */
export type ResolvedHumanLook = Required<HumanLook>;

type Option<T extends string> = { value: T; label: string };

export const SKIN_TONES: Option<string>[] = [
  { value: "#fde2d0", label: "Porcelaine" },
  { value: "#f6cfb2", label: "Clair" },
  { value: "#ecb98f", label: "Beige" },
  { value: "#d9a066", label: "Doré" },
  { value: "#c18452", label: "Caramel" },
  { value: "#9c6439", label: "Ambré" },
  { value: "#774728", label: "Brun" },
  { value: "#4f2e1a", label: "Ébène" },
];
export const HAIR_COLOURS: Option<string>[] = [
  { value: "#1b1410", label: "Noir" },
  { value: "#3b2417", label: "Brun foncé" },
  { value: "#6b4423", label: "Châtain" },
  { value: "#a8743f", label: "Caramel" },
  { value: "#e0b56e", label: "Blond" },
  { value: "#f3dfa6", label: "Blond clair" },
  { value: "#b5482b", label: "Roux" },
  { value: "#c9c9cf", label: "Gris" },
  { value: "#f2f2f2", label: "Blanc" },
  { value: "#4d7cff", label: "Bleu" },
  { value: "#e46fb5", label: "Rose" },
  { value: "#7a5cff", label: "Violet" },
];
export const EYE_COLOURS: Option<string>[] = [
  { value: "#2b1d14", label: "Marron" },
  { value: "#8a5a2b", label: "Noisette" },
  { value: "#3d6fb6", label: "Bleu" },
  { value: "#4f8a52", label: "Vert" },
  { value: "#6b7b8c", label: "Gris" },
  { value: "#1a1a22", label: "Noir" },
];
export const OUTFIT_COLOURS = [
  "#4d7cff", "#2fcb7a", "#ff7a59", "#ffc94d", "#9a62ff", "#1ed3c6",
  "#ee8bdb", "#c0392b", "#95a6c4", "#3a3a48", "#16161d", "#f4f2fa",
];
export const ACCENT_COLOURS = ["#f4f2fa", "#16161d", "#c0392b", "#ffc94d", "#4d7cff", "#2fcb7a"];

export const HAIR_STYLES: Option<HairStyle>[] = [
  { value: "bald", label: "Chauve" },
  { value: "buzz", label: "Ras" },
  { value: "short", label: "Court" },
  { value: "sidepart", label: "Raie sur le côté" },
  { value: "quiff", label: "Houppe" },
  { value: "spiky", label: "En pics" },
  { value: "mohawk", label: "Crête" },
  { value: "curly", label: "Bouclé" },
  { value: "afro", label: "Afro" },
  { value: "bob", label: "Carré" },
  { value: "long", label: "Long" },
  { value: "bun", label: "Chignon" },
  { value: "ponytail", label: "Queue de cheval" },
  { value: "pigtails", label: "Couettes" },
];
export const BEARDS: Option<Beard>[] = [
  { value: "none", label: "Aucune" },
  { value: "stubble", label: "Naissante" },
  { value: "mustache", label: "Moustache" },
  { value: "goatee", label: "Bouc" },
  { value: "full", label: "Barbe" },
];
export const OUTFITS: Option<Outfit>[] = [
  { value: "tshirt", label: "T-shirt" },
  { value: "polo", label: "Polo" },
  { value: "hoodie", label: "Sweat à capuche" },
  { value: "shirt", label: "Chemise" },
  { value: "jacket", label: "Veste ouverte" },
  { value: "suit", label: "Costume" },
  { value: "turtleneck", label: "Col roulé" },
];
export const HUMAN_GLASSES: Option<HumanGlasses>[] = [
  { value: "none", label: "Aucune" },
  { value: "round", label: "Rondes" },
  { value: "square", label: "Carrées" },
  { value: "shades", label: "Solaires" },
];
export const HEADWEAR: Option<Headwear>[] = [
  { value: "none", label: "Aucun" },
  { value: "beanie", label: "Bonnet" },
  { value: "cap", label: "Casquette" },
  { value: "beret", label: "Béret" },
];
export const FACE_SHAPES: Option<FaceShape>[] = [
  { value: "round", label: "Rond" },
  { value: "oval", label: "Ovale" },
  { value: "square", label: "Carré" },
];
export const EYE_STYLES: Option<EyeStyle>[] = [
  { value: "dots", label: "Points" },
  { value: "big", label: "Grands" },
  { value: "lashes", label: "Avec cils" },
  { value: "sleepy", label: "Mi-clos" },
];
export const BROWS: Option<Brows>[] = [
  { value: "fine", label: "Fins" },
  { value: "normal", label: "Normaux" },
  { value: "thick", label: "Épais" },
  { value: "none", label: "Aucun" },
];
export const BUILDS: Option<Build>[] = [
  { value: "slim", label: "Fine" },
  { value: "regular", label: "Moyenne" },
  { value: "broad", label: "Large" },
];
export const NECKWEAR: Option<Neckwear>[] = [
  { value: "none", label: "Rien" },
  { value: "scarf", label: "Écharpe" },
  { value: "necklace", label: "Collier" },
  { value: "badge", label: "Badge" },
];
export const MOUTHS: Option<Mouth>[] = [
  { value: "smile", label: "Sourire" },
  { value: "grin", label: "Rire" },
  { value: "neutral", label: "Neutre" },
];
export const HUMAN_MATERIALS: { value: HumanMaterial; label: string; hint: string }[] = [
  { value: "clay", label: "Argile", hint: "Mat et doux" },
  { value: "vinyl", label: "Vinyle", hint: "Figurine laquée" },
  { value: "toon", label: "Cartoon", hint: "Aplats dessinés" },
];

const ENUMS = {
  face: FACE_SHAPES.map((o) => o.value),
  eyeStyle: EYE_STYLES.map((o) => o.value),
  brows: BROWS.map((o) => o.value),
  build: BUILDS.map((o) => o.value),
  neckwear: NECKWEAR.map((o) => o.value),
  mouth: MOUTHS.map((o) => o.value),
  hair: HAIR_STYLES.map((o) => o.value),
  beard: BEARDS.map((o) => o.value),
  outfit: OUTFITS.map((o) => o.value),
  glasses: HUMAN_GLASSES.map((o) => o.value),
  headwear: HEADWEAR.map((o) => o.value),
  material: HUMAN_MATERIALS.map((o) => o.value),
} as const;
const COLOURS = ["skin", "eyes", "hairColor", "outfitColor", "accentColor", "accessoryColor"] as const;
const FLAGS = ["blush", "freckles", "headphones", "earrings"] as const;
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
export const SPEED_RANGE = { min: 0.25, max: 2.5, step: 0.05 } as const;

export const isHumanAvatar = (url: string | null | undefined): boolean => !!url?.startsWith(HUMAN_PREFIX);

/** The look stored in an avatar value, or null when it is not a person.
 *  Unknown entries are dropped, numbers clamped — never trusted. */
export function parseHumanLook(url: string | null | undefined): HumanLook | null {
  if (!isHumanAvatar(url)) return null;
  const q = url!.indexOf("?");
  const params = new URLSearchParams(q < 0 ? "" : url!.slice(q + 1));
  const look: HumanLook = {};
  for (const [key, allowed] of Object.entries(ENUMS)) {
    const v = params.get(key);
    if (v && (allowed as readonly string[]).includes(v)) (look as Record<string, unknown>)[key] = v;
  }
  for (const key of COLOURS) {
    const m = params.get(key)?.match(HEX);
    if (m) look[key] = `#${m[1].toLowerCase()}`;
  }
  // A flag is written 1 or 0: switching blush off has to survive the name
  // having switched it on.
  for (const key of FLAGS) {
    const v = params.get(key);
    if (v === "1" || v === "0") look[key] = v === "1";
  }
  const speed = Number(params.get("speed"));
  if (params.has("speed") && Number.isFinite(speed)) look.speed = Math.min(SPEED_RANGE.max, Math.max(SPEED_RANGE.min, speed));
  return look;
}

/** The avatar value for a look — `human:` alone when nothing is chosen. */
export function serializeHumanLook(look: HumanLook): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(ENUMS) as (keyof typeof ENUMS)[]) {
    const v = look[key];
    if (v) params.set(key, v);
  }
  for (const key of COLOURS) {
    const m = look[key]?.match(HEX);
    if (m) params.set(key, m[1].toLowerCase());
  }
  for (const key of FLAGS) if (look[key] !== undefined) params.set(key, look[key] ? "1" : "0");
  if (typeof look.speed === "number") params.set("speed", String(Math.round(look.speed * 100) / 100));
  const query = params.toString();
  return `${HUMAN_PREFIX}${query ? `?${query}` : ""}`;
}

/** Every trait, the chosen ones as chosen and the others from the name. */
export function resolveHumanLook(look: HumanLook, seed: string): ResolvedHumanLook {
  // Each trait reads its own slice of the hash, salted, so traits do not move
  // in lockstep (every blond in a suit).
  const roll = (salt: string) => nameHash(`${seed || "agent"}·${salt}`);
  const pickOf = <T,>(xs: readonly T[], salt: string) => xs[roll(salt) % xs.length];
  const chance = (salt: string, p: number) => (roll(salt) % 1000) / 1000 < p;

  const autoHair = pickOf(["short", "short", "quiff", "curly", "afro", "bob", "long", "bun", "ponytail", "buzz", "bald"] as const, "hair");
  const autoBeard: Beard = chance("beard?", 0.28) ? pickOf(["stubble", "mustache", "goatee", "full"] as const, "beard") : "none";
  // The pools below are frozen lists, not the option lists: adding an option
  // must not hand every untouched person a new haircut. Traits added later
  // read their own salts, for the same reason.
  return {
    face: look.face ?? pickOf(["oval", "oval", "round", "square"] as const, "face"),
    skin: look.skin ?? pickOf(SKIN_TONES, "skin").value,
    freckles: look.freckles ?? chance("freckles", 0.12),
    eyes: look.eyes ?? pickOf(EYE_COLOURS, "eyes").value,
    eyeStyle: look.eyeStyle ?? (chance("eyeStyle?", 0.3) ? pickOf(["big", "lashes"] as const, "eyeStyle") : "dots"),
    brows: look.brows ?? "normal",
    mouth: look.mouth ?? "smile",
    blush: look.blush ?? chance("blush", 0.5),
    hair: look.hair ?? autoHair,
    hairColor: look.hairColor ?? pickOf(HAIR_COLOURS.slice(0, 9), "hairColor").value,
    beard: look.beard ?? autoBeard,
    build: look.build ?? "regular",
    outfit: look.outfit ?? pickOf(["tshirt", "hoodie", "shirt", "suit", "turtleneck"] as const, "outfit"),
    outfitColor: look.outfitColor ?? pickOf(OUTFIT_COLOURS, "outfitColor"),
    accentColor: look.accentColor ?? pickOf(ACCENT_COLOURS, "accent"),
    neckwear: look.neckwear ?? (chance("neckwear?", 0.12) ? "badge" : "none"),
    glasses: look.glasses ?? (chance("glasses?", 0.25) ? pickOf(["round", "square"] as const, "glasses") : "none"),
    headwear: look.headwear ?? "none",
    headphones: look.headphones ?? false,
    earrings: look.earrings ?? chance("earrings", 0.15),
    accessoryColor: look.accessoryColor ?? "#2b2b33",
    material: look.material ?? "clay",
    speed: look.speed ?? 1,
  };
}
