import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import {
  AuthSection,
  type AuthSocialProvider,
  type AuthSubmitPayload,
} from "@/components/ui/auth-section-1";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";

/** Where to land after signing in. Only the browser panel asks for a return
 *  (it logs in inside its own frame); any other value falls back to /orgs, so
 *  the parameter cannot be used to bounce someone to an arbitrary page. */
function safeNext(raw: string | null): string {
  return raw && /^\/companion(\/|\?|$)/.test(raw) ? raw : "/orgs";
}

export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const { session, loading: authLoading } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!authLoading && session) {
    return <Navigate to={next} replace />;
  }

  async function handleLogin({ email, password }: AuthSubmitPayload) {
    setSubmitting(true);
    setError(null);
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

  return (
    <AuthSection
      mode="login"
      submitting={submitting}
      error={error}
      onSubmit={handleLogin}
      onSocial={handleSocial}
    />
  );
}
