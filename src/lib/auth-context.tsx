import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { persistAttributionToUser } from "@/lib/attribution";
import { API_URL } from "@/lib/runtime-config";

/** Connexion par le SSO de l'entreprise (fournisseur OIDC « custom:… » de Supabase Auth). */
const isEnterpriseSso = (user: User | null | undefined) =>
  String(user?.app_metadata?.provider ?? "").startsWith("custom:");

/**
 * Installation dédiée : au retour du SSO, supabase-js expose UNE fois le jeton
 * de rafraîchissement de l'IdP de l'entreprise. On le remet au backend
 * (fonction idp-token), qui le garde chiffré pour les appels d'outils faits au
 * nom de cette personne, si ce fournisseur délègue aux agents
 * (docs/enterprise-generalisation.md G1). Le navigateur ne le conserve pas.
 */
async function handOverIdpToken(session: Session): Promise<void> {
  const token = session.provider_refresh_token;
  if (!token || !API_URL || !isEnterpriseSso(session.user)) return;
  // Une session restaurée peut réémettre un jeton déjà remis (et déjà tourné
  // côté serveur) : on ne le renvoie pas.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const marker = `fos-idp-handover:${Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  try {
    if (localStorage.getItem(marker)) return;
  } catch { /* stockage indisponible : le serveur déduplique aussi */ }
  try {
    await callEdge("idp-token", { action: "store", refresh_token: token, provider: session.user.app_metadata?.provider });
    try { localStorage.setItem(marker, "1"); } catch { /* ignoré */ }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[sso] jeton SSO non conservé : les agents ne pourront pas agir en votre nom.", err);
  }
}

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      // Hors du rappel : supabase-js déconseille d'y attendre un autre appel auth
      // (callEdge relit la session).
      if (event === "SIGNED_IN" && newSession?.provider_refresh_token) {
        setTimeout(() => void handOverIdpToken(newSession), 0);
      }
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  // OAuth sign-ups can't carry metadata through the redirect: attach the stored
  // acquisition touch on their first session. Only for accounts created in the
  // last 24 h — an old account clicking a widget badge is not an acquisition.
  const userId = session?.user?.id;
  useEffect(() => {
    const u = session?.user;
    if (!u?.created_at || Date.now() - new Date(u.created_at).getTime() > 86_400_000) return;
    void persistAttributionToUser(u);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    loading,
    signOut: async () => {
      // Le jeton SSO conservé pour les agents est oublié et invalidé avant la
      // fin de la session (il faut encore le JWT pour appeler le backend).
      if (API_URL && isEnterpriseSso(session?.user)) {
        await callEdge("idp-token", { action: "revoke", provider: session?.user.app_metadata?.provider }).catch(() => {});
      }
      await supabase.auth.signOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
