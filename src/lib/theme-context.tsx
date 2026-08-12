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
