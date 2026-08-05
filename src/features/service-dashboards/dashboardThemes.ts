import type { DashboardTheme } from "./model";

/**
 * The service dashboard's own skin. Each theme is a base (the app's `.light` /
 * `.dark` token block, re-declared on the shell's root element so the subtree
 * gets those variables) plus, for the named skins, a `data-sd-theme` attribute
 * whose overrides live in globals.css. "system" adds nothing and simply
 * inherits whatever the app is set to.
 */
export interface DashboardThemeDef {
  key: DashboardTheme;
  label: string;
  /** Which token block to stand on. */
  base: "light" | "dark" | null;
  /** Swatch shown in the picker. */
  swatch: string;
}

export const DASHBOARD_THEMES: DashboardThemeDef[] = [
  { key: "system", label: "Système", base: null, swatch: "linear-gradient(135deg,#fafafa 50%,#1c1b1a 50%)" },
  { key: "light", label: "Light", base: "light", swatch: "#ffffff" },
  { key: "dark", label: "Dark", base: "dark", swatch: "#171615" },
  { key: "purple", label: "Purple", base: "dark", swatch: "#231a3d" },
  { key: "midnight", label: "Midnight", base: "dark", swatch: "#111a2b" },
  { key: "slate", label: "Slate", base: "dark", swatch: "#171d24" },
  { key: "forest", label: "Forest", base: "dark", swatch: "#111f1a" },
  { key: "mocha", label: "Mocha", base: "dark", swatch: "#1e1815" },
  { key: "crimson", label: "Crimson", base: "dark", swatch: "#241419" },
  { key: "burnt-orange", label: "Burnt Orange", base: "dark", swatch: "#2a1710" },
  { key: "sand", label: "Sand", base: "light", swatch: "#efe7d8" },
  { key: "mist", label: "Mist", base: "light", swatch: "#eef2f6" },
];

/**
 * Apply a dashboard skin to <html> for as long as the dashboard is mounted.
 *
 * It has to be the document element, not the shell's own div: Tailwind's
 * `dark:` variants resolve against the nearest `.dark` ANCESTOR, so a `.light`
 * subtree inside a dark app would get light tokens but still trigger every
 * `dark:` utility. Returns the undo function.
 */
export function applyDashboardTheme(theme: DashboardTheme, appTheme: "light" | "dark"): () => void {
  const root = document.documentElement;
  const def = DASHBOARD_THEMES.find((t) => t.key === theme) ?? DASHBOARD_THEMES[0];
  const base = def.base ?? appTheme;
  const named = def.base !== null && def.key !== "light" && def.key !== "dark";

  root.classList.remove("light", "dark");
  root.classList.add(base);
  root.style.colorScheme = base;
  if (named) root.setAttribute("data-sd-theme", def.key);
  else root.removeAttribute("data-sd-theme");

  // Undo: hand the document back to the app's own theme.
  return () => {
    root.classList.remove("light", "dark");
    root.classList.add(appTheme);
    root.style.colorScheme = appTheme;
    root.removeAttribute("data-sd-theme");
  };
}
