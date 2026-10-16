import { SoftToggle } from "@/components/ui/soft-form";
import {
  ACCENT_COLOURS, BEARDS, BROWS, BUILDS, EYE_COLOURS, EYE_STYLES, FACE_SHAPES, HAIR_COLOURS, HAIR_STYLES,
  HEADWEAR, HUMAN_GLASSES, HUMAN_MATERIALS, MOUTHS, NECKWEAR, OUTFITS, OUTFIT_COLOURS, SKIN_TONES, SPEED_RANGE,
  serializeHumanLook, type HumanLook, type ResolvedHumanLook,
} from "@/lib/human-avatar-look";
import { LookSlider, OptionTiles, Section, SwatchRow, type TileOption } from "./studio-controls";

// The human half of the avatar studio. Choices are shown, not named: every
// tile draws this agent wearing that choice. Every trait the studio leaves
// open is picked from the agent's name, so each row offers « Auto » first —
// what the name picked — and the choices after it.

export type HumanTab = "presets" | "face" | "hair" | "outfit" | "wear" | "material" | "motion";
export const HUMAN_TABS: { id: HumanTab; label: string }[] = [
  { id: "presets", label: "Modèles" },
  { id: "face", label: "Visage" },
  { id: "hair", label: "Cheveux" },
  { id: "outfit", label: "Tenue" },
  { id: "wear", label: "Accessoires" },
  { id: "material", label: "Matière" },
  { id: "motion", label: "Animation" },
];

/** Ready-made people to start from, named after the work they do. */
export const HUMAN_PRESETS: { name: string; look: HumanLook }[] = [
  { name: "Analyse", look: { face: "oval", skin: "#ecb98f", hair: "sidepart", hairColor: "#3b2417", glasses: "square", outfit: "shirt", outfitColor: "#4d7cff", accentColor: "#f4f2fa", beard: "none" } },
  { name: "Ventes", look: { skin: "#c18452", hair: "long", hairColor: "#1b1410", eyeStyle: "lashes", outfit: "jacket", outfitColor: "#16161d", accentColor: "#ff7a59", neckwear: "necklace", earrings: true, blush: true, beard: "none", glasses: "none" } },
  { name: "Développement", look: { skin: "#f6cfb2", hair: "short", hairColor: "#6b4423", beard: "stubble", outfit: "hoodie", outfitColor: "#3a3a48", accentColor: "#2fcb7a", headphones: true, glasses: "none" } },
  { name: "Recherche", look: { skin: "#774728", hair: "afro", hairColor: "#1b1410", glasses: "round", outfit: "turtleneck", outfitColor: "#9a62ff", beard: "none", neckwear: "none" } },
  { name: "Support", look: { skin: "#d9a066", hair: "ponytail", hairColor: "#a8743f", outfit: "polo", outfitColor: "#1ed3c6", accentColor: "#f4f2fa", headphones: true, mouth: "grin", beard: "none", glasses: "none" } },
  { name: "Direction", look: { face: "square", skin: "#fde2d0", hair: "buzz", hairColor: "#c9c9cf", beard: "full", outfit: "suit", outfitColor: "#3a3a48", accentColor: "#c0392b", glasses: "none" } },
  { name: "Design", look: { skin: "#ecb98f", hair: "bob", hairColor: "#e46fb5", outfit: "tshirt", outfitColor: "#ffc94d", headwear: "beret", accessoryColor: "#16161d", freckles: true, beard: "none", glasses: "none" } },
  { name: "Data", look: { skin: "#9c6439", hair: "bun", hairColor: "#3b2417", glasses: "square", outfit: "shirt", outfitColor: "#f4f2fa", accentColor: "#4d7cff", neckwear: "badge", beard: "none" } },
  { name: "Opérations", look: { skin: "#4f2e1a", hair: "bald", beard: "goatee", outfit: "jacket", outfitColor: "#95a6c4", accentColor: "#16161d", glasses: "shades" } },
  { name: "Junior", look: { face: "round", skin: "#f6cfb2", hair: "spiky", hairColor: "#e0b56e", outfit: "hoodie", outfitColor: "#ff7a59", accentColor: "#f4f2fa", headwear: "cap", accessoryColor: "#4d7cff", eyeStyle: "big", beard: "none", glasses: "none" } },
];

