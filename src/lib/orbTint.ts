// The agent orb ships as one image/scene with a coppery native tint
// (hue ≈ 30°). CSS `hue-rotate` rotates the existing hue, so to tint the orb
// toward a target colour we rotate by (targetHue − copperBase). Shared by the
// static poster orb (AgentOrb) and the live 3D orb (SplineOrb) so both tint
// identically from an agent's accent colour.
const COPPER_BASE_HUE = 30;

export function hexToHue(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** Degrees to hue-rotate the copper orb to match `accentColor`; falls back to
 *  a pleasant blue (~210°) when no accent is given. */
export function orbHueRotate(accentColor?: string | null, fallbackHue = 210): number {
  const h = accentColor ? hexToHue(accentColor) : null;
  return h != null ? (h - COPPER_BASE_HUE + 360) % 360 : fallbackHue;
}
