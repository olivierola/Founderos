import type { ReactNode } from "react";
import { HnHero } from "./hn/HnPage";

/* ══ The opening, for every interior page ════════════════════════════════════
   Every page used to open through this. The site now wears the Hunar register
   (see hn/), and this keeps the old call signature so the pages did not have
   to learn a new address: `frame` and `claim` join into one title, `label`
   becomes the blue eyebrow, and `align` picks the opening —

     center → eyebrow, title, line and button centred (as a product page);
     left / plain → a big title and its line on the off-white ground.

   `tiles`, `fill`, `size` and `tail` are accepted and ignored. */

export const PAPER_FRAME = "#4b5567";
export const PAPER_INK = "#0b1220";
export { PAPER_ACCENT } from "./PaperKit";

const TILE_KEYS = ["secure", "adopt", "scale", "foundation"] as const;
export type TileKey = (typeof TILE_KEYS)[number];
export const PAIR: TileKey[] = ["secure", "foundation"];
export const ALL_TILES: TileKey[] = [...TILE_KEYS];

/** The register marks went with an earlier register. Kept as a no-op so the
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
  plain?: boolean;
}) {
  const title = [...frame, claim].filter(Boolean).join(" ");
  return (
    <HnHero
      eyebrow={label}
      title={title}
      lead={lead}
      note={note}
      variant={plain || align === "left" ? "title" : "center"}
    >
      {children}
    </HnHero>
  );
}
