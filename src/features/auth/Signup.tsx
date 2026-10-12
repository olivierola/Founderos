import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AuthSection,
  type AuthSocialProvider,
  type AuthSubmitPayload,
} from "@/components/ui/auth-section-1";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { readAttribution } from "@/lib/attribution";
import { fetchLoginOptions } from "@/features/sso/api";

export function SignupPage() {
  const navigate = useNavigate();
  const { session, loading: authLoading } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const { data: sso } = useQuery({ queryKey: ["sso-login-options"], queryFn: fetchLoginOptions, staleTime: 60_000 });

  if (!authLoading && session) {
    return <Navigate to="/onboarding" replace />;
  }
  // Accounts of an SSO-only organisation are created by its identity provider,
  // on first sign-in.
  if (sso?.sso_only && sso.providers.length) {
    return <Navigate to="/login" replace />;
  }

  async function handleSignup({
    firstName,
    lastName,
    email,
    password,
    marketingOptOut,
  }: AuthSubmitPayload) {
    setSubmitting(true);
    setError(null);
    setInfo(null);
    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    const { data, error: err } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/onboarding`,
        data: {
          first_name: firstName || null,
          last_name: lastName || null,
          full_name: fullName || null,
          marketing_opt_in: !marketingOptOut,
          // Where this account came from (widget « Powered by », campaign).
          acquisition: readAttribution(),
        },
      },
    });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    if (data.session) {
      navigate("/onboarding", { replace: true });
    } else {
      setInfo("Account created. Check your inbox to confirm your email, then sign in.");
    }
  }

  // The provider must be enabled in the Supabase dashboard (Auth → Providers);
  // otherwise the redirect never happens and the error lands in the form.
  async function handleSocial(provider: AuthSocialProvider) {
    setSubmitting(true);
    setError(null);
    setInfo(null);
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/onboarding` },
    });
    if (err) {
      setSubmitting(false);
      setError(err.message);
    }
  }

  return (
    <AuthSection
      mode="signup"
      submitting={submitting}
      error={error}
      info={info}
      onSubmit={handleSignup}
      onSocial={sso?.providers.length ? undefined : handleSocial}
    />
  );
}
