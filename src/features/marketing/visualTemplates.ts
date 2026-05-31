/* SVG background templates for the Content Studio visual generator.
 * Each template renders a 0..1 normalized SVG that the editor scales to the
 * canvas size. Colors are parameterised so the user can recolor any palette. */

export interface TemplateColors {
  c1: string;
  c2: string;
  c3?: string;
  c4?: string;
}

export interface TemplateDef {
  id: string;
  name: string;
  category:
    | "gradient"
    | "mesh"
    | "geometric"
    | "minimal"
    | "abstract"
    | "vintage"
    | "tech";
  /** Default palette — the editor lets the user override every color. */
  defaultColors: TemplateColors;
  /** Render the background as SVG markup. Use percentages so any aspect ratio works. */
  render: (c: TemplateColors) => string;
}

const PALETTES: TemplateColors[] = [
  { c1: "#001BB7", c2: "#7C3AED", c3: "#EC4899", c4: "#0F172A" },
  { c1: "#0EA5E9", c2: "#06B6D4", c3: "#14B8A6", c4: "#0B132B" },
  { c1: "#F59E0B", c2: "#EF4444", c3: "#EC4899", c4: "#1E1B18" },
  { c1: "#10B981", c2: "#0D9488", c3: "#0EA5E9", c4: "#052E2A" },
  { c1: "#A855F7", c2: "#EC4899", c3: "#F59E0B", c4: "#1E1B26" },
  { c1: "#1F2937", c2: "#374151", c3: "#6B7280", c4: "#0A0A0A" },
];

/* ============================================================ */
/*  Templates                                                   */
/* ============================================================ */

