import { Link } from "react-router-dom";
import {
  ArrowRight,
  Layers,
  Wallet,
  ShieldCheck,
  Plug2,
  Sparkles,
  Activity,
  GitBranch,
  Building2,
  Zap,
  Lock,
  Quote,
  Star,
  Users,
  Database,
  CheckCircle2,
  TrendingUp,
  Rocket,
  Eye,
} from "lucide-react";
import { MarketingShell, DotGrid } from "./MarketingShell";
import { CockpitMockup, ArchitectureDiagram, FlowDiagram, GradientOrb } from "./Illustrations";

const STATS = [
  { value: "57", label: "Provider integrations", icon: Plug2 },
  { value: "12", label: "Cockpit modules", icon: Layers },
  { value: "80+", label: "Pre-built widgets", icon: Sparkles },
  { value: "100ms", label: "Edge p50 latency", icon: Zap },
];

const LOGOS = [
  "Stripe", "Vercel", "GitHub", "Supabase", "Linear", "Resend",
  "Slack", "PostHog", "Sentry", "Cloudflare", "Fly.io", "Netlify",
  "Railway", "Heroku", "Firebase", "Datadog", "Mixpanel", "Segment",
];

const FEATURE_CARDS = [
  { icon: Layers, color: "hsl(var(--primary-soft))", title: "One cockpit per client", body: "Switch between every client's SaaS in two clicks. Each project gets isolated metrics, secrets and actions." },
  { icon: Wallet, color: "hsl(var(--accent-2))", title: "Money, infra, ops — together", body: "Stripe MRR, Vercel deploys, Supabase secrets, GitHub scans. One pane of glass, zero context switching." },
  { icon: ShieldCheck, color: "#a78bfa", title: "Admin actions with audit trail", body: "Refund a customer, rotate a key, kick a deploy. Every action is logged and approval-gated." },
  { icon: Sparkles, color: "#fbbf24", title: "AI agents shipped to your clients", body: "RAG-powered widgets and dynamic onboarding the agent drives — highlights, popups, navigation, live." },
  { icon: Activity, color: "#34d399", title: "Real deployments, real logs", body: "Synced from Vercel, GitHub Actions, Netlify, Fly, Heroku, Supabase, Firebase, Render and bare-metal VPS." },
  { icon: Plug2, color: "#f472b6", title: "50+ providers — and your own DB", body: "Query the client's Supabase project directly. Build custom dashboards from any table." },
];

const TESTIMONIALS = [
  {
    quote: "We replaced 6 dashboards with FounderOS. Refunds that used to take 3 days now take 30 seconds.",
    author: "Léa Vermont",
    role: "CTO, Frictionless Studio",
  },
  {
    quote: "The audit log alone is worth the price. We finally pass SOC2 reviews without spreadsheets.",
    author: "Marcus Tan",
    role: "Founder, Tan & Co",
  },
  {
    quote: "Our junior devs ship admin tools through approval flows instead of running scripts in prod.",
    author: "Aïcha Diallo",
    role: "Head of Eng, Loom Agency",
  },
];

const WORKFLOW = [
  { num: "01", title: "Connect your stack", body: "Stripe, GitHub, Vercel, Supabase, Linear… pick from 57 providers. Encrypted vault, no plaintext leaves the browser." },
  { num: "02", title: "Scan & understand", body: "We scan your code, your billing, your infra. Detect services, dependencies, env vars, AI risks. Build a semantic map." },
  { num: "03", title: "Operate from one cockpit", body: "MRR, churn, deploys, alerts, customer 360 — everything live, everything actionable in two clicks." },
  { num: "04", title: "Automate & onboard", body: "AI agents answer your support, drive user onboarding, surface decisions. Workflows replace your scripts." },
];

