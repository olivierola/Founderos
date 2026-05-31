import { Link } from "react-router-dom";
import {
  ArrowRight,
  Layers,
  Wallet,
  ShieldCheck,
  Plug2,
  Sparkles,
  Activity,
  Lock,
  Quote,
  Star,
  Eye,
  Database,
  GitBranch,
  Zap,
  Building2,
  Brain,
} from "lucide-react";
import { MarketingShell, DotGrid } from "./MarketingShell";
import { CockpitMockup, ArchitectureDiagram } from "./Illustrations";

const STATS = [
  { value: "57", label: "Integrations" },
  { value: "12", label: "Modules" },
  { value: "80+", label: "Widgets" },
  { value: "100ms", label: "Edge p50" },
];

const LOGOS = [
  "Stripe", "Vercel", "GitHub", "Supabase", "Linear", "Resend",
  "Slack", "PostHog", "Sentry", "Cloudflare", "Fly.io", "Netlify",
  "Railway", "Heroku", "Firebase", "Datadog", "Mixpanel", "Segment",
];

const FEATURE_CARDS = [
  { icon: Layers, color: "hsl(var(--primary-soft))", title: "One cockpit per client", body: "Switch between every client's SaaS in two clicks. Each project gets isolated metrics, secrets and actions." },
  { icon: Wallet, color: "hsl(var(--accent-2))", title: "Money, infra, ops — together", body: "Stripe MRR, Vercel deploys, Supabase secrets, GitHub scans. One pane of glass, zero context switching." },
  { icon: ShieldCheck, color: "#a78bfa", title: "Admin with audit trail", body: "Refund a customer, rotate a key, kick a deploy. Every action is logged and approval-gated." },
  { icon: Sparkles, color: "#fbbf24", title: "AI agents for your clients", body: "RAG-powered widgets and dynamic onboarding the agent drives — highlights, popups, navigation, live." },
  { icon: Activity, color: "#34d399", title: "Real deployments, real logs", body: "Synced from Vercel, GitHub Actions, Netlify, Fly, Heroku, Supabase, Firebase, Render and bare-metal VPS." },
  { icon: Plug2, color: "#f472b6", title: "57 providers — and your own DB", body: "Query the client's Supabase project directly. Build custom dashboards from any table." },
];

const TRUST_PILLARS = [
  { icon: Lock, title: "AES-GCM 256-bit", body: "Every credential is encrypted at rest. Plaintext is never returned to the browser." },
  { icon: ShieldCheck, title: "Row-level security", body: "Supabase RLS enforces project isolation. Workspace members only see what they own." },
  { icon: Eye, title: "Full audit log", body: "Every refund, key rotation, deployment is timestamped, attributed, and exportable." },
  { icon: Database, title: "Your data, your stack", body: "We connect to your databases, never copy them. Pause sync at any time." },
];

const TESTIMONIALS = [
  { quote: "We replaced 6 dashboards with FounderOS. Refunds that used to take 3 days now take 30 seconds.", author: "Léa Vermont", role: "CTO, Frictionless Studio" },
  { quote: "The audit log alone is worth the price. We finally pass SOC2 reviews without spreadsheets.", author: "Marcus Tan", role: "Founder, Tan & Co" },
  { quote: "Our junior devs ship admin tools through approval flows instead of running scripts in prod.", author: "Aïcha Diallo", role: "Head of Eng, Loom Agency" },
];

const FAQ = [
  { q: "Do I host my customers' data?", a: "No. FounderOS connects to your customers' existing Stripe, Supabase, GitHub. We store metadata and encrypted credentials, never their raw user data." },
  { q: "Can I white-label the cockpit for my clients?", a: "Pro and Enterprise plans support custom branding. Full white-label with custom email senders is on Enterprise." },
  { q: "What about SSO and SCIM?", a: "SSO via SAML and SCIM provisioning are included on Enterprise. Free and Pro use email + 2FA." },
  { q: "How fast are updates?", a: "We ship multiple times a week. Every release is documented in /changelog." },
  { q: "Can I self-host?", a: "Not yet. We're working on a self-hosted edition for Enterprise. Contact us for the roadmap." },
];

