/* Google Fonts catalogue used by the visual generator. The marketing dialog
 * injects a single <link> tag per font when the user picks one (we don't
 * preload all 30 to avoid 1MB of CSS on first paint). */

export interface FontDef {
  /** CSS family — what goes in `font-family`. */
  family: string;
  /** URL-safe param for Google Fonts. */
  googleParam?: string;
  /** Optional alternate (system) fallback family. */
  fallback: string;
  /** UI category for grouping in the dropdown. */
  category: "sans" | "serif" | "display" | "mono" | "handwriting";
  /** Weights available in our embed query (kept lean for speed). */
  weights?: string;
}

export const FONTS: FontDef[] = [
  // System defaults (no Google Fonts fetch needed)
  { family: "system-ui", googleParam: undefined, fallback: "-apple-system, BlinkMacSystemFont, sans-serif", category: "sans" },
  { family: "Georgia", googleParam: undefined, fallback: "serif", category: "serif" },
  { family: "Impact", googleParam: undefined, fallback: "Arial Black, sans-serif", category: "display" },

  // Sans-serif
  { family: "Inter", googleParam: "Inter:wght@400;600;800", fallback: "sans-serif", category: "sans", weights: "400;600;800" },
  { family: "Poppins", googleParam: "Poppins:wght@400;600;800", fallback: "sans-serif", category: "sans" },
  { family: "Montserrat", googleParam: "Montserrat:wght@400;600;800", fallback: "sans-serif", category: "sans" },
  { family: "Manrope", googleParam: "Manrope:wght@400;600;800", fallback: "sans-serif", category: "sans" },
  { family: "DM Sans", googleParam: "DM+Sans:wght@400;500;700", fallback: "sans-serif", category: "sans" },
  { family: "Plus Jakarta Sans", googleParam: "Plus+Jakarta+Sans:wght@400;600;800", fallback: "sans-serif", category: "sans" },
  { family: "Outfit", googleParam: "Outfit:wght@400;600;800", fallback: "sans-serif", category: "sans" },
  { family: "Space Grotesk", googleParam: "Space+Grotesk:wght@400;500;700", fallback: "sans-serif", category: "sans" },
  { family: "Sora", googleParam: "Sora:wght@400;600;800", fallback: "sans-serif", category: "sans" },
  { family: "Work Sans", googleParam: "Work+Sans:wght@400;600;800", fallback: "sans-serif", category: "sans" },

  // Serif
  { family: "Playfair Display", googleParam: "Playfair+Display:wght@400;700;900", fallback: "serif", category: "serif" },
  { family: "Cormorant Garamond", googleParam: "Cormorant+Garamond:wght@400;600;700", fallback: "serif", category: "serif" },
  { family: "Lora", googleParam: "Lora:wght@400;600;700", fallback: "serif", category: "serif" },
  { family: "Source Serif Pro", googleParam: "Source+Serif+Pro:wght@400;600;900", fallback: "serif", category: "serif" },
  { family: "Crimson Pro", googleParam: "Crimson+Pro:wght@400;600;700", fallback: "serif", category: "serif" },
  { family: "Merriweather", googleParam: "Merriweather:wght@400;700;900", fallback: "serif", category: "serif" },

  // Display / heavy
  { family: "Anton", googleParam: "Anton", fallback: "Impact, sans-serif", category: "display" },
  { family: "Bebas Neue", googleParam: "Bebas+Neue", fallback: "Impact, sans-serif", category: "display" },
  { family: "Archivo Black", googleParam: "Archivo+Black", fallback: "Impact, sans-serif", category: "display" },
  { family: "Bowlby One", googleParam: "Bowlby+One", fallback: "sans-serif", category: "display" },
  { family: "Black Ops One", googleParam: "Black+Ops+One", fallback: "Impact, sans-serif", category: "display" },
  { family: "Press Start 2P", googleParam: "Press+Start+2P", fallback: "monospace", category: "display" },
  { family: "Righteous", googleParam: "Righteous", fallback: "sans-serif", category: "display" },
  { family: "Russo One", googleParam: "Russo+One", fallback: "sans-serif", category: "display" },

  // Handwriting / script
  { family: "Caveat", googleParam: "Caveat:wght@400;700", fallback: "cursive", category: "handwriting" },
  { family: "Dancing Script", googleParam: "Dancing+Script:wght@400;700", fallback: "cursive", category: "handwriting" },
  { family: "Pacifico", googleParam: "Pacifico", fallback: "cursive", category: "handwriting" },
  { family: "Permanent Marker", googleParam: "Permanent+Marker", fallback: "cursive", category: "handwriting" },
  { family: "Shadows Into Light", googleParam: "Shadows+Into+Light", fallback: "cursive", category: "handwriting" },

  // Monospace
  { family: "JetBrains Mono", googleParam: "JetBrains+Mono:wght@400;700", fallback: "monospace", category: "mono" },
  { family: "Space Mono", googleParam: "Space+Mono:wght@400;700", fallback: "monospace", category: "mono" },
  { family: "IBM Plex Mono", googleParam: "IBM+Plex+Mono:wght@400;600;700", fallback: "monospace", category: "mono" },
  { family: "Fira Code", googleParam: "Fira+Code:wght@400;600;700", fallback: "monospace", category: "mono" },
];

/** Build a CSS font-family value with fallback. */
export function familyCss(family: string): string {
  const f = FONTS.find((x) => x.family === family);
  if (!f) return family;
  return `"${f.family}", ${f.fallback}`;
}

/** Inject the Google Fonts <link> for a family on demand (idempotent). */
const loaded = new Set<string>();
export function ensureFontLoaded(family: string) {
  if (typeof document === "undefined") return;
  const f = FONTS.find((x) => x.family === family);
  if (!f || !f.googleParam || loaded.has(family)) return;
  loaded.add(family);

  // Use the /css2 endpoint with display=swap so the font shows up as soon as
  // it downloads instead of blocking text rendering.
  const href = `https://fonts.googleapis.com/css2?family=${f.googleParam}&display=swap`;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.fosFont = family;
  document.head.appendChild(link);
}

/** Preload every font as a low-priority hint so the dropdown previews
 *  appear in their real face. We use one <link> per family with
 *  rel=stylesheet so the browser downloads them when idle. */
export function preloadAllFonts() {
  FONTS.forEach((f) => ensureFontLoaded(f.family));
}
