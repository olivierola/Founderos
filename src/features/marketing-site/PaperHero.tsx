import type { ReactNode } from "react";
import { SparkleIcon as Sparkle } from "@phosphor-icons/react";
import { AtlasPageHero } from "./atlas/AtlasPage";

/* ══ The opening, for every interior page ════════════════════════════════════
   Every page used to open through a paper hero — two greys of type with
   photographs scattered in the gutters. The site now wears the Atlas register
   (see atlas/), and this keeps the old call signature so the pages did not
   have to learn a new address: the grey `frame` lines become the heavy sans
   line, the `claim` becomes its serif italic answer, and the page chooses
   between the two Atlas openings through `align`:

     center → the violet pool with a dark heart, title in white;
     left   → eyebrow and a dark title straight on the paper, for pages that
              open onto a working block (the plans, a form).

   `tiles`, `fill` and `tail` are accepted and ignored — the collage and the
   typed line went with the paper register. With no `frame`, the claim is set
   in the sans alone. */

export const PAPER_FRAME = "#666666";
export const PAPER_INK = "#111011";
export { PAPER_ACCENT } from "./PaperKit";

const TILE_KEYS = ["secure", "adopt", "scale", "foundation"] as const;
export type TileKey = (typeof TILE_KEYS)[number];
export const PAIR: TileKey[] = ["secure", "foundation"];
export const ALL_TILES: TileKey[] = [...TILE_KEYS];

/** The register marks went with the paper register. Kept as a no-op so the
    pages that still mount it render nothing rather than break. */
export function RegisterMarks() {
  return null;
}

export function PaperHero({
  label,
  frame,
  claim,
  lead,
  note,
  children,
  align = "center",
  plain = false,
}: {
  label?: string;
  frame: string[];
  claim: string;
  tail?: string[];
  lead?: ReactNode;
  note?: ReactNode;
  children?: ReactNode;
  tiles?: TileKey[];
  size?: "landing" | "page";
  fill?: boolean;
  align?: "center" | "left";
  /** The plain opening even when centred — dark title on paper. */
  plain?: boolean;
}) {
  const sans = frame.join(" ");
  const hasFrame = sans.length > 0;
  return (
    <AtlasPageHero
      icon={label ? Sparkle : undefined}
      eyebrow={label}
      lead={hasFrame ? sans : claim}
      serif={hasFrame ? claim : undefined}
      description={lead}
      note={note}
      variant={plain || align === "left" ? "plain" : "glow"}
      align={align}
    >
      {children}
    </AtlasPageHero>
  );
}
