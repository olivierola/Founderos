import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { paintTheme, resolveBase, type ThemeKey } from "@/lib/themes";

/** Kept as an alias: plenty of callers only care about light vs dark. */
export type Theme = ThemeKey;

type ThemeContextValue = {
  /** The chosen key — may be "system". */
  theme: ThemeKey;
  /** What "system" actually resolves to right now. */
  base: "light" | "dark";
  setTheme: (theme: ThemeKey) => void;
  /** Flip between plain light and plain dark, whatever skin was on. */
  toggleTheme: () => void;
};

const STORAGE_KEY = "founderos.theme";

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function getInitialTheme(): ThemeKey {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return (stored as ThemeKey) || "system";
}

/**
 * One theme per user, for the whole app.
 *
 * localStorage is the fast path — it is read synchronously so the first paint
 * is already correct — and `profiles.theme` (0178) is the durable copy that
 * follows the account to another browser.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeKey>(() => getInitialTheme());
  // Guards the first DB read from overwriting a choice made in the meantime.
  const touched = useRef(false);

  useEffect(() => {
    paintTheme(document.documentElement, theme);
    try { window.localStorage.setItem(STORAGE_KEY, theme); } catch { /* private mode */ }
  }, [theme]);

  // Another tab changed the theme — follow it, so every open dashboard of this
  // person lands on the same skin without a reload.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      touched.current = true;
      setThemeState(e.newValue as ThemeKey);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Repaint when the OS flips and we are following it.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!mq) return;
    const onChange = () => paintTheme(document.documentElement, "system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // Adopt the account's saved theme once, on sign-in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid || cancelled || touched.current) return;
      const { data } = await supabase.from("profiles").select("theme").eq("id", uid).maybeSingle();
      const saved = (data as { theme: string | null } | null)?.theme as ThemeKey | undefined;
      if (saved && !cancelled && !touched.current) setThemeState(saved);
    })();
    return () => { cancelled = true; };
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const commit = (next: ThemeKey) => {
      touched.current = true;
      setThemeState(next);
      // Durable copy — best effort, the local one already took effect.
      void (async () => {
        const { data: auth } = await supabase.auth.getUser();
        const uid = auth.user?.id;
        if (!uid) return;
        await supabase.from("profiles").update({ theme: next }).eq("id", uid);
      })();
    };
    return {
      theme,
      base: resolveBase(theme),
      setTheme: commit,
      toggleTheme: () => commit(resolveBase(theme) === "dark" ? "light" : "dark"),
    };
  }, [theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

/**
 * The active theme for code that may run OUTSIDE the provider.
 *
 * React context does not cross React roots, and we mount detached roots on
 * purpose — an Editor.js block hosts its renderer in its own `createRoot`. A
 * component in there calling `useTheme()` throws, and a throw inside a detached
 * root during a synchronous mount takes down the tree that triggered it: that
 * is how one chart in a report blanked the whole page.
 *
 * Reading the theme is not a reason to require a provider. The class the
 * provider writes onto <html> is already the source of truth for every
 * stylesheet in the app, so fall back to reading it.
 */
export function useThemeMode(): Theme {
  const ctx = useContext(ThemeContext);
  if (ctx) return ctx.theme;
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** HSL (h in degrees, s/l in percent) → "#rrggbb". Fractional inputs welcome —
 *  they are exactly what breaks the naive parsers this exists to feed. */
export function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lum = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lum, 1 - lum);
  const f = (n: number) => lum - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/**
 * The live value of a theme token, as a usable CSS colour.
 *
 * For anything painted OUTSIDE of CSS — a WebGL shader, a canvas, a chart
 * library that wants a string — where `bg-background` cannot be applied. It
 * returns `hsl(<triple>)` because the tokens are stored as bare HSL triples
 * ("30 5% 9%"), the way shadcn does.
 *
 * It watches <html> rather than the context on purpose: `paintTheme` also runs
 * when the OS flips under "system", which changes no React state, and detached
 * roots (an Editor.js block, a portal) have no provider above them at all. The
 * attributes the provider writes are the one source of truth both cases share.
 */
export function useThemeToken(name: string, fallback = "transparent"): string {
  const read = () => {
    if (typeof document === "undefined") return fallback;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!raw) return fallback;
    // A bare triple ("30 5% 9%") is converted to HEX; anything already a colour
    // (a hex, an oklch, a full hsl()) is passed through untouched.
    //
    // Hex rather than hsl() is the whole point. Consumers here are OUTSIDE CSS
    // — a WebGL shader, a canvas, a charting lib — and they parse the string
    // themselves, often with a hand-rolled regex. @paper-design/shaders is the
    // proof: its hsl() parser accepts integers only (`(\d+)%`), so a token like
    // `7.5%` — which half our skins use — fails to match and silently falls
    // back to its `[0.5, 0.5, 0.5]` MID GREY. Hex has no such trap, and stays a
    // perfectly valid CSS colour for callers that just drop it into a style.
    const m = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(raw);
    return m ? hslToHex(Number(m[1]), Number(m[2]), Number(m[3])) : raw;
  };
  const [value, setValue] = useState(read);

  useEffect(() => {
    const sync = () => setValue(read());
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-skin", "style"] });
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, fallback]);

  return value;
}
