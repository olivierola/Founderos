/* The closing call to action now lives in the footer itself (hn/HnFooter: the
   white card on the sky band), so every page ends the same way. This used to
   render a separate "Get started" section above the footer; it renders
   nothing now and is kept so the pages that mount it do not have to change. */
export function LandingClose() {
  return null;
}
