import { AtlasFooter } from "./atlas/AtlasFooter";

/* The marketing footer is the Atlas slab now (see atlas/AtlasFooter). `band`
   used to be the ground the old dark slab floated on; the Atlas footer paints
   its own white margin, so the prop is accepted and ignored. */
export function LandingFooter(_: { band?: string }) {
  return <AtlasFooter />;
}
