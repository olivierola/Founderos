// Retour du SSO de l'entreprise (popup). Échange le code via connector-action,
// prévient la fenêtre qui l'a ouverte, puis se ferme.
import { useEffect, useState } from "react";
import { SignInIcon as LogIn } from "@phosphor-icons/react";
import { connectorAction } from "./api";

// StrictMode monte deux fois : un code d'autorisation ne s'échange qu'une fois.
const handled = new Set<string>();

export function ConnectorOAuthCallbackPage() {
  const [msg, setMsg] = useState("Connexion en cours…");
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const code = p.get("code");
    const state = p.get("state");
    const err = p.get("error_description") || p.get("error");
    if (state) {
      if (handled.has(state)) return;
      handled.add(state);
    }
    const finish = (ok: boolean, detail?: string | null) => {
      setMsg(ok ? `Connecté${detail ? ` : ${detail}` : ""}. Vous pouvez fermer cette fenêtre.` : `Échec : ${detail ?? "inconnu"}`);
      try {
        window.opener?.postMessage({ type: "ccx-oauth", ok, ...(ok ? { identity: detail } : { error: detail }) }, window.location.origin);
      } catch { /* fenêtre d'origine fermée */ }
      if (window.opener && ok) setTimeout(() => window.close(), 900);
    };
    (async () => {
      if (err) return finish(false, err);
      if (!code || !state) return finish(false, "paramètres manquants");
      try {
        const res = await connectorAction<{ ok: boolean; identity?: string | null; error?: string }>({ mode: "custom.oauth_callback", code, state });
        finish(res.ok, res.ok ? res.identity ?? null : res.error);
      } catch (e) {
        finish(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-2 bg-background px-6 text-center text-sm text-muted-foreground">
      <LogIn className="h-6 w-6 text-primary" />
      <p>{msg}</p>
    </div>
  );
}
