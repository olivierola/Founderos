// AchiCorp mobile — premium dark design tokens.
// A deep, near-black cockpit with an electric-violet accent, layered surfaces and
// soft glows. Everything the UI needs (color, spacing, radius, type, shadow) lives
// here so screens stay consistent.

export const colors = {
  // Backdrop & layered surfaces (each step lighter, for depth).
  bg: "#08080a",
  bgElevated: "#0e0e12",
  surface: "#141418",
  surfaceAlt: "#1b1b21",
  surfaceHi: "#24242c",

  // Hairlines.
  border: "#26262e",
  borderStrong: "#33333d",

  // Text.
  text: "#f5f5f7",
  muted: "#a3a3ad",
  faint: "#6e6e78",

  // Brand — electric violet with an indigo partner for gradients.
  primary: "#8b5cf6",
  primaryBright: "#a78bfa",
  primaryDeep: "#6d28d9",
  indigo: "#6366f1",
  primarySoft: "rgba(139,92,246,0.16)",
  primaryGlow: "rgba(139,92,246,0.35)",

  // Status.
  danger: "#f43f5e",
  dangerSoft: "rgba(244,63,94,0.14)",
  success: "#10b981",
  successSoft: "rgba(16,185,129,0.14)",
  warn: "#f59e0b",

  // On-accent text.
  onPrimary: "#ffffff",
};

// Two-stop gradients (pass to <Gradient> helper — we fake them without a native
// module by layering translucent surfaces / accent glows).
export const gradients = {
  brand: [colors.primary, colors.indigo] as const,
  brandDeep: [colors.primaryDeep, "#4f46e5"] as const,
};

export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
};

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 40,
};

export const font = {
  h1: 28,
  h2: 22,
  h3: 18,
  body: 15,
  small: 13,
  tiny: 11,
};

// Reusable elevation presets (iOS shadow + Android elevation).
export const shadow = {
  card: {
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  glow: {
    shadowColor: colors.primary,
    shadowOpacity: 0.5,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
} as const;