const ACCESSORY_COLOURS = ["#2b2b33", "#f4efe6", "#c0392b", "#e67e22", "#f1c40f", "#27ae60", "#2e86de", "#8e44ad"];

type EnumKey = "face" | "eyeStyle" | "brows" | "mouth" | "hair" | "beard" | "build" | "outfit" | "neckwear" | "glasses" | "headwear" | "material";
type ColourKey = "skin" | "eyes" | "hairColor" | "outfitColor" | "accentColor" | "accessoryColor";
export type HumanSetter = (key: keyof HumanLook, value: HumanLook[keyof HumanLook] | undefined) => void;

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

/** A whole person at random — the « Surprise » button. */
export function randomHumanLook(): HumanLook {
  return {
    face: pick(FACE_SHAPES).value,
    skin: pick(SKIN_TONES).value,
    eyes: pick(EYE_COLOURS).value,
    eyeStyle: pick(EYE_STYLES.slice(0, 3)).value,
    freckles: Math.random() < 0.15,
    hair: pick(HAIR_STYLES).value,
    hairColor: pick(HAIR_COLOURS).value,
    beard: Math.random() < 0.3 ? pick(BEARDS.slice(1)).value : "none",
    build: pick(BUILDS).value,
    outfit: pick(OUTFITS).value,
    outfitColor: pick(OUTFIT_COLOURS),
    accentColor: pick(ACCENT_COLOURS),
    neckwear: Math.random() < 0.3 ? pick(NECKWEAR.slice(1)).value : "none",
    glasses: Math.random() < 0.3 ? pick(HUMAN_GLASSES.slice(1)).value : "none",
    headwear: Math.random() < 0.2 ? pick(HEADWEAR.slice(1)).value : "none",
    headphones: Math.random() < 0.15,
    blush: Math.random() < 0.5,
    mouth: pick(MOUTHS).value,
  };
}

/** Tiles that frame the head (hair, face, glasses), and the bust (clothes). */
const HEAD = 52;
const BUST = 64;