const TRUST_PILLARS = [
  { icon: Lock, title: "AES-GCM 256-bit encryption", body: "Every credential is encrypted at rest. Plaintext is never returned to the browser." },
  { icon: ShieldCheck, title: "Row-level security on every table", body: "Supabase RLS enforces project isolation. Workspace members only see what they own." },
  { icon: Eye, title: "Full audit log of admin actions", body: "Every refund, key rotation, deployment is timestamped, attributed, and exportable." },
  { icon: Database, title: "Your data stays in your stack", body: "We connect to your databases, never copy them. Pause sync at any time." },
];

const FAQ = [
  { q: "Do I host my customers' data?", a: "No. FounderOS connects to your customers' existing Stripe, Supabase, GitHub. We store metadata and encrypted credentials, never their raw user data." },
  { q: "Can I white-label the cockpit for my clients?", a: "Pro and Enterprise plans support custom branding (logo, color, domain). Full white-label with custom email senders is on the Enterprise plan." },
  { q: "What about SSO and SCIM?", a: "SSO via SAML and SCIM provisioning are included on Enterprise. Free and Pro use email + 2FA." },
  { q: "How fast are updates?", a: "We ship multiple times a week. Every release is documented in /changelog with no breaking changes promise on stable APIs." },
  { q: "Can I self-host?", a: "Not yet. We're working on a self-hosted edition for Enterprise. Contact us for the roadmap." },
];