export const VISUAL_TEMPLATES: TemplateDef[] = [
  /* -- Plain gradients -- */
  {
    id: "linear-soft",
    name: "Linear soft",
    category: "gradient",
    defaultColors: PALETTES[0],
    render: (c) => `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${c.c1}"/>
          <stop offset="100%" stop-color="${c.c2}"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>`,
  },
  {
    id: "linear-vertical",
    name: "Vertical fade",
    category: "gradient",
    defaultColors: PALETTES[3],
    render: (c) => `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${c.c1}"/>
          <stop offset="50%" stop-color="${c.c2}"/>
          <stop offset="100%" stop-color="${c.c3 ?? c.c2}"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>`,
  },
  {
    id: "radial-glow",
    name: "Radial glow",
    category: "gradient",
    defaultColors: PALETTES[4],
    render: (c) => `
      <defs>
        <radialGradient id="g" cx="30%" cy="30%" r="80%">
          <stop offset="0%" stop-color="${c.c1}"/>
          <stop offset="60%" stop-color="${c.c2}"/>
          <stop offset="100%" stop-color="${c.c4 ?? "#000"}"/>
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>`,
  },
  {
    id: "conic-burst",
    name: "Conic burst",
    category: "gradient",
    defaultColors: PALETTES[2],
    render: (c) => `
      <defs>
        <radialGradient id="g1" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stop-color="${c.c1}"/>
          <stop offset="100%" stop-color="${c.c4 ?? "#0a0a0a"}"/>
        </radialGradient>
        <radialGradient id="g2" cx="80%" cy="20%" r="60%">
          <stop offset="0%" stop-color="${c.c2}" stop-opacity="0.8"/>
          <stop offset="100%" stop-color="${c.c2}" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="g3" cx="20%" cy="80%" r="50%">
          <stop offset="0%" stop-color="${c.c3 ?? c.c1}" stop-opacity="0.7"/>
          <stop offset="100%" stop-color="${c.c3 ?? c.c1}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g1)"/>
      <rect width="100%" height="100%" fill="url(#g2)"/>
      <rect width="100%" height="100%" fill="url(#g3)"/>`,
  },

  /* -- Mesh gradients (multi-blob composition) -- */
  {
    id: "mesh-blobs",
    name: "Mesh blobs",
    category: "mesh",
    defaultColors: PALETTES[4],
    render: (c) => `
      <defs>
        <filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="120"/></filter>
      </defs>
      <rect width="100%" height="100%" fill="${c.c4 ?? "#0a0a0a"}"/>
      <g filter="url(#b)">
        <circle cx="25%" cy="30%" r="35%" fill="${c.c1}"/>
        <circle cx="75%" cy="65%" r="40%" fill="${c.c2}"/>
        <circle cx="50%" cy="80%" r="30%" fill="${c.c3 ?? c.c1}" opacity="0.85"/>
        <circle cx="85%" cy="15%" r="20%" fill="${c.c2}" opacity="0.7"/>
      </g>`,
  },
  {
    id: "mesh-aurora",
    name: "Aurora mesh",
    category: "mesh",
    defaultColors: PALETTES[3],
    render: (c) => `
      <defs>
        <filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="100"/></filter>
      </defs>
      <rect width="100%" height="100%" fill="${c.c4 ?? "#020617"}"/>
      <g filter="url(#b)" opacity="0.9">
        <ellipse cx="20%" cy="100%" rx="50%" ry="20%" fill="${c.c1}"/>
        <ellipse cx="80%" cy="100%" rx="55%" ry="25%" fill="${c.c2}"/>
        <ellipse cx="50%" cy="100%" rx="40%" ry="30%" fill="${c.c3 ?? c.c2}"/>
      </g>`,
  },
  {
    id: "mesh-soft-pink",
    name: "Cotton candy",
    category: "mesh",
    defaultColors: { c1: "#fecaca", c2: "#fbcfe8", c3: "#ddd6fe", c4: "#fafafa" },
    render: (c) => `
      <defs>
        <filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="140"/></filter>
      </defs>
      <rect width="100%" height="100%" fill="${c.c4 ?? "#fafafa"}"/>
      <g filter="url(#b)" opacity="0.92">
        <circle cx="20%" cy="20%" r="40%" fill="${c.c1}"/>
        <circle cx="80%" cy="20%" r="35%" fill="${c.c2}"/>
        <circle cx="50%" cy="80%" r="45%" fill="${c.c3 ?? c.c1}"/>
      </g>`,
  },

  /* -- Geometric -- */
  {
    id: "geo-circles",
    name: "Concentric rings",
    category: "geometric",
    defaultColors: PALETTES[1],
    render: (c) => `
      <rect width="100%" height="100%" fill="${c.c4 ?? "#0a0a0a"}"/>
      <g fill="none" stroke="${c.c1}" stroke-opacity="0.6">
        ${Array.from({ length: 14 })
          .map((_, i) => `<circle cx="80%" cy="20%" r="${(i + 1) * 80}" stroke-width="1.5"/>`)
          .join("")}
      </g>
      <circle cx="80%" cy="20%" r="60" fill="${c.c2}"/>`,
  },
  {
    id: "geo-stripes",
    name: "Diagonal stripes",
    category: "geometric",
    defaultColors: PALETTES[0],
    render: (c) => `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${c.c1}"/><stop offset="100%" stop-color="${c.c2}"/>
        </linearGradient>
        <pattern id="p" width="48" height="48" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="24" height="48" fill="${c.c3 ?? "#ffffff"}" fill-opacity="0.06"/>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <rect width="100%" height="100%" fill="url(#p)"/>`,
  },
  {
    id: "geo-triangles",
    name: "Triangle field",
    category: "geometric",
    defaultColors: PALETTES[2],
    render: (c) => `
      <rect width="100%" height="100%" fill="${c.c4 ?? "#0a0a0a"}"/>
      <g opacity="0.9">
        <polygon points="0,100 350,100 175,420" fill="${c.c1}"/>
        <polygon points="100%,0% 70%,0% 100%,40%" fill="${c.c2}"/>
        <polygon points="50%,70% 70%,100% 30%,100%" fill="${c.c3 ?? c.c1}" opacity="0.85"/>
      </g>`,
  },
  {
    id: "geo-grid-dots",
    name: "Dotted grid",
    category: "geometric",
    defaultColors: PALETTES[5],
    render: (c) => `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${c.c1}"/><stop offset="100%" stop-color="${c.c2}"/>
        </linearGradient>
        <pattern id="p" width="32" height="32" patternUnits="userSpaceOnUse">
          <circle cx="16" cy="16" r="1.5" fill="${c.c3 ?? "#ffffff"}" fill-opacity="0.35"/>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <rect width="100%" height="100%" fill="url(#p)"/>`,
  },
  {
    id: "geo-grid-lines",
    name: "Wire grid",
    category: "tech",
    defaultColors: { c1: "#0F172A", c2: "#1E293B", c3: "#38bdf8", c4: "#0a0a0a" },
    render: (c) => `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${c.c1}"/><stop offset="100%" stop-color="${c.c2}"/>
        </linearGradient>
        <pattern id="p" width="60" height="60" patternUnits="userSpaceOnUse">
          <path d="M 60 0 L 0 0 0 60" fill="none" stroke="${c.c3 ?? "#38bdf8"}" stroke-opacity="0.18" stroke-width="0.7"/>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <rect width="100%" height="100%" fill="url(#p)"/>`,
  },

  /* -- Minimal -- */
  {
    id: "minimal-split",
    name: "Bold split",
    category: "minimal",
    defaultColors: PALETTES[0],
    render: (c) => `
      <rect width="100%" height="100%" fill="${c.c1}"/>
      <rect x="0" y="60%" width="100%" height="40%" fill="${c.c2}"/>
      <rect x="0" y="58%" width="100%" height="6" fill="${c.c3 ?? "#ffffff"}" opacity="0.7"/>`,
  },
  {
    id: "minimal-block",
    name: "Centered block",
    category: "minimal",
    defaultColors: PALETTES[5],
    render: (c) => `
      <rect width="100%" height="100%" fill="${c.c1}"/>
      <rect x="8%" y="8%" width="84%" height="84%" fill="${c.c2}" opacity="0.3"/>
      <rect x="10%" y="10%" width="80%" height="80%" fill="none" stroke="${c.c3 ?? "#ffffff"}" stroke-opacity="0.5" stroke-width="2"/>`,
  },

  /* -- Abstract / decorative -- */
  {
    id: "abstract-waves",
    name: "Soft waves",
    category: "abstract",
    defaultColors: PALETTES[1],
    render: (c) => `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${c.c1}"/><stop offset="100%" stop-color="${c.c2}"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <path d="M0 70% Q 25% 50%, 50% 65% T 100% 60% L 100% 100% L 0 100% Z" fill="${c.c3 ?? "#ffffff"}" opacity="0.15"/>
      <path d="M0 80% Q 25% 65%, 50% 80% T 100% 75% L 100% 100% L 0 100% Z" fill="${c.c3 ?? "#ffffff"}" opacity="0.25"/>`,
  },
  {
    id: "abstract-blob",
    name: "Organic blob",
    category: "abstract",
    defaultColors: PALETTES[4],
    render: (c) => `
      <rect width="100%" height="100%" fill="${c.c4 ?? "#0a0a0a"}"/>
      <defs>
        <filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="50"/></filter>
      </defs>
      <g filter="url(#b)">
        <path d="M 200 100 Q 400 50 600 200 T 900 400 T 700 700 T 300 600 T 100 300 Z" fill="${c.c1}"/>
        <path d="M 700 200 Q 900 350 800 600 T 500 750 T 200 500 Z" fill="${c.c2}" opacity="0.7"/>
      </g>`,
  },

  /* -- Vintage / decorative -- */
  {
    id: "vintage-paper",
    name: "Vintage paper",
    category: "vintage",
    defaultColors: { c1: "#fef3c7", c2: "#d97706", c3: "#7c2d12", c4: "#fef9e7" },
    render: (c) => `
      <defs>
        <radialGradient id="g" cx="50%" cy="50%" r="80%">
          <stop offset="0%" stop-color="${c.c1}"/>
          <stop offset="100%" stop-color="${c.c2}" stop-opacity="0.5"/>
        </radialGradient>
        <filter id="n">
          <feTurbulence baseFrequency="0.9" numOctaves="2"/>
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.06 0"/>
        </filter>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <rect width="100%" height="100%" filter="url(#n)"/>`,
  },
  {
    id: "vintage-retro-sun",
    name: "Retro sunset",
    category: "vintage",
    defaultColors: { c1: "#fb923c", c2: "#f43f5e", c3: "#a855f7", c4: "#1e1b3a" },
    render: (c) => `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${c.c3 ?? c.c1}"/>
          <stop offset="55%" stop-color="${c.c2}"/>
          <stop offset="100%" stop-color="${c.c1}"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <circle cx="50%" cy="62%" r="22%" fill="${c.c1}" opacity="0.95"/>
      ${Array.from({ length: 5 })
        .map(
          (_, i) =>
            `<rect x="0" y="${72 + i * 5}%" width="100%" height="2" fill="${c.c4 ?? "#1e1b3a"}" opacity="${0.5 - i * 0.07}"/>`,
        )
        .join("")}`,
  },

  /* -- Tech / brutalist -- */
  {
    id: "tech-noise",
    name: "Noise overlay",
    category: "tech",
    defaultColors: PALETTES[5],
    render: (c) => `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${c.c1}"/><stop offset="100%" stop-color="${c.c2}"/>
        </linearGradient>
        <filter id="n"><feTurbulence baseFrequency="1.2" numOctaves="2"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.1 0"/></filter>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <rect width="100%" height="100%" filter="url(#n)"/>`,
  },
  {
    id: "tech-circuit",
    name: "Circuit lines",
    category: "tech",
    defaultColors: { c1: "#020617", c2: "#0f172a", c3: "#38bdf8", c4: "#020617" },
    render: (c) => `
      <defs>
        <pattern id="p" width="120" height="120" patternUnits="userSpaceOnUse">
          <path d="M0 60 L60 60 L60 0 M60 60 L120 60 M60 60 L60 120" fill="none" stroke="${c.c3 ?? "#38bdf8"}" stroke-width="1" stroke-opacity="0.4"/>
          <circle cx="60" cy="60" r="3" fill="${c.c3 ?? "#38bdf8"}"/>
          <circle cx="120" cy="60" r="2" fill="${c.c3 ?? "#38bdf8"}" opacity="0.6"/>
          <circle cx="60" cy="120" r="2" fill="${c.c3 ?? "#38bdf8"}" opacity="0.6"/>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="${c.c1}"/>
      <rect width="100%" height="100%" fill="url(#p)"/>`,
  },
];