export function HomePage() {
  return (
    <MarketingShell>
      {/* ====== Hero — épuré, pas d'orbs ====== */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 opacity-40">
          <DotGrid />
        </div>
        <div className="relative mx-auto max-w-5xl px-4 pb-12 pt-20 sm:px-6 lg:pb-16 lg:pt-28">
          <div className="max-w-3xl">
            <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-secondary/40 px-3 py-1 text-xs text-muted-foreground">
              <Building2 className="h-3 w-3" />
              For technical agencies
            </span>
            <h1 className="mt-6 text-balance text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
              The cockpit agencies run on.
            </h1>
            <p className="mt-6 max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
              Manage every client SaaS from one panel — billing, infra, deploys, secrets, support
              and AI agents. Replace 12 dashboards with one.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-2">
              <Link
                to="/signup"
                className="group inline-flex items-center gap-1.5 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                Start free
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                to="/features"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/60 px-5 py-2.5 text-sm transition-colors hover:bg-secondary"
              >
                See features
              </Link>
              <span className="ml-1 text-xs text-muted-foreground">
                No credit card · 14-day Pro trial
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ====== Cockpit mockup débordant + stats embedded ====== */}
      <section className="relative">
        <div className="mx-auto max-w-7xl px-4 pb-24 sm:px-6">
          <div className="grid items-end gap-6 lg:grid-cols-[1.5fr_1fr]">
            <div className="relative">
              <div className="absolute -inset-4 -z-10 rounded-3xl bg-gradient-to-tr from-[hsl(var(--primary-soft)/0.15)] via-transparent to-[hsl(var(--accent-2)/0.15)] blur-3xl" />
              <CockpitMockup className="w-full rounded-xl border border-border bg-card shadow-2xl mkt-rise" />
            </div>
            <div className="space-y-3">
              {STATS.map((s) => (
                <div key={s.label} className="rounded-xl border border-border bg-card/60 p-4">
                  <div className="text-3xl font-semibold tabular-nums">{s.value}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ====== Logo marquee — pas de section delimit. ====== */}
      <div className="overflow-hidden border-y border-border/40 bg-card/40 py-8">
        <p className="mb-5 text-center text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Plugs into the tools your clients already use
        </p>
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
      </div>

      {/* ====== Architecture — split asymétrique, pas de fond séparé ====== */}
      <section className="relative mx-auto max-w-7xl px-4 py-24 sm:px-6">
        <div className="grid items-start gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Plugs in. Doesn't replace.
            </h2>
            <p className="mt-4 max-w-md text-muted-foreground">
              We connect to your existing Stripe, Supabase, GitHub. No data is copied. Pause sync at any time.
            </p>
            <ul className="mt-8 space-y-4 text-sm">
              {[
                { icon: GitBranch, t: "Per-project isolation", b: "Each client gets its own Stripe, GitHub, Vercel keys." },
                { icon: Zap, t: "Bi-directional sync", b: "Push secrets back to Vercel / Supabase Secrets on demand." },
                { icon: ShieldCheck, t: "Read-only by default", b: "Admin actions require approval and are audit-logged." },
                { icon: Layers, t: "Cross-project rollups", b: "Aggregate MRR, churn, deploys across all clients." },
              ].map((it) => {
                const I = it.icon;
                return (
                  <li key={it.t} className="flex gap-3">
                    <I className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--accent-2))]" />
                    <div>
                      <div className="font-medium">{it.t}</div>
                      <div className="text-muted-foreground">{it.b}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="lg:col-span-7">
            <div className="rounded-xl border border-border bg-card p-4 shadow-lg sm:p-6">
              <ArchitectureDiagram className="w-full" />
            </div>
          </div>
        </div>
      </section>

      {/* ====== Multi-tenant + Workflow imbriqué (sans rupture) ====== */}
      <section className="relative mx-auto max-w-7xl px-4 pb-24 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-12">
          {/* Workflow */}
          <div className="lg:col-span-7">
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              From zero to operating in 90 seconds.
            </h2>
            <p className="mt-3 max-w-xl text-muted-foreground">
              No SDKs to install, no webhooks to wire. Connect, scan, operate.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {[
                { num: "01", title: "Connect your stack", body: "57 providers. Encrypted vault. No plaintext leaves the browser." },
                { num: "02", title: "Scan & understand", body: "Detect services, dependencies, env vars. Build a semantic map." },
                { num: "03", title: "Operate from one cockpit", body: "MRR, deploys, alerts — actionable in two clicks." },
                { num: "04", title: "Automate & onboard", body: "AI agents drive support and user onboarding live." },
              ].map((w) => (
                <div key={w.num} className="rounded-xl border border-border bg-card/60 p-5">
                  <span className="font-mono text-xs text-muted-foreground">{w.num}</span>
                  <h3 className="mt-2 text-sm font-semibold">{w.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{w.body}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Project list card collée à droite */}
          <div className="lg:col-span-5">
            <div className="sticky top-24 rounded-xl border border-border bg-card p-2 shadow-xl">
              <div className="rounded-lg border border-border/60 bg-background p-5">
                <div className="mb-4 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Your clients</span>
                  <span className="rounded-full bg-[hsl(var(--accent-2)/0.15)] px-2 py-0.5 text-[hsl(var(--accent-2))]">4 active</span>
                </div>
                <div className="space-y-2.5">
                  <ProjectRow name="acme-inc.com" mrr="€12,440" status="healthy" growth="+8%" />
                  <ProjectRow name="byte-studio" mrr="€7,180" status="warning" growth="+2%" />
                  <ProjectRow name="pixel-labs" mrr="€21,090" status="healthy" growth="+14%" />
                  <ProjectRow name="nordic-ops" mrr="€4,520" status="error" growth="-3%" />
                </div>
                <div className="mt-4 border-t border-border/60 pt-4 text-xs">
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Total MRR</span>
                    <span className="font-mono text-foreground">€45,230</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-muted-foreground">
                    <span>Avg growth</span>
                    <span className="text-[hsl(var(--accent-2))]">+5.3%</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ====== Features — grille non-bordée, fond uniforme ====== */}
      <section className="relative mx-auto max-w-7xl px-4 pb-24 sm:px-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Everything you'd build yourself, already running.
          </h2>
          <Link to="/features" className="text-sm text-muted-foreground hover:text-foreground">
            All 12 modules →
          </Link>
        </div>
        <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {FEATURE_CARDS.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="group relative overflow-hidden rounded-xl border border-border bg-card/50 p-5 transition-all hover:bg-card hover:shadow-lg"
              >
                <div className="absolute -right-12 -top-12 h-32 w-32 rounded-full opacity-0 blur-3xl transition-opacity group-hover:opacity-25" style={{ background: f.color }} />
                <div className="relative flex h-9 w-9 items-center justify-center rounded-md bg-secondary" style={{ color: f.color }}>
                  <Icon className="h-4 w-4" />
                </div>
                <h3 className="relative mt-4 text-sm font-semibold">{f.title}</h3>
                <p className="relative mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* ====== Bande citation + sécurité imbriquée ====== */}
      <section className="relative mx-auto max-w-7xl px-4 pb-24 sm:px-6">
        <div className="grid gap-6 lg:grid-cols-12">
          {/* Citation principale */}
          <figure className="lg:col-span-7 rounded-2xl border border-border bg-card p-8">
            <Quote className="h-6 w-6 text-[hsl(var(--primary-soft))]" />
            <blockquote className="mt-4 text-xl font-medium leading-relaxed">
              "We replaced 6 dashboards with FounderOS. Refunds that used to take 3 days now take 30 seconds. The audit log alone is worth it."
            </blockquote>
            <figcaption className="mt-6 flex items-center gap-3 text-sm">
              <div className="h-10 w-10 rounded-full bg-gradient-to-br from-[hsl(var(--primary-soft))] to-[hsl(var(--accent-2))]" />
              <div>
                <div className="font-semibold">Léa Vermont</div>
                <div className="text-muted-foreground">CTO, Frictionless Studio</div>
              </div>
              <div className="ml-auto flex items-center gap-0.5">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Star key={i} className="h-3.5 w-3.5 fill-[hsl(var(--accent-2))] text-[hsl(var(--accent-2))]" />
                ))}
              </div>
            </figcaption>
          </figure>

          {/* Citations courtes */}
          <div className="lg:col-span-5 space-y-3">
            {TESTIMONIALS.slice(1).map((t) => (
              <figure key={t.author} className="rounded-xl border border-border bg-card/60 p-5">
                <blockquote className="text-sm leading-relaxed">"{t.quote}"</blockquote>
                <figcaption className="mt-3 text-xs">
                  <span className="font-semibold">{t.author}</span>
                  <span className="text-muted-foreground"> · {t.role}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>

        {/* Trust pillars — directement collés en dessous, pas de séparation */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {TRUST_PILLARS.map((p) => {
            const I = p.icon;
            return (
              <div key={p.title} className="rounded-xl border border-border bg-card/40 p-4">
                <I className="h-4 w-4 text-[hsl(var(--accent-2))]" />
                <div className="mt-3 text-xs font-semibold">{p.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">{p.body}</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ====== FAQ + CTA fusionnés ====== */}
      <section className="relative mx-auto max-w-7xl px-4 pb-24 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Questions, answered.
            </h2>
            <div className="mt-8 space-y-2">
              {FAQ.map((f) => (
                <details key={f.q} className="group rounded-xl border border-border bg-card/40 p-5 open:bg-card">
                  <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">
                    {f.q}
                    <span className="ml-4 text-muted-foreground transition-transform group-open:rotate-45">+</span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
                </details>
              ))}
            </div>
          </div>

          {/* CTA latéral */}
          <div className="lg:col-span-5">
            <div className="sticky top-24 overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-card via-card to-[hsl(var(--primary-soft)/0.08)] p-8">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-[hsl(var(--primary-soft))] to-[hsl(var(--accent-2))]">
                <Brain className="h-5 w-5 text-white" />
              </div>
              <h3 className="mt-5 text-2xl font-semibold leading-tight">
                Try it on a real project today.
              </h3>
              <p className="mt-3 text-sm text-muted-foreground">
                Free plan covers up to 3 client projects with all integrations. No credit card.
              </p>
              <div className="mt-6 flex flex-col gap-2">
                <Link
                  to="/signup"
                  className="group inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  Get started
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
                <Link
                  to="/pricing"
                  className="inline-flex items-center justify-center rounded-md border border-border bg-card px-5 py-2.5 text-sm hover:bg-secondary"
                >
                  See pricing
                </Link>
              </div>
            </div>
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