export function HomePage() {
  return (
    <MarketingShell>
      {/* ============= Hero ============= */}
      <section className="relative overflow-hidden border-b border-border/60">
        <DotGrid />
        <GradientOrb className="absolute -top-32 -left-32 h-96 w-96" color="hsl(var(--primary-soft))" />
        <GradientOrb className="absolute -top-32 right-0 h-96 w-96" color="hsl(var(--accent-2))" />

        <div className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-28">
          <div className="mx-auto max-w-3xl text-center mkt-fade-up">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border/60 bg-secondary/50 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
              <Building2 className="h-3 w-3" />
              Built for technical agencies
              <span className="ml-1 rounded-full bg-[hsl(var(--accent-2)/0.2)] px-1.5 py-0.5 text-[10px] text-[hsl(var(--accent-2))]">v1.4 live</span>
            </div>
            <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
              The cockpit{" "}
              <span className="relative inline-block">
                <span className="bg-gradient-to-r from-[hsl(var(--primary-soft))] to-[hsl(var(--accent-2))] bg-clip-text text-transparent">
                  agencies run on
                </span>
                <svg className="absolute -bottom-1.5 left-0 w-full" height="6" viewBox="0 0 200 6" preserveAspectRatio="none">
                  <path d="M0 3 Q 100 6, 200 3" stroke="url(#hero-underline)" strokeWidth="2" fill="none" strokeLinecap="round" />
                  <defs>
                    <linearGradient id="hero-underline">
                      <stop offset="0%" stopColor="hsl(var(--primary-soft))" />
                      <stop offset="100%" stopColor="hsl(var(--accent-2))" />
                    </linearGradient>
                  </defs>
                </svg>
              </span>
              .
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-base text-muted-foreground sm:text-lg">
              Manage every client SaaS from one panel — billing, infra, deploys, secrets, support
              and AI agents. Replace 12 dashboards with one.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-2 sm:flex-row">
              <Link
                to="/signup"
                className="group inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:opacity-90 hover:shadow-primary/30 sm:w-auto"
              >
                Start free — no card
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                to="/features"
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-secondary/50 px-5 py-2.5 text-sm backdrop-blur transition-colors hover:bg-secondary sm:w-auto"
              >
                See features
              </Link>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Unlimited team members on the Free plan. 14-day Pro trial. No credit card.
            </p>
          </div>

          {/* Big cockpit mockup */}
          <div className="relative mx-auto mt-16 max-w-5xl mkt-rise">
            <div className="absolute -inset-4 -z-10 rounded-3xl bg-gradient-to-r from-[hsl(var(--primary-soft)/0.2)] to-[hsl(var(--accent-2)/0.2)] blur-2xl" />
            <CockpitMockup className="w-full rounded-xl border border-border bg-card shadow-2xl" />
          </div>

          {/* Stats strip */}
          <div className="mx-auto mt-16 grid max-w-4xl grid-cols-2 gap-3 sm:grid-cols-4">
            {STATS.map((s) => {
              const Icon = s.icon;
              return (
                <div key={s.label} className="rounded-xl border border-border bg-card/60 p-4 text-center backdrop-blur transition-colors hover:bg-card">
                  <Icon className="mx-auto h-4 w-4 text-muted-foreground" />
                  <div className="mt-2 text-2xl font-semibold tabular-nums">{s.value}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{s.label}</div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ============= Logo marquee ============= */}
      <section className="overflow-hidden border-b border-border/60 bg-background py-10">
        <div className="mx-auto mb-6 max-w-6xl px-4 sm:px-6">
          <p className="text-center text-xs uppercase tracking-wider text-muted-foreground">
            Plugs into the tools your clients already use
          </p>
        </div>
        <div className="relative">
          <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-32 bg-gradient-to-r from-background to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-32 bg-gradient-to-l from-background to-transparent" />
          <div className="flex w-max mkt-marquee">
            {[...LOGOS, ...LOGOS].map((l, i) => (
              <span key={i} className="mx-8 whitespace-nowrap text-sm font-medium text-muted-foreground/60 transition-colors hover:text-foreground">
                {l}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ============= How it works (4 steps) ============= */}
      <section className="relative border-b border-border/60 bg-background py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto mb-14 max-w-2xl text-center">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/40 px-3 py-1 text-xs text-muted-foreground">
              <Zap className="h-3 w-3" /> 4 steps
            </div>
            <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              From zero to operating in 90 seconds.
            </h2>
            <p className="mt-3 text-muted-foreground">
              No SDKs to install, no webhooks to wire. Connect, scan, operate.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            {WORKFLOW.map((w, i) => (
              <div key={w.num} className="relative rounded-xl border border-border bg-card/60 p-5">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-md bg-secondary px-2 py-0.5 font-mono">{w.num}</span>
                </div>
                <h3 className="mt-4 text-sm font-semibold">{w.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{w.body}</p>
                {i < WORKFLOW.length - 1 && (
                  <ArrowRight className="absolute -right-3 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-border lg:block" />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============= Architecture / Integration ============= */}
      <section className="relative overflow-hidden border-b border-border/60 bg-secondary/20 py-24">
        <GradientOrb className="absolute right-0 top-1/2 h-64 w-64" color="hsl(var(--primary-soft))" />
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
          <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
                <GitBranch className="h-3 w-3" /> Plugs in, doesn't replace
              </div>
              <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
                One source of truth, <span className="text-muted-foreground">zero data migration.</span>
              </h2>
              <p className="mt-4 text-muted-foreground">
                We connect to your existing Stripe, Supabase, GitHub. No data is copied. Pause sync at any time.
              </p>
              <ul className="mt-6 space-y-3 text-sm">
                {[
                  "Bi-directional sync on demand — push secrets back to Vercel / Supabase Secrets",
                  "Per-project Stripe, GitHub, Vercel keys — total isolation",
                  "Read-only by default. Admin actions require approval.",
                  "Cross-project rollups in Overview → Multi-projects",
                ].map((b) => (
                  <li key={b} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--accent-2))]" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl border border-border bg-card p-4 shadow-xl">
              <ArchitectureDiagram className="w-full" />
            </div>
          </div>
        </div>
      </section>

      {/* ============= Feature grid ============= */}
      <section className="border-b border-border/60 bg-background py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto mb-14 max-w-2xl text-center">
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Everything you'd build yourself,{" "}
              <span className="text-muted-foreground">already running</span>.
            </h2>
            <p className="mt-4 text-muted-foreground">
              Stop wiring Stripe to Supabase to Slack at 11pm. Connect once, get a full cockpit.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {FEATURE_CARDS.map((f) => {
              const Icon = f.icon;
              return (
                <div
                  key={f.title}
                  className="group relative overflow-hidden rounded-xl border border-border bg-card/50 p-5 transition-all hover:border-border hover:bg-card hover:shadow-xl"
                >
                  <div className="absolute -right-12 -top-12 h-32 w-32 rounded-full opacity-0 blur-3xl transition-opacity group-hover:opacity-30" style={{ background: f.color }} />
                  <div className="relative flex h-9 w-9 items-center justify-center rounded-md bg-secondary" style={{ color: f.color }}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <h3 className="relative mt-4 text-sm font-semibold">{f.title}</h3>
                  <p className="relative mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ============= Multi-tenant section ============= */}
      <section className="border-b border-border/60 bg-secondary/20 py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background px-3 py-1 text-xs text-muted-foreground">
                <Building2 className="h-3 w-3" />
                For agencies
              </div>
              <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
                Multi-tenant from day one.
              </h2>
              <p className="mt-4 text-muted-foreground">
                Every client lives in its own project with isolated data, credentials and audit
                logs. Invite stakeholders with granular roles. White-label support included on Pro.
              </p>
              <ul className="mt-6 space-y-3 text-sm">
                {[
                  "Switch projects without losing your context",
                  "Per-project Stripe, GitHub, Vercel… ",
                  "Approve admin actions before they run",
                  "Cross-project rollups in Overview → Multi-projects",
                ].map((b) => (
                  <li key={b} className="flex items-start gap-2">
                    <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--accent-2))]" />
                    {b}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl border border-border bg-card p-2 shadow-2xl">
              <div className="rounded-lg border border-border/60 bg-background p-6">
                <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Your clients</span>
                  <span>4 active</span>
                </div>
                <div className="space-y-3">
                  <ProjectRow name="acme-inc.com" mrr="€12,440" status="healthy" growth="+8%" />
                  <ProjectRow name="byte-studio" mrr="€7,180" status="warning" growth="+2%" />
                  <ProjectRow name="pixel-labs" mrr="€21,090" status="healthy" growth="+14%" />
                  <ProjectRow name="nordic-ops" mrr="€4,520" status="error" growth="-3%" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============= Funnel / journeys ============= */}
      <section className="border-b border-border/60 bg-background py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/40 px-3 py-1 text-xs text-muted-foreground">
              <TrendingUp className="h-3 w-3" /> Analytics that act
            </div>
            <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              See where users drop off. Then do something about it.
            </h2>
            <p className="mt-3 text-muted-foreground">
              Build funnels in seconds. Trigger emails, fire AI agents, or open a runbook — directly from the chart.
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card/60 p-6">
            <FlowDiagram className="w-full" />
          </div>
          <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              { icon: Users, label: "Cohorts & LTV", body: "Track every signup cohort for 12+ months." },
              { icon: Activity, label: "Real-time events", body: "Stream product events through your funnels." },
              { icon: Zap, label: "Trigger actions", body: "Email blast, send refund, open ticket — from the dropoff." },
            ].map((it) => {
              const I = it.icon;
              return (
                <div key={it.label} className="rounded-lg border border-border bg-card p-4">
                  <I className="h-4 w-4 text-[hsl(var(--primary-soft))]" />
                  <h4 className="mt-3 text-sm font-semibold">{it.label}</h4>
                  <p className="mt-1 text-xs text-muted-foreground">{it.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ============= Testimonials ============= */}
      <section className="border-b border-border/60 bg-secondary/20 py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Agencies love operating from FounderOS.
            </h2>
            <div className="mt-4 inline-flex items-center gap-1 text-sm text-muted-foreground">
              {[0, 1, 2, 3, 4].map((i) => (
                <Star key={i} className="h-3.5 w-3.5 fill-[hsl(var(--accent-2))] text-[hsl(var(--accent-2))]" />
              ))}
              <span className="ml-2">4.9 · 120+ teams using daily</span>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {TESTIMONIALS.map((t) => (
              <figure key={t.author} className="rounded-xl border border-border bg-card p-6">
                <Quote className="h-5 w-5 text-[hsl(var(--primary-soft))]" />
                <blockquote className="mt-4 text-sm leading-relaxed">"{t.quote}"</blockquote>
                <figcaption className="mt-4 border-t border-border/60 pt-4 text-xs">
                  <div className="font-semibold">{t.author}</div>
                  <div className="text-muted-foreground">{t.role}</div>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* ============= Security pillars ============= */}
      <section className="border-b border-border/60 bg-background py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/40 px-3 py-1 text-xs text-muted-foreground">
              <Lock className="h-3 w-3" /> Enterprise-grade by default
            </div>
            <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Security isn't a checkbox. It's the foundation.
            </h2>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {TRUST_PILLARS.map((p) => {
              const I = p.icon;
              return (
                <div key={p.title} className="flex gap-4 rounded-xl border border-border bg-card/60 p-5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-[hsl(var(--accent-2))]">
                    <I className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold">{p.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{p.body}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ============= FAQ ============= */}
      <section className="border-b border-border/60 bg-secondary/20 py-24">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h2 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
            Frequently asked questions
          </h2>
          <div className="mt-10 space-y-3">
            {FAQ.map((f) => (
              <details key={f.q} className="group rounded-xl border border-border bg-card/60 p-5 open:bg-card">
                <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">
                  {f.q}
                  <span className="ml-4 text-muted-foreground transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ============= Final CTA ============= */}
      <section className="relative overflow-hidden bg-background py-24">
        <DotGrid />
        <GradientOrb className="absolute -bottom-32 left-1/4 h-96 w-96" color="hsl(var(--primary-soft))" />
        <GradientOrb className="absolute -bottom-32 right-1/4 h-96 w-96" color="hsl(var(--accent-2))" />
        <div className="relative mx-auto max-w-3xl px-4 text-center sm:px-6">
          <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[hsl(var(--primary-soft))] to-[hsl(var(--accent-2))] shadow-lg">
            <Rocket className="h-6 w-6 text-white" />
          </div>
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Spin up your first cockpit in 90 seconds.
          </h2>
          <p className="mt-4 text-muted-foreground">
            Free plan covers up to 3 client projects with all integrations. No credit card.
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row">
            <Link
              to="/signup"
              className="group inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:opacity-90 sm:w-auto"
            >
              Get started
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              to="/pricing"
              className="inline-flex w-full items-center justify-center rounded-md border border-border bg-secondary/50 px-5 py-2.5 text-sm transition-colors hover:bg-secondary sm:w-auto"
            >
              See pricing
            </Link>
          </div>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-[hsl(var(--accent-2))]" /> No credit card</span>
            <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-[hsl(var(--accent-2))]" /> Unlimited team</span>
            <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-[hsl(var(--accent-2))]" /> Cancel anytime</span>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}

function ProjectRow({ name, mrr, status, growth }: { name: string; mrr: string; status: "healthy" | "warning" | "error"; growth: string }) {
  const dot = status === "healthy" ? "bg-[hsl(var(--accent-2))]" : status === "warning" ? "bg-amber-400" : "bg-destructive";
  const trend = growth.startsWith("+") ? "text-[hsl(var(--accent-2))]" : "text-destructive";
  return (
    <div className="flex items-center justify-between rounded-md border border-border/60 bg-secondary/30 px-3 py-2.5 transition-colors hover:bg-secondary/50">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="font-mono text-xs">{name}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className={`text-xs tabular-nums ${trend}`}>{growth}</span>
        <span className="text-xs tabular-nums text-foreground">{mrr}</span>
      </div>
    </div>
  );
}
