import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Provider } from "@supabase/supabase-js";
import {
  AuthSection,
  type AuthSocialProvider,
  type AuthSubmitPayload,
} from "@/components/ui/auth-section-1";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { discoverSso, fetchLoginOptions, type SsoLoginProvider } from "@/features/sso/api";

/** Where to land after signing in. Two pages ask for a return: the browser
 *  panel (it logs in inside its own frame) and the SSO setup, reached from the
 *  link on this page. Any other value falls back to /orgs, so the parameter
 *  cannot be used to bounce someone to an arbitrary page. */
const SSO_SETUP_PATH = "/sso-setup";
function safeNext(raw: string | null): string {
  // Le premier démarrage d'une installation (G5) et la configuration du SSO.
  if (raw === SSO_SETUP_PATH || raw === "/setup") return raw;
  return raw && /^\/companion(\/|\?|$)/.test(raw) ? raw : "/orgs";
}

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const { session, loading: authLoading } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The company SSO, when this installation has one. Until it is known the form
  // stays hidden, so an SSO-only organisation never flashes a password field —
  // but only for a moment: a query that never settles (paused by a browser
  // that believes it is offline, a request left hanging) used to leave the
  // page with no form at all. `networkMode: "always"` runs it regardless of
  // what the browser says about the network.
  const { data: sso, isError: ssoFailed } = useQuery({
    queryKey: ["sso-login-options"],
    queryFn: fetchLoginOptions,
    staleTime: 60_000,
    networkMode: "always",
  });
  const [waitedForSso, setWaitedForSso] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setWaitedForSso(true), 1500);
    return () => window.clearTimeout(t);
  }, []);

  if (!authLoading && session) {
    return <Navigate to={next} replace />;
  }

  async function handleLogin({ email, password }: AuthSubmitPayload) {
    setSubmitting(true);
    setError(null);
    // Shared instance: an address whose domain signs in through its company SSO
    // only is sent there instead of trying a password.
    if (sso?.discovery) {
      const found = await discoverSso(email);
      if (found?.sso_only) {
        setError(`${email.split("@")[1]} signs in with ${found.name}. Redirecting…`);
        await redirectToProvider(found);
        return;
      }
    }
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    navigate(next, { replace: true });
  }

  // The provider must be enabled in the Supabase dashboard (Auth → Providers);
  // otherwise the redirect never happens and the error lands in the form.
  async function handleSocial(provider: AuthSocialProvider) {
    setSubmitting(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}${next}` },
    });
    if (err) {
      setSubmitting(false);
      setError(err.message);
    }
  }

  // OIDC providers are registered in Supabase Auth as « custom:<slug> » and go
  // through the usual OAuth redirect; SAML ones are addressed by their id.
  async function handleSso(id: string) {
    const provider = sso?.providers.find((p) => p.id === id);
    if (!provider) return;
    await redirectToProvider(provider);
  }

  // Shared instance (0282): no provider is listed; the address finds the
  // provider of its verified domain.
  async function handleSsoDiscover(email: string) {
    setSubmitting(true);
    setError(null);
    const found = await discoverSso(email);
    if (!found) {
      setSubmitting(false);
      setError(`No company sign-in is set up for ${email.split("@")[1] ?? "this address"}. Use your password, or ask your administrator.`);
      return;
    }
    await redirectToProvider(found);
  }

  async function redirectToProvider(provider: Pick<SsoLoginProvider, "protocol" | "ref">) {
    setSubmitting(true);
    setError(null);
    const redirectTo = `${window.location.origin}${next}`;
    if (provider.protocol === "oidc") {
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: provider.ref as Provider,
        options: { redirectTo },
      });
      if (err) {
        setSubmitting(false);
        setError(err.message);
      }
      return;
    }
    const { data, error: err } = await supabase.auth.signInWithSSO({ providerId: provider.ref, options: { redirectTo } });
    if (err || !data?.url) {
      setSubmitting(false);
      setError(err?.message ?? "The identity provider did not answer.");
      return;
    }
    window.location.href = data.url;
  }

  const hasSso = !!sso?.providers.length;
  const settingUpSso = next === SSO_SETUP_PATH;

  return (
    <AuthSection
      mode="login"
      submitting={submitting}
      error={error}
      info={settingUpSso ? "Sign in with an owner or admin account: you will land on your organisation's SSO settings." : null}
      onSubmit={handleLogin}
      // Consumer sign-in has no place next to a company's own identity provider.
      onSocial={sso && !hasSso ? handleSocial : undefined}
      ssoProviders={sso?.providers.map((p) => ({ id: p.id, label: p.name, preset: p.preset }))}
      onSso={handleSso}
      onSsoDiscover={sso?.discovery ? handleSsoDiscover : undefined}
      passwordEnabled={sso ? !(sso.sso_only && hasSso) : waitedForSso || ssoFailed}
      ssoSetupHref={settingUpSso ? undefined : `/login?next=${encodeURIComponent(SSO_SETUP_PATH)}`}
    />
  );
}
