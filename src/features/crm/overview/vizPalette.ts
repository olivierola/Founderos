import { useThemeMode } from "@/lib/theme-context";

/**
 * Data-viz palette for the CRM overview.
 *
 * These hexes are NOT hand-picked — they were run through the dataviz validator
 * against THIS app's real chart surfaces (light #ffffff = --card, dark #1e1d1c
 * = --card) and both modes report ALL CHECKS PASS:
 *   light: worst adjacent CVD ΔE 9.1 (protan) · normal-vision ΔE 19.6
 *   dark : worst adjacent CVD ΔE 8.4 (protan) · normal-vision ΔE 19.3
 *
 * Two consequences that must be honoured by any consumer:
 *  1. Slot ORDER is the CVD-safety mechanism. Assign slots in sequence, never
 *     cycle past the 8th and never sort colors by value — fold the tail into
 *     "Autres" instead (see foldToSlots).
 *  2. On light, three slots sit below 3:1 contrast (magenta 2.69, yellow 2.17,
 *     aqua 2.82). That WARN is not dismissable: every segment coloured from this
 *     palette MUST also be direct-labelled (the rows under the bar) so the value
 *     is never carried by the fill alone.
 *
 * The app's own legacy CHART_COLORS fail these checks on white (normal-vision
 * ΔE 10.9, four slots outside the lightness band) — do not use them for charts.
 */
const CATEGORICAL_LIGHT = [
  "#2a78d6", // 1 blue
  "#008300", // 2 green
  "#e87ba4", // 3 magenta
  "#eda100", // 4 yellow
  "#1baf7a", // 5 aqua
  "#eb6834", // 6 orange
  "#4a3aa7", // 7 violet
  "#e34948", // 8 red
];

const CATEGORICAL_DARK = [
  "#3987e5", "#008300", "#d55181", "#c98500",
  "#199e70", "#d95926", "#9085e9", "#e66767",
];

/** Reserved status scale — never themed, never reused as "series N".
 *  Always shipped with an icon + label (on light, warning/serious are sub-3:1
 *  by design; the pairing is the documented mitigation). */
export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

/** The categorical slots for the active theme, in fixed order. */
export function useCategorical(): string[] {
  const theme = useThemeMode();
  return theme === "dark" ? CATEGORICAL_DARK : CATEGORICAL_LIGHT;
}

/** Max categorical slots before the tail must fold into "Autres". */
export const MAX_SLOTS = 8;

/**
 * Delta text colours. A delta is TEXT, so it must clear the WCAG text bar
 * (4.5:1) — not the 3:1 mark bar. Measured against each mode's card surface:
 *   light  good #006300 → 7.54 · bad #d03b3b → 4.80
 *   dark   good #0ca30c → 5.02 · bad #e66767 → 5.21
 * (The obvious picks fail: #0ca30c on white is 3.35 and #d03b3b on the dark
 * card is 3.50 — both below the text bar. Don't "simplify" these back.)
 */
export function useDeltaColors() {
  const theme = useThemeMode();
  return theme === "dark"
    ? { good: "#0ca30c", bad: "#e66767" }
    : { good: "#006300", bad: "#d03b3b" };
}

/** De-emphasis grey for the "context" series (comparison period) + empty grid. */
export function useContextGreys() {
  const theme = useThemeMode();
  return theme === "dark"
    ? { context: "#5c5b57", empty: "#2c2c2a" }
    : { context: "#c3c2b7", empty: "#ececea" };
}

/**
 * Folds a value distribution onto the fixed palette slots: keeps the largest
 * (MAX_SLOTS - 1) entries in their given order and folds everything else into a
 * single "Autres" bucket, so a 9th category never invents a 9th hue.
 */
export function foldToSlots<T extends { label: string; count: number }>(
  items: T[],
  otherLabel = "Autres",
): { label: string; count: number }[] {
  if (items.length <= MAX_SLOTS) return items.map((i) => ({ label: i.label, count: i.count }));
  const sorted = [...items].sort((a, b) => b.count - a.count);
  const head = sorted.slice(0, MAX_SLOTS - 1).map((i) => ({ label: i.label, count: i.count }));
  const tail = sorted.slice(MAX_SLOTS - 1).reduce((s, i) => s + i.count, 0);
  return [...head, { label: otherLabel, count: tail }];
}