export const TEMPLATE_CATEGORIES = Array.from(
  new Set(VISUAL_TEMPLATES.map((t) => t.category)),
);

export interface CanvasFormat {
  id: string;
  label: string;
  width: number;
  height: number;
  aspect: string;
}

export const CANVAS_FORMATS: CanvasFormat[] = [
  { id: "x-post", label: "X / Twitter (1200×675)", width: 1200, height: 675, aspect: "16/9" },
  { id: "ig-square", label: "Instagram Square (1080×1080)", width: 1080, height: 1080, aspect: "1/1" },
  { id: "ig-story", label: "Instagram Story (1080×1920)", width: 1080, height: 1920, aspect: "9/16" },
  { id: "linkedin", label: "LinkedIn (1200×627)", width: 1200, height: 627, aspect: "192/100" },
  { id: "fb-cover", label: "Facebook Cover (1640×624)", width: 1640, height: 624, aspect: "410/156" },
  { id: "flyer-a4", label: "Flyer A4 (2480×3508)", width: 2480, height: 3508, aspect: "1/1.414" },
  { id: "youtube-thumb", label: "YouTube Thumb (1280×720)", width: 1280, height: 720, aspect: "16/9" },
  { id: "custom", label: "Custom", width: 1200, height: 800, aspect: "3/2" },
];

export const FONT_OPTIONS = [
  { value: "system-ui, -apple-system, sans-serif", label: "System" },
  { value: "Inter, sans-serif", label: "Inter" },
  { value: "Georgia, serif", label: "Georgia" },
  { value: "'Playfair Display', serif", label: "Playfair" },
  { value: "'Space Grotesk', sans-serif", label: "Space Grotesk" },
  { value: "'Courier New', monospace", label: "Mono" },
  { value: "Impact, 'Arial Black', sans-serif", label: "Impact" },
];
