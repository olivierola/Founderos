import { paintTheme, THEMES, type ThemeKey } from "@/lib/themes";
import type { DashboardTheme } from "./model";

/**
 * Service dashboards draw from the SAME catalogue as the rest of the app
 * (src/lib/themes.ts) — one list, one set of CSS blocks. What is specific here
 * is the scope: a person can give one service a different skin from their
 * app-wide one, and that override only lasts while the dashboard is open.
 */
export type DashboardThemeDef = (typeof THEMES)[number];
export const DASHBOARD_THEMES = THEMES;

/**
 * Wear this dashboard's skin for as long as it is mounted; the returned
 * function hands the document back to the person's app theme.
 *
 * "system" here means "no per-service override" — the app's skin is left
 * exactly as it is, rather than being stripped back to plain light/dark.
 */
export function applyDashboardTheme(theme: DashboardTheme, appTheme: ThemeKey): () => void {
  if (theme === "system") return () => {};
  paintTheme(document.documentElement, theme);
  return () => paintTheme(document.documentElement, appTheme);
}
