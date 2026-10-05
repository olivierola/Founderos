import { HnFooter } from "./hn/HnFooter";

/* The marketing footer is the Hunar close now (see hn/HnFooter): the sky band
   with its CTA card, then the ruled footer. `band` was the ground the old slab
   floated on; it is accepted and ignored. */
export function LandingFooter(_: { band?: string }) {
  return <HnFooter />;
}
