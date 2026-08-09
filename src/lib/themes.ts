/**
 * The app's skins. A theme is a BASE (the `.light` / `.dark` token block) plus,
 * for the named ones, a `data-skin` attribute whose overrides live in
 * globals.css. "system" adds nothing and follows the OS preference.
 *
 * Applied on <html>: Tailwind's `dark:` variants resolve against the nearest
 * `.dark` ANCESTOR, so a light skin declared lower in the tree would get light
 * tokens while still firing every `dark:` utility.
 */
export type ThemeKey =
  | "system" | "light" | "dark"
  | "carbon" | "purple" | "plum" | "midnight" | "ocean" | "slate"
  | "forest" | "mocha" | "amber" | "crimson" | "burnt-orange"
  | "sand" | "mist" | "lavender" | "sage";

export interface ThemeDef {
  key: ThemeKey;
  label: string;
  /** Token block to stand on; null = follow the OS. */
  base: "light" | "dark" | null;
  /** Swatch shown in every picker. */
  swatch: string;
}

export const THEMES: ThemeDef[] = [
  { key: "system", label: "Système", base: null, swatch: "linear-gradient(135deg,#fafafa 50%,#1c1b1a 50%)" },
  { key: "light", label: "Light", base: "light", swatch: "#ffffff" },
  { key: "dark", label: "Dark", base: "dark", swatch: "#171615" },
  { key: "carbon", label: "Carbon", base: "dark", swatch: "#121212" },
  { key: "purple", label: "Purple", base: "dark", swatch: "#231a3d" },
  { key: "plum", label: "Plum", base: "dark", swatch: "#271a26" },
  { key: "midnight", label: "Midnight", base: "dark", swatch: "#111a2b" },
  { key: "ocean", label: "Ocean", base: "dark", swatch: "#0f2027" },
  { key: "slate", label: "Slate", base: "dark", swatch: "#171d24" },
  { key: "forest", label: "Forest", base: "dark", swatch: "#111f1a" },
  { key: "mocha", label: "Mocha", base: "dark", swatch: "#1e1815" },
  { key: "amber", label: "Amber", base: "dark", swatch: "#1a1712" },
  { key: "crimson", label: "Crimson", base: "dark", swatch: "#241419" },
  { key: "burnt-orange", label: "Burnt Orange", base: "dark", swatch: "#2a1710" },
  { key: "sand", label: "Sand", base: "light", swatch: "#efe7d8" },
  { key: "mist", label: "Mist", base: "light", swatch: "#eef2f6" },
  { key: "lavender", label: "Lavender", base: "light", swatch: "#efeafc" },
  { key: "sage", label: "Sage", base: "light", swatch: "#e7f0e8" },
];

export const themeDef = (key: ThemeKey): ThemeDef => THEMES.find((t) => t.key === key) ?? THEMES[0];

/** Light or dark, resolving "system" against the OS. */
export function resolveBase(key: ThemeKey): "light" | "dark" {
  const def = themeDef(key);
  if (def.base) return def.base;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Paint a theme onto an element — <html> for the app, and nothing else. */
export function paintTheme(el: HTMLElement, key: ThemeKey) {
  const def = themeDef(key);
  const base = resolveBase(key);
  el.classList.remove("light", "dark");
  el.classList.add(base);
  el.style.colorScheme = base;
  // Only the named skins carry overrides; light/dark/system are the base alone.
  if (def.base && def.key !== "light" && def.key !== "dark") el.setAttribute("data-skin", def.key);
  else el.removeAttribute("data-skin");
}