export function HumanAvatarControls({ tab, look, thumb, resolved, auto, seed, set, apply }: {
  tab: HumanTab;
  look: HumanLook;
  /** The look the tiles are drawn from — the same, a beat behind. */
  thumb: HumanLook;
  /** What is drawn: the choices, and the name for the rest. */
  resolved: ResolvedHumanLook;
  /** What the name alone picks — shown on the « Auto » options. */
  auto: ResolvedHumanLook;
  seed: string;
  set: HumanSetter;
  /** Replaces the whole look (the presets). */
  apply: (look: HumanLook) => void;
}) {
  const tiles = (key: EnumKey, options: { value: string; label: string }[], size: number) => {
    const picked = options.find((o) => o.value === auto[key])?.label ?? "";
    const withoutKey = { ...thumb };
    delete withoutKey[key];
    const list: TileOption<string>[] = [
      { value: "auto", label: "Auto", title: `Auto — ${picked}, d'après le nom`, url: serializeHumanLook(withoutKey) },
      ...options.map((o) => ({ ...o, url: serializeHumanLook({ ...thumb, [key]: o.value }) })),
    ];
    return (
      <OptionTiles
        options={list}
        value={(look[key] as string | undefined) ?? "auto"}
        onChange={(v) => set(key, v === "auto" ? undefined : v)}
        seed={seed}
        size={size}
        framing={size === HEAD ? "head" : "bust"}
      />
    );
  };

  const colours = (key: ColourKey, palette: (string | { value: string; label: string })[]) => (
    <SwatchRow auto={auto[key]} value={look[key]} palette={palette} onChange={(c) => set(key, c)} />
  );

  switch (tab) {
    case "presets": {
      const current = serializeHumanLook(look);
      return (
        <Section label="Partir d'un modèle" hint="Un modèle remplace tout le personnage ; chaque trait reste ensuite modifiable.">
          <OptionTiles
            options={HUMAN_PRESETS.map((p) => ({ value: p.name, label: p.name, url: serializeHumanLook(p.look) }))}
            value={HUMAN_PRESETS.find((p) => serializeHumanLook(p.look) === current)?.name ?? ""}
            onChange={(name) => {
              const preset = HUMAN_PRESETS.find((p) => p.name === name);
              if (preset) apply(preset.look);
            }}
            seed={seed}
            size={BUST}
          />
        </Section>
      );
    }
    case "face":
      return (
        <>
          <Section label="Peau">{colours("skin", SKIN_TONES)}</Section>
          <Section label="Forme du visage">{tiles("face", FACE_SHAPES, HEAD)}</Section>
          <Section label="Yeux">
            {tiles("eyeStyle", EYE_STYLES, HEAD)}
            <div className="mt-2.5">{colours("eyes", EYE_COLOURS)}</div>
          </Section>
          <Section label="Sourcils" hint="Ils prennent la couleur des cheveux.">{tiles("brows", BROWS, HEAD)}</Section>
          <Section label="Expression" hint="Au travail il se concentre, endormi il somnole, et il rit quand on le salue.">
            {tiles("mouth", MOUTHS, HEAD)}
          </Section>
          <div className="grid gap-1.5 sm:grid-cols-2">
            <SoftToggle label="Joues rosées" checked={resolved.blush} onChange={(v) => set("blush", v)} />
            <SoftToggle label="Taches de rousseur" checked={resolved.freckles} onChange={(v) => set("freckles", v)} />
          </div>
        </>
      );
    case "hair":
      return (
        <>
          <Section label="Couleur">{colours("hairColor", HAIR_COLOURS)}</Section>
          <Section label="Coupe">{tiles("hair", HAIR_STYLES, HEAD)}</Section>
          <Section label="Barbe" hint="Elle prend la couleur des cheveux.">{tiles("beard", BEARDS, HEAD)}</Section>
        </>
      );
    case "outfit":
      return (
        <>
          <Section label="Couleur">{colours("outfitColor", OUTFIT_COLOURS)}</Section>
          <Section label="Haut">{tiles("outfit", OUTFITS, BUST)}</Section>
          <Section
            label="Détails"
            hint="La cravate, le t-shirt sous la veste, les cordons du sweat, le col de la chemise, l'écharpe, le cordon du badge, les élastiques des cheveux."
          >
            {colours("accentColor", ACCENT_COLOURS)}
          </Section>
          <Section label="Au cou">{tiles("neckwear", NECKWEAR, BUST)}</Section>
          <Section label="Carrure">{tiles("build", BUILDS, BUST)}</Section>
        </>
      );
    case "wear":
      return (
        <>
          <Section label="Lunettes">{tiles("glasses", HUMAN_GLASSES, HEAD)}</Section>
          <Section label="Couvre-chef">{tiles("headwear", HEADWEAR, HEAD)}</Section>
          <div className="grid gap-1.5 sm:grid-cols-2">
            <SoftToggle label="Casque audio" checked={resolved.headphones} onChange={(v) => set("headphones", v)} />
            <SoftToggle label="Boucles d'oreilles" checked={resolved.earrings} onChange={(v) => set("earrings", v)} />
          </div>
          <Section label="Couleur des accessoires" hint="La monture, le bonnet, la casquette, le béret et le casque.">
            {colours("accessoryColor", ACCESSORY_COLOURS)}
          </Section>
        </>
      );
    case "material":
      return (
        <Section label="Matière" hint="Argile : mat et doux. Vinyle : une figurine laquée. Cartoon : des aplats dessinés.">
          {tiles("material", HUMAN_MATERIALS, BUST)}
        </Section>
      );
    case "motion":
      return (
        <Section
          label="Mouvements"
          hint="Il respire, cligne des yeux, regarde autour de lui et suit le pointeur ; il salue de temps en temps et quand on clique dessus. « Au travail », il tape sur son ordinateur ; « Endormi », il somnole."
        >
          <LookSlider
            spec={{ label: "Vitesse", unit: "×", ...SPEED_RANGE }}
            value={look.speed}
            def={1}
            onChange={(v) => set("speed", v)}
          />
        </Section>
      );
  }
}
