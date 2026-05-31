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
    | "tech"
    | "premium";
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

  /* ==================== PREMIUM ==================== */
  {
    id: "premium-glass",
    name: "Glassmorphism",
    category: "premium",
    defaultColors: { c1: "#7C3AED", c2: "#06B6D4", c3: "#FFFFFF", c4: "#1E1B26" },
    render: (c) => `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${c.c1}"/><stop offset="100%" stop-color="${c.c2}"/>
        </linearGradient>
        <filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="40"/></filter>
      </defs>
      <rect width="100%" height="100%" fill="${c.c4 ?? "#1E1B26"}"/>
      <g filter="url(#b)" opacity="0.85">
        <circle cx="20%" cy="30%" r="22%" fill="${c.c1}"/>
        <circle cx="78%" cy="65%" r="26%" fill="${c.c2}"/>
      </g>
      <rect x="10%" y="55%" width="80%" height="35%" rx="20" fill="${c.c3 ?? "#fff"}" fill-opacity="0.1" stroke="${c.c3 ?? "#fff"}" stroke-opacity="0.18" stroke-width="1.5"/>
      <rect x="10%" y="55%" width="80%" height="35%" rx="20" fill="url(#g)" fill-opacity="0.05"/>`,
  },
  {
    id: "premium-holographic",
    name: "Holographic",
    category: "premium",
    defaultColors: { c1: "#FF6EC7", c2: "#7873F5", c3: "#4ADE80", c4: "#000000" },
    render: (c) => `
      <defs>
        <linearGradient id="h" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${c.c1}"/>
          <stop offset="33%" stop-color="${c.c2}"/>
          <stop offset="66%" stop-color="${c.c3 ?? c.c2}"/>
          <stop offset="100%" stop-color="${c.c1}"/>
        </linearGradient>
        <filter id="b"><feGaussianBlur stdDeviation="80"/></filter>
      </defs>
      <rect width="100%" height="100%" fill="${c.c4 ?? "#000"}"/>
      <g filter="url(#b)" opacity="0.85">
        <rect width="100%" height="100%" fill="url(#h)"/>
      </g>
      <rect width="100%" height="100%" fill="url(#h)" fill-opacity="0.15"/>`,
  },
  {
    id: "premium-frosted",
    name: "Frosted glass",
    category: "premium",
    defaultColors: { c1: "#3B82F6", c2: "#EC4899", c3: "#FFFFFF", c4: "#0F172A" },
    render: (c) => `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${c.c1}"/><stop offset="100%" stop-color="${c.c2}"/>
        </linearGradient>
        <filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="80"/></filter>
      </defs>
      <rect width="100%" height="100%" fill="${c.c4 ?? "#0F172A"}"/>
      <g filter="url(#b)" opacity="0.8">
        <ellipse cx="30%" cy="40%" rx="35%" ry="30%" fill="${c.c1}"/>
        <ellipse cx="70%" cy="70%" rx="40%" ry="35%" fill="${c.c2}"/>
      </g>
      <rect width="100%" height="100%" fill="${c.c3 ?? "#fff"}" fill-opacity="0.04"/>`,
  },
  {
    id: "premium-neon-glow",
    name: "Neon glow",
    category: "premium",
    defaultColors: { c1: "#06B6D4", c2: "#F472B6", c3: "#FACC15", c4: "#020617" },
    render: (c) => `
      <defs>
        <filter id="b"><feGaussianBlur stdDeviation="30"/></filter>
      </defs>
      <rect width="100%" height="100%" fill="${c.c4 ?? "#020617"}"/>
      <g filter="url(#b)" opacity="0.9">
        <rect x="10%" y="20%" width="80%" height="3" fill="${c.c1}"/>
        <rect x="20%" y="40%" width="60%" height="3" fill="${c.c2}"/>
        <rect x="15%" y="60%" width="70%" height="3" fill="${c.c3 ?? c.c2}"/>
      </g>
      <rect x="10%" y="20%" width="80%" height="1" fill="${c.c1}"/>
      <rect x="20%" y="40%" width="60%" height="1" fill="${c.c2}"/>
      <rect x="15%" y="60%" width="70%" height="1" fill="${c.c3 ?? c.c2}"/>`,
  },
  {
    id: "premium-isometric",
    name: "Isometric grid",
    category: "premium",
    defaultColors: { c1: "#1E1B4B", c2: "#312E81", c3: "#A78BFA", c4: "#0F0E2A" },
    render: (c) => `
      <defs>
        <pattern id="p" width="60" height="104" patternUnits="userSpaceOnUse">
          <path d="M0 0 L30 52 L60 0 M0 104 L30 52 L60 104" stroke="${c.c3 ?? "#A78BFA"}" stroke-opacity="0.18" stroke-width="1" fill="none"/>
        </pattern>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${c.c1}"/><stop offset="100%" stop-color="${c.c2}"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <rect width="100%" height="100%" fill="url(#p)"/>`,
  },
  {
    id: "premium-paper",
    name: "Premium paper",
    category: "premium",
    defaultColors: { c1: "#FAF7F2", c2: "#E8E2D8", c3: "#1F1B16", c4: "#FAF7F2" },
    render: (c) => `
      <defs>
        <radialGradient id="g" cx="50%" cy="40%" r="80%">
          <stop offset="0%" stop-color="${c.c1}"/><stop offset="100%" stop-color="${c.c2}"/>
        </radialGradient>
        <filter id="n">
          <feTurbulence baseFrequency="0.85" numOctaves="2"/>
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.05 0"/>
        </filter>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <rect width="100%" height="100%" filter="url(#n)"/>
      <rect x="3%" y="3%" width="94%" height="94%" fill="none" stroke="${c.c3 ?? "#1F1B16"}" stroke-opacity="0.12" stroke-width="2"/>`,
  },
  {
    id: "premium-magazine",
    name: "Magazine layout",
    category: "premium",
    defaultColors: { c1: "#000000", c2: "#EF4444", c3: "#FFFFFF", c4: "#1A1A1A" },
    render: (c) => `
      <rect width="100%" height="100%" fill="${c.c1}"/>
      <rect x="0" y="0" width="40%" height="100%" fill="${c.c2}"/>
      <line x1="40%" y1="0" x2="40%" y2="100%" stroke="${c.c3 ?? "#fff"}" stroke-width="2"/>
      <rect x="42%" y="10%" width="3" height="80%" fill="${c.c3 ?? "#fff"}" opacity="0.3"/>
      <rect x="48%" y="10%" width="3" height="80%" fill="${c.c3 ?? "#fff"}" opacity="0.15"/>`,
  },
  {
    id: "premium-watercolor",
    name: "Watercolor",
    category: "premium",
    defaultColors: { c1: "#FDA4AF", c2: "#FBCFE8", c3: "#A5F3FC", c4: "#FFF1F2" },
    render: (c) => `
      <defs>
        <filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="50"/></filter>
        <filter id="n"><feTurbulence baseFrequency="0.6" numOctaves="3"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.03 0"/></filter>
      </defs>
      <rect width="100%" height="100%" fill="${c.c4 ?? "#FFF1F2"}"/>
      <g filter="url(#b)" opacity="0.6">
        <circle cx="25%" cy="35%" r="30%" fill="${c.c1}"/>
        <circle cx="75%" cy="55%" r="35%" fill="${c.c2}"/>
        <circle cx="50%" cy="80%" r="25%" fill="${c.c3 ?? c.c1}"/>
      </g>
      <rect width="100%" height="100%" filter="url(#n)"/>`,
  },
  {
    id: "premium-retro-80s",
    name: "Retro 80s",
    category: "premium",
    defaultColors: { c1: "#FF006E", c2: "#8338EC", c3: "#3A86FF", c4: "#000010" },
    render: (c) => `
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${c.c4 ?? "#000010"}"/>
          <stop offset="60%" stop-color="${c.c2}"/>
          <stop offset="100%" stop-color="${c.c1}"/>
        </linearGradient>
        <linearGradient id="grid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${c.c3 ?? c.c1}" stop-opacity="0"/>
          <stop offset="100%" stop-color="${c.c3 ?? c.c1}" stop-opacity="0.6"/>
        </linearGradient>
        <pattern id="gp" width="80" height="60" patternUnits="userSpaceOnUse">
          <path d="M0 60 L40 0 L80 60" stroke="${c.c3 ?? c.c1}" stroke-opacity="0.4" stroke-width="1" fill="none"/>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#sky)"/>
      <circle cx="50%" cy="55%" r="18%" fill="${c.c2}"/>
      <rect x="0" y="60%" width="100%" height="40%" fill="url(#gp)"/>
      <rect x="0" y="60%" width="100%" height="40%" fill="url(#grid)"/>`,
  },
  {
    id: "premium-bauhaus",
    name: "Bauhaus",
    category: "premium",
    defaultColors: { c1: "#E63946", c2: "#F1C40F", c3: "#3498DB", c4: "#FCFAF4" },
    render: (c) => `
      <rect width="100%" height="100%" fill="${c.c4 ?? "#FCFAF4"}"/>
      <circle cx="25%" cy="30%" r="20%" fill="${c.c1}"/>
      <rect x="55%" y="20%" width="30%" height="30%" fill="${c.c3 ?? c.c1}"/>
      <polygon points="20%,70% 50%,70% 35%,95%" fill="${c.c2}"/>
      <line x1="0" y1="50%" x2="100%" y2="50%" stroke="${c.c1}" stroke-width="2"/>
      <line x1="50%" y1="0" x2="50%" y2="100%" stroke="${c.c1}" stroke-width="2"/>`,
  },
  {
    id: "premium-brutalist",
    name: "Brutalist blocks",
    category: "premium",
    defaultColors: { c1: "#000000", c2: "#FFD60A", c3: "#FFFFFF", c4: "#0A0A0A" },
    render: (c) => `
      <rect width="100%" height="100%" fill="${c.c4 ?? "#0A0A0A"}"/>
      <rect x="-2%" y="40%" width="105%" height="40%" fill="${c.c2}"/>
      <rect x="0" y="35%" width="100%" height="2" fill="${c.c3 ?? "#fff"}"/>
      <rect x="0" y="85%" width="100%" height="2" fill="${c.c3 ?? "#fff"}"/>
      <rect x="10%" y="10%" width="40%" height="22%" fill="${c.c1}" stroke="${c.c2}" stroke-width="3"/>
      <rect x="55%" y="60%" width="35%" height="18%" fill="${c.c1}" stroke="${c.c3 ?? "#fff"}" stroke-width="3"/>`,
  },
  {
    id: "premium-photo-tint",
    name: "Photo tint",
    category: "premium",
    defaultColors: { c1: "#0F172A", c2: "#1E293B", c3: "#06B6D4", c4: "#020617" },
    render: (c) => `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${c.c1}" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="${c.c2}"/>
        </linearGradient>
        <radialGradient id="vignette" cx="50%" cy="50%" r="70%">
          <stop offset="60%" stop-color="${c.c1}" stop-opacity="0"/>
          <stop offset="100%" stop-color="${c.c4 ?? "#000"}"/>
        </radialGradient>
        <filter id="b"><feGaussianBlur stdDeviation="60"/></filter>
      </defs>
      <rect width="100%" height="100%" fill="${c.c1}"/>
      <g filter="url(#b)" opacity="0.6">
        <circle cx="70%" cy="30%" r="25%" fill="${c.c3 ?? c.c2}"/>
      </g>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <rect width="100%" height="100%" fill="url(#vignette)"/>`,
  },
  {
    id: "premium-scribble",
    name: "Scribble layer",
    category: "premium",
    defaultColors: { c1: "#FDE68A", c2: "#000000", c3: "#EC4899", c4: "#FDE68A" },
    render: (c) => `
      <rect width="100%" height="100%" fill="${c.c1}"/>
      <g stroke="${c.c2}" stroke-width="2" fill="none" stroke-linecap="round">
        <path d="M 50 80 Q 120 60 180 100 T 320 90"/>
        <path d="M 380 130 Q 450 100 520 140 T 700 130"/>
        <circle cx="450" cy="80" r="20" stroke-dasharray="5 5"/>
        <path d="M 100 200 L 180 220 L 160 280"/>
      </g>
      <g stroke="${c.c3 ?? c.c1}" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.85">
        <path d="M 600 60 L 650 110 L 700 80"/>
        <path d="M 80 350 Q 200 380 320 340"/>
      </g>`,
  },
  {
    id: "premium-dotted-sphere",
    name: "Dotted sphere",
    category: "premium",
    defaultColors: { c1: "#0F172A", c2: "#1E40AF", c3: "#FBBF24", c4: "#020617" },
    render: (c) => `
      <defs>
        <radialGradient id="g" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stop-color="${c.c2}"/><stop offset="100%" stop-color="${c.c4 ?? c.c1}"/>
        </radialGradient>
        <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="10" cy="10" r="1" fill="${c.c3 ?? "#FBBF24"}" opacity="0.7"/>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <circle cx="70%" cy="35%" r="25%" fill="url(#dots)"/>
      <circle cx="70%" cy="35%" r="25%" fill="none" stroke="${c.c3 ?? "#FBBF24"}" stroke-opacity="0.3" stroke-width="1"/>`,
  },
  {
    id: "premium-spotlight",
    name: "Spotlight",
    category: "premium",
    defaultColors: { c1: "#FFFFFF", c2: "#FBBF24", c3: "#0F172A", c4: "#000000" },
    render: (c) => `
      <defs>
        <radialGradient id="g" cx="30%" cy="30%" r="50%">
          <stop offset="0%" stop-color="${c.c1}"/>
          <stop offset="40%" stop-color="${c.c2}" stop-opacity="0.6"/>
          <stop offset="100%" stop-color="${c.c4 ?? "#000"}" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="${c.c3 ?? c.c4 ?? "#0F172A"}"/>
      <rect width="100%" height="100%" fill="url(#g)"/>`,
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

export const PALETTES_EXPORT = PALETTES;

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
