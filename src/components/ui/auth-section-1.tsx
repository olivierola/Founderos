"use client";

import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRightIcon as ArrowRight,
  CircleNotchIcon as Loader2,
  HandPalmIcon,
  SparkleIcon,
  StackIcon,
} from "@phosphor-icons/react";
import { Brand } from "@/features/marketing-site/hn/HnKit";

/* Split auth shell, in the site's Hunar register (04/10/2026): the form on
   white on the left, Geist throughout, blue pills; on the right the site's
   azure artwork panel with a real capture of the product rising out of it, as
   on the product bands of the landing page. Purely presentational — the pages
   own the Supabase calls and pass the submit handler, the pending flag and the
   messages back in. */

export type AuthMode = "login" | "signup";

export type AuthSubmitPayload = {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  /* Signup only: the box is an opt-OUT, so `true` means "don't email me". */
  marketingOptOut: boolean;
};

export type AuthSocialProvider = "google" | "apple";

const LINK =
  "font-medium text-[#006edd] underline-offset-4 transition-colors hover:text-[#0057c2] hover:underline dark:text-[#5aa8ff] dark:hover:text-[#8cc2ff]";

export function AuthSection({
  mode,
  submitting = false,
  error,
  info,
  onSubmit,
  onSocial,
}: {
  mode: AuthMode;
  submitting?: boolean;
  error?: string | null;
  info?: string | null;
  onSubmit: (payload: AuthSubmitPayload) => void;
  onSocial?: (provider: AuthSocialProvider) => void;
}) {
  const isSignup = mode === "signup";

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [marketingOptOut, setMarketingOptOut] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const canSubmit =
    !submitting &&
    email.trim().length > 0 &&
    password.length >= (isSignup ? 8 : 1) &&
    (!isSignup || acceptedTerms);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      password,
      marketingOptOut,
    });
  }

  return (
    <section
      className="min-h-screen bg-white p-3 text-[#0f1728] antialiased [font-synthesis:none] dark:bg-[#0b1220] dark:text-white"
      style={{ fontFamily: "'Geist', 'Inter', ui-sans-serif, system-ui, sans-serif" }}
    >
      <div className="grid min-h-[calc(100vh-1.5rem)] gap-3 lg:grid-cols-[0.92fr_1.08fr]">
        <div className="flex min-h-[760px] items-start px-6 py-10 sm:px-10 lg:min-h-0 lg:px-14 lg:py-12 xl:px-20">
          <div className="mx-auto w-full max-w-[460px]">
            <Link to="/" className="inline-flex" aria-label="Anduran, home">
              <span className="dark:hidden">
                <Brand />
              </span>
              <span className="hidden dark:inline-flex">
                <Brand tone="white" />
              </span>
            </Link>

            <div className="mt-16 lg:mt-20">
              <h1 className="text-[36px] font-medium leading-[1.05] tracking-[-0.04em] sm:text-[44px]">
                {isSignup ? "Create your account" : "Welcome back"}
              </h1>
              <p className="mt-3 text-[18px] leading-[1.35] text-[#4b5567] dark:text-white/65">
                {isSignup ? "Hire your first agents in minutes." : "Sign in to your AI workforce."}
              </p>
            </div>

            {onSocial && (
              <>
                <div className="mt-10 grid gap-3 sm:grid-cols-2">
                  <SocialButton
                    icon={<GoogleIcon />}
                    label={`${isSignup ? "Sign up" : "Sign in"} with Google`}
                    onClick={() => onSocial("google")}
                    disabled={submitting}
                  />
                  <SocialButton
                    icon={<AppleIcon />}
                    label={`${isSignup ? "Sign up" : "Sign in"} with Apple`}
                    onClick={() => onSocial("apple")}
                    disabled={submitting}
                  />
                </div>

                <div className="my-8 flex items-center gap-4 text-[14px] text-[#6b7385] dark:text-white/45">
                  <span className="h-px flex-1 bg-[#e6e9ef] dark:bg-white/10" />
                  or with your email
                  <span className="h-px flex-1 bg-[#e6e9ef] dark:bg-white/10" />
                </div>
              </>
            )}

            <form className="space-y-3" onSubmit={handleSubmit} noValidate>
              {isSignup && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <FieldBox
                    label="First name"
                    name="given-name"
                    autoComplete="given-name"
                    value={firstName}
                    onValueChange={setFirstName}
                  />
                  <FieldBox
                    label="Last name"
                    name="family-name"
                    autoComplete="family-name"
                    value={lastName}
                    onValueChange={setLastName}
                  />
                </div>
              )}

              <FieldBox
                label="Work email"
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onValueChange={setEmail}
              />
              <FieldBox
                label={isSignup ? "Password (8+ characters)" : "Password"}
                type="password"
                name="password"
                autoComplete={isSignup ? "new-password" : "current-password"}
                required
                minLength={isSignup ? 8 : undefined}
                value={password}
                onValueChange={setPassword}
              />

              {isSignup ? (
                <div className="space-y-3 px-1 pt-3 text-[14px] leading-5 text-[#4b5567] dark:text-white/60">
                  <CheckboxLine checked={marketingOptOut} onCheckedChange={setMarketingOptOut}>
                    I don&apos;t want to receive emails about Anduran feature updates
                  </CheckboxLine>
                  <CheckboxLine checked={acceptedTerms} onCheckedChange={setAcceptedTerms}>
                    I agree to the{" "}
                    <Link to="/docs" className={LINK}>
                      Terms of Service
                    </Link>{" "}
                    and the{" "}
                    <Link to="/docs" className={LINK}>
                      Privacy Policy
                    </Link>
                  </CheckboxLine>
                </div>
              ) : (
                <div className="px-1 pt-1 text-[14px] text-[#4b5567] dark:text-white/60">
                  Trouble signing in?{" "}
                  <Link to="/contact" className={LINK}>
                    Contact support
                  </Link>
                </div>
              )}

              <button
                type="submit"
                disabled={!canSubmit}
                className="group !mt-7 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#006edd] text-[16px] font-medium tracking-[-0.02em] text-white shadow-[0_14px_30px_-18px_rgba(0,87,194,0.9)] transition-colors hover:bg-[#0057c2] disabled:cursor-not-allowed disabled:bg-[#9fc3ec] disabled:shadow-none dark:disabled:bg-[#1d3a63] dark:disabled:text-white/50"
              >
                {submitting && <Loader2 className="size-5 animate-spin" />}
                {isSignup ? "Create account" : "Sign in"}
                {!submitting && (
                  <ArrowRight
                    weight="bold"
                    className="size-4 transition-transform duration-300 group-hover:translate-x-0.5"
                  />
                )}
              </button>
            </form>

            {info && <p className="mt-5 text-[15px] text-emerald-600 dark:text-emerald-400">{info}</p>}
            {error && <p className="mt-5 text-[15px] text-red-600 dark:text-red-400">{error}</p>}

            <p className="mt-8 text-[15px] text-[#4b5567] dark:text-white/60">
              {isSignup ? (
                <>
                  Already have an account?{" "}
                  <Link to="/login" className={LINK}>
                    Sign in
                  </Link>
                </>
              ) : (
                <>
                  No account yet?{" "}
                  <Link to="/signup" className={LINK}>
                    Create one
                  </Link>
                </>
              )}
            </p>
          </div>
        </div>

        {/* ── The panel ──────────────────────────────────────────────────────
            The site's azure artwork, the headline in two tones, the product's
            two rules as chips — and the real product rising out of the bottom
            edge, as on the landing page's product bands. */}
        <div className="hn-art hn-art-blue relative hidden min-h-[720px] overflow-hidden rounded-[28px] text-white lg:flex lg:min-h-0">
          <div className="relative z-10 flex h-full w-full flex-col p-10 xl:p-14">
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-white/25 bg-white/10 px-4 py-2 text-[14px] font-medium backdrop-blur-md">
              <SparkleIcon weight="fill" className="size-4" />
              The AI workforce that runs inside your tenant
            </span>
            <h2 className="mt-8 max-w-[560px] text-[48px] font-medium leading-[1.04] tracking-[-0.04em] xl:text-[60px]">
              Hire agents,
              <br />
              <span className="text-white/70">not headcount.</span>
            </h2>
            <div className="mt-8 flex flex-wrap gap-2.5">
              {[
                { icon: StackIcon, text: "Runs inside your tenant" },
                { icon: HandPalmIcon, text: "Every write waits for your approval" },
              ].map(({ icon: Icon, text }) => (
                <span
                  key={text}
                  className="inline-flex items-center gap-2.5 rounded-full bg-white px-4 py-2.5 text-[15px] font-medium text-[#0f1728] shadow-[0_16px_40px_-24px_rgba(4,32,92,0.8)]"
                >
                  <Icon className="size-[18px] text-[#006edd]" />
                  {text}
                </span>
              ))}
            </div>
            <Link
              to="/solutions"
              className="group mt-8 inline-flex h-11 w-fit items-center gap-2 rounded-full bg-white px-5 text-[15px] font-medium tracking-[-0.02em] text-[#0f1728] transition-colors hover:bg-white/90"
            >
              See what the workforce runs
              <ArrowRight
                weight="bold"
                className="size-4 transition-transform duration-300 group-hover:translate-x-0.5"
              />
            </Link>

            <div className="relative -mb-10 -mr-10 mt-auto pl-6 pt-12 xl:-mb-14 xl:-mr-14">
              <div className="overflow-hidden rounded-tl-[14px] border-l border-t border-white/30 bg-white shadow-[0_40px_80px_-30px_rgba(4,32,92,0.85)]">
                <img
                  src="/marketing/product-agents.jpg"
                  alt="The Agents page of Anduran, in a demo workspace"
                  className="block aspect-[1440/860] w-full object-cover object-left-top"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SocialButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-12 items-center justify-center gap-2.5 rounded-full border border-[#e6e9ef] bg-white px-4 text-[15px] font-medium leading-none tracking-[-0.02em] text-[#0f1728] transition-colors hover:border-[#cfd6e2] hover:bg-[#f7f8fb] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-white/[0.05] dark:text-white dark:hover:bg-white/10"
    >
      <span className="shrink-0">{icon}</span>
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

/* The label lives inside the box, right-aligned, and steps aside as soon as the
   field holds something — so an empty form still reads as a labelled form. */
function FieldBox({
  label,
  value,
  onValueChange,
  type = "text",
  name,
  autoComplete,
  required,
  minLength,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  type?: string;
  name?: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
}) {
  const [focused, setFocused] = useState(false);
  const showLabel = !focused && value.length === 0;

  return (
    <label className="flex h-12 items-center justify-between gap-4 rounded-full border border-[#e6e9ef] bg-white px-5 text-[16px] leading-none transition-[border-color,box-shadow] focus-within:border-[#006edd] focus-within:shadow-[0_0_0_4px_rgba(0,110,221,0.12)] dark:border-white/15 dark:bg-white/[0.05] dark:focus-within:border-[#5aa8ff] dark:focus-within:shadow-[0_0_0_4px_rgba(90,168,255,0.15)]">
      <input
        type={type}
        name={name}
        value={value}
        aria-label={label}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => onValueChange(event.target.value)}
        className="min-w-0 flex-1 truncate bg-transparent text-[#0f1728] outline-none placeholder:text-black/30 dark:text-white dark:placeholder:text-white/35"
      />
      {showLabel && <span className="shrink-0 text-[#6b7385] dark:text-white/45">{label}</span>}
    </label>
  );
}

