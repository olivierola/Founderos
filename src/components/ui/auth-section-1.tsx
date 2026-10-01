"use client";

import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRightIcon as ArrowUpRight,
  CircleNotchIcon as Loader2,
  HandPalmIcon,
  SparkleIcon,
  StackIcon,
} from "@phosphor-icons/react";
import { BrandLockup, TileField } from "@/features/marketing-site/atlas/AtlasKit";

/* Split auth shell, in the site's Atlas register: the form on a white card
   on the left, the black-to-violet hero ground on the right. Purely presentational — the pages own the Supabase calls and pass the
   submit handler, the pending flag and the messages back in. */

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
    <section className="min-h-screen bg-white p-2.5 text-[#111011] antialiased [font-synthesis:none] dark:bg-[#0b0a0b] dark:text-white">
      <div className="grid min-h-[calc(100vh-1.25rem)] gap-2.5 lg:grid-cols-[0.94fr_1.06fr]">
        <div className="flex min-h-[760px] items-start rounded-[28px] border border-[#f0f0f0] bg-white px-6 py-12 sm:rounded-[40px] sm:px-10 dark:border-white/[0.08] dark:bg-[#121112] lg:min-h-0 lg:px-14 lg:py-16 xl:px-20">
          <div className="mx-auto w-full max-w-[520px]">
            <Link to="/" className="mb-12 inline-flex" aria-label="Anduran — home">
              <span className="dark:hidden">
                <BrandLockup />
              </span>
              <span className="hidden dark:inline-flex">
                <BrandLockup tone="white" />
              </span>
            </Link>

            <div>
              <h1 className="text-[38px] font-semibold leading-[1.02] tracking-[-0.045em] sm:text-[46px]">
                {isSignup ? "Create an account" : "Welcome back"}
              </h1>
              <p className="at-serif mt-2 text-[28px] leading-[1.1] text-[#111011] dark:text-white sm:text-[34px]">
                {isSignup ? "hire your first agents in minutes." : "to your AI workforce."}
              </p>
            </div>

            {onSocial && (
              <>
                <div className="mt-10 grid gap-2.5 sm:grid-cols-2">
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

                <div className="my-8 flex items-center gap-4 text-[14px] font-medium text-[#969696]">
                  <span className="h-px flex-1 bg-[#ececec] dark:bg-white/10" />
                  or
                  <span className="h-px flex-1 bg-[#ececec] dark:bg-white/10" />
                </div>
              </>
            )}

            <form className="space-y-2.5" onSubmit={handleSubmit} noValidate>
              {isSignup && (
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <FieldBox
                    label="First Name"
                    name="given-name"
                    autoComplete="given-name"
                    value={firstName}
                    onValueChange={setFirstName}
                  />
                  <FieldBox
                    label="Last Name"
                    name="family-name"
                    autoComplete="family-name"
                    value={lastName}
                    onValueChange={setLastName}
                  />
                </div>
              )}

              <FieldBox
                label="Email"
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onValueChange={setEmail}
              />
              <FieldBox
                label="Password"
                type="password"
                name="password"
                autoComplete={isSignup ? "new-password" : "current-password"}
                required
                minLength={isSignup ? 8 : undefined}
                value={password}
                onValueChange={setPassword}
              />

              {isSignup ? (
                <div className="space-y-3 px-1 pt-3 text-[14px] leading-5 text-[#666666] dark:text-white/55">
                  <CheckboxLine
                    checked={marketingOptOut}
                    onCheckedChange={setMarketingOptOut}
                  >
                    I don&apos;t want to receive emails about Anduran feature updates
                  </CheckboxLine>
                  <CheckboxLine checked={acceptedTerms} onCheckedChange={setAcceptedTerms}>
                    I agree to the{" "}
                    <Link
                      to="/docs"
                      className="font-semibold text-[#111011] underline decoration-[#d22eff]/50 underline-offset-2 dark:text-white"
                    >
                      Terms and Services
                    </Link>{" "}
                    and{" "}
                    <Link
                      to="/docs"
                      className="font-semibold text-[#111011] underline decoration-[#d22eff]/50 underline-offset-2 dark:text-white"
                    >
                      Privacy Policy
                    </Link>
                  </CheckboxLine>
                </div>
              ) : (
                <div className="px-1 pt-2 text-[14px] text-[#666666] dark:text-white/55">
                  Trouble signing in? Contact{" "}
                  <Link
                    to="/contact"
                    className="font-semibold text-[#111011] underline decoration-[#d22eff]/50 underline-offset-2 dark:text-white"
                  >
                    support
                  </Link>
                  .
                </div>
              )}

              <button
                type="submit"
                disabled={!canSubmit}
                className="group !mt-7 flex h-[52px] w-full items-center justify-center gap-2.5 rounded-full bg-black text-[16px] font-semibold tracking-[-0.015em] text-white shadow-[0_14px_30px_-16px_rgba(0,0,0,0.7)] transition-colors hover:bg-[#1d1c1d] disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-[#111011] dark:hover:bg-white/90"
              >
                {submitting && <Loader2 className="size-5 animate-spin" />}
                {isSignup ? "Create account" : "Sign in"}
                {!submitting && (
                  <ArrowUpRight
                    weight="bold"
                    className="size-4 transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                  />
                )}
              </button>
            </form>

            {info && (
              <p className="mt-5 text-[15px] text-emerald-600 dark:text-emerald-400">{info}</p>
            )}
            {error && <p className="mt-5 text-[15px] text-red-600 dark:text-red-400">{error}</p>}

            <p className="mt-8 text-[15px] text-[#666666] dark:text-white/55">
              {isSignup ? (
                <>
                  Already have an account?{" "}
                  <Link
                    to="/login"
                    className="font-semibold text-[#111011] underline decoration-[#d22eff]/50 underline-offset-4 dark:text-white"
                  >
                    Sign in
                  </Link>
                </>
              ) : (
                <>
                  No account yet?{" "}
                  <Link
                    to="/signup"
                    className="font-semibold text-[#111011] underline decoration-[#d22eff]/50 underline-offset-4 dark:text-white"
                  >
                    Create one
                  </Link>
                </>
              )}
            </p>
          </div>
        </div>

        {/* ── The panel ──────────────────────────────────────────────────────
            The site's hero ground — black into violet into white, the tile
            field over it — so signing in feels like the same product. */}
        <div className="at-grad-hero relative hidden min-h-[720px] overflow-hidden rounded-[40px] text-white lg:flex lg:min-h-0">
          <TileField
            lit={[[0, 0], [1, 1], [5, 0], [6, 1], [7, 2], [1, 6], [2, 7], [6, 5], [7, 6]]}
          />
          <div className="relative z-10 flex h-full w-full flex-col justify-between p-10 xl:p-14">
            <div className="pt-10">
              <span className="inline-flex items-center gap-2.5 rounded-full border border-white/[0.14] bg-white/[0.08] px-4 py-2.5 text-[14px] font-semibold text-white backdrop-blur-md">
                <SparkleIcon className="size-[18px]" />
                The AI workforce that runs inside your tenant
              </span>
              <h2 className="mt-8 max-w-[560px] text-[52px] font-semibold leading-[1.0] tracking-[-0.045em] text-white xl:text-[64px]">
                Hire agents,
                <br />
                <span className="at-serif text-[1.1em] font-normal">not headcount.</span>
              </h2>
            </div>

            <div className="space-y-2.5">
              {[
                { icon: StackIcon, text: "Runs inside your tenant" },
                { icon: HandPalmIcon, text: "Every write waits for your approval" },
              ].map(({ icon: Icon, text }) => (
                <div
                  key={text}
                  className="flex w-fit items-center gap-3.5 rounded-full bg-white px-5 py-3 text-[15px] font-medium text-[#111011] shadow-[0_16px_40px_-24px_rgba(60,0,90,0.6)]"
                >
                  <Icon className="size-5" />
                  {text}
                </div>
              ))}
              <Link
                to="/solutions"
                className="group !mt-6 inline-flex h-12 items-center gap-2.5 rounded-full bg-black px-6 text-[15px] font-semibold text-white shadow-[0_14px_30px_-16px_rgba(0,0,0,0.7)] transition-colors hover:bg-[#1d1c1d]"
              >
                See what the workforce runs
                <ArrowUpRight
                  weight="bold"
                  className="size-4 transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                />
              </Link>
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
      className="flex h-12 items-center justify-center gap-2.5 rounded-full border border-[#e6e6e6] bg-white px-4 text-[14.5px] font-semibold leading-none tracking-[-0.01em] text-[#111011] shadow-[0_12px_30px_-20px_rgba(17,16,17,0.35)] transition-colors hover:border-[#d4d4d4] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-white/[0.06] dark:text-white dark:hover:bg-white/10"
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
    <label className="flex h-[52px] items-center justify-between gap-4 rounded-full border border-[#e6e6e6] bg-white px-6 text-[16px] leading-none transition-colors focus-within:border-[#d22eff] dark:border-white/15 dark:bg-white/[0.05] dark:focus-within:border-[#e27cff]">
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
        className="min-w-0 flex-1 truncate bg-transparent text-[#111011] outline-none placeholder:text-black/30 dark:text-white dark:placeholder:text-white/35"
      />
      {showLabel && (
        <span className="shrink-0 text-[#969696] dark:text-white/45">{label}</span>
      )}
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
          className="peer size-full appearance-none rounded-full border border-black/25 bg-white checked:border-black checked:bg-black dark:border-white/30 dark:bg-white/5 dark:checked:border-white dark:checked:bg-white"
        />
        <svg
          viewBox="0 0 12 12"
          className="pointer-events-none absolute inset-0 hidden size-full p-0.5 text-white peer-checked:block dark:text-black"
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
