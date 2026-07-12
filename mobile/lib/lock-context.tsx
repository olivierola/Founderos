import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import { hasPin } from "./security";

interface LockContextValue {
  ready: boolean;        // finished checking whether a PIN exists
  pinSet: boolean;       // a lock code is configured
  locked: boolean;       // app is currently locked (needs unlock)
  unlock: () => void;
  lock: () => void;
  refresh: () => Promise<void>; // re-read pin state after set/clear
}

const LockContext = createContext<LockContextValue | null>(null);

export function LockProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [pinSet, setPinSet] = useState(false);
  const [locked, setLocked] = useState(true);
  const pinSetRef = useRef(false);

  const refresh = useCallback(async () => {
    const set = await hasPin();
    pinSetRef.current = set;
    setPinSet(set);
    if (!set) setLocked(false); // no code → never locked
    setReady(true);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Re-lock when the app returns to the foreground (if a code is configured).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && pinSetRef.current) setLocked(true);
    });
    return () => sub.remove();
  }, []);

  const unlock = useCallback(() => setLocked(false), []);
  const lock = useCallback(() => { if (pinSetRef.current) setLocked(true); }, []);

  const value = useMemo<LockContextValue>(
    () => ({ ready, pinSet, locked, unlock, lock, refresh }),
    [ready, pinSet, locked, unlock, lock, refresh],
  );

  return <LockContext.Provider value={value}>{children}</LockContext.Provider>;
}

export function useLock(): LockContextValue {
  const ctx = useContext(LockContext);
  if (!ctx) throw new Error("useLock must be used within <LockProvider>");
  return ctx;
}