function CheckboxLine({
  children,
  checked,
  onCheckedChange,
}: {
  children: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3">
      <span className="relative mt-0.5 size-4 shrink-0">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onCheckedChange(event.target.checked)}
          className="peer size-full appearance-none rounded-[5px] border border-[#c3cad6] bg-white checked:border-[#006edd] checked:bg-[#006edd] dark:border-white/30 dark:bg-white/5 dark:checked:border-[#5aa8ff] dark:checked:bg-[#5aa8ff]"
        />
        <svg
          viewBox="0 0 12 12"
          className="pointer-events-none absolute inset-0 hidden size-full p-0.5 text-white peer-checked:block dark:text-[#0b1220]"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3 6.2 5 8.1 9 3.9"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span>{children}</span>
    </label>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84Z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38Z"
        fill="#EB4335"
      />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M17.05 12.54c-.03-3.02 2.47-4.47 2.58-4.54-1.41-2.06-3.6-2.34-4.38-2.37-1.86-.19-3.64 1.1-4.58 1.1-.95 0-2.42-1.07-3.98-1.04-2.05.03-3.94 1.19-4.99 3.02-2.13 3.69-.54 9.16 1.53 12.15 1.01 1.46 2.22 3.1 3.81 3.04 1.53-.06 2.11-.99 3.96-.99s2.37.99 3.99.96c1.65-.03 2.69-1.49 3.69-2.96 1.16-1.69 1.64-3.33 1.66-3.41-.04-.02-3.2-1.23-3.24-4.87ZM14.03 3.66c.84-1.02 1.41-2.43 1.25-3.84-1.21.05-2.68.81-3.55 1.83-.78.9-1.46 2.34-1.28 3.72 1.35.1 2.73-.69 3.58-1.71Z" />
    </svg>
  );
}

export default AuthSection;
