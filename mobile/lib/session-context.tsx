import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import {
  ensureFreshSession, loadSession, persistSession, signInWithPassword,
  signUpWithPassword, type Session,
} from "./session";

interface SessionContextValue {
  loading: boolean;
  session: Session | null;
  user: Session["user"] | null;
  signIn: (email: string, password: string) => Promise<void>;
  /** Returns true if signed in immediately, false if e-mail confirmation is pending. */
  signUp: (email: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  /** A guaranteed-fresh access token (refreshes silently on expiry). */
  getToken: () => Promise<string>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const ref = useRef<Session | null>(null);
  ref.current = session;

  useEffect(() => {
    loadSession()
      .then((s) => setSession(s))
      .finally(() => setLoading(false));
  }, []);

  const apply = useCallback(async (s: Session | null) => {
    ref.current = s;
    setSession(s);
    await persistSession(s);
  }, []);

  const signIn = useCallback<SessionContextValue["signIn"]>(async (email, password) => {
    await apply(await signInWithPassword(email, password));
  }, [apply]);

  const signUp = useCallback<SessionContextValue["signUp"]>(async (email, password) => {
    const s = await signUpWithPassword(email, password);
    if (s) { await apply(s); return true; }
    return false;
  }, [apply]);

  const signOut = useCallback<SessionContextValue["signOut"]>(async () => {
    await apply(null);
  }, [apply]);

  const getToken = useCallback<SessionContextValue["getToken"]>(async () => {
    const current = ref.current;
    if (!current) throw new Error("Non authentifié");
    const fresh = await ensureFreshSession(current);
    if (fresh !== current) { ref.current = fresh; setSession(fresh); }
    return fresh.accessToken;
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ loading, session, user: session?.user ?? null, signIn, signUp, signOut, getToken }),
    [loading, session, signIn, signUp, signOut, getToken],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within <SessionProvider>");
  return ctx;
}
