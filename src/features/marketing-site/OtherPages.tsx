import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  ArrowRight,
  LayoutDashboard,
  Wallet,
  Braces,
  ShieldCheck,
  Brain,
  Plug2,
  Rocket,
  Sparkles,
  Activity,
  Cog,
  Loader2,
  Mail,
  ExternalLink,
  Search,
  MessageSquareText,
  Zap,
  BookOpen,
  PlayCircle,
  Phone,
  MapPin,
  Globe,
  Calendar,
  Star,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { MarketingShell, DotGrid } from "./MarketingShell";
import { GradientOrb } from "./Illustrations";
import { PROVIDERS } from "@/lib/providers";

/* ===================== Features Page ===================== */

const FEATURE_MODULES = [
  {
    icon: LayoutDashboard,
    color: "hsl(var(--primary-soft))",
    name: "Overview",
    tagline: "Your morning standup, automated.",
    body: "Daily AI briefing, custom dashboards from any table, cross-project rollups, activity feed.",
    bullets: ["Daily briefing AI", "Custom dashboards (80+ widgets)", "Activity feed across projects", "Multi-project rollup"],
  },
  {
    icon: Wallet,
    color: "hsl(var(--accent-2))",
    name: "Finance & Costs",
    tagline: "MRR, churn, forecasting — done.",
    body: "Real-time Stripe data, cohorts with retention curves, scenario forecasting, LLM spend tracking.",
    bullets: ["MRR/ARR trends", "Cohort retention", "Forecasting best/base/worst", "LLM cost per provider"],
  },
  {
    icon: ShieldCheck,
    color: "#a78bfa",
    name: "Admin panel",
    tagline: "Operate safely. Audit everything.",
    body: "Refund, reset password, ban user, run runbooks. Every action goes through approval and audit logs.",
    bullets: ["Refunds & cancellations", "User management actions", "Runbooks library", "Full audit trail"],
  },
  {
    icon: Braces,
    color: "#38bdf8",
    name: "Code & Security",
    tagline: "Scan, audit, comply.",
    body: "Repo scans, dependency CVEs, secrets detection, license audit, GDPR/SOC2 compliance watch.",
    bullets: ["Per-repo scans", "CVE alerts (NVD)", "Secret detection", "Compliance posture"],
  },
  {
    icon: Activity,
    color: "#34d399",
    name: "SaaS Analytics",
    tagline: "User behaviour, not vanity metrics.",
    body: "Per-user analytics, group/segment analytics, journeys, cohorts, funnels, churn risk scoring.",
    bullets: ["User 360 view", "Dynamic segments", "Journey funnels", "Churn risk scores"],
  },
  {
    icon: MessageSquareText,
    color: "#fbbf24",
    name: "RAG Agent",
    tagline: "AI support trained on your docs.",
    body: "Embeddable chat widget with onboarding flows the AI drives — highlights, popups, navigation, live.",
    bullets: ["Train on URLs / files / SaaS structure", "Live in-product onboarding", "Multi-language", "Analytics dashboard"],
  },
  {
    icon: Brain,
    color: "#f472b6",
    name: "AI Agent",
    tagline: "Talk to your cockpit.",
    body: "Natural-language workflows, prompt templates, guardrails. Insights surfaced automatically.",
    bullets: ["Chat with all your data", "Reusable prompt templates", "Workflows over time", "Guardrails by policy"],
  },
  {
    icon: Plug2,
    color: "#f6651a",
    name: "Integrations",
    tagline: "57 providers and counting.",
    body: "Encrypted vault, propagate secrets to Vercel / Supabase / Railway, sync deployments from 12+ hosts.",
    bullets: ["Vercel, GitHub, Stripe…", "Encrypted credentials vault", "Propagation to backends", "Sync deployments + logs"],
  },
  {
    icon: Cog,
    color: "#94a3b8",
    name: "Settings",
    tagline: "Workspaces, roles, billing — done right.",
    body: "Workspaces, projects, team roles, billing portal, 2FA, data export, granular permissions.",
    bullets: ["Workspaces + projects", "Granular roles", "2FA + SSO (Enterprise)", "Data export"],
  },
];

const COMPARISON = [
  { feature: "Stripe integration", us: true, others: true },
  { feature: "GitHub repo scans", us: true, others: false },
  { feature: "Real-time deployment sync", us: true, others: "partial" },
  { feature: "Multi-tenant by default", us: true, others: false },
  { feature: "Approval-gated admin actions", us: true, others: false },
  { feature: "AI agent for end users", us: true, others: false },
  { feature: "Dynamic onboarding via SDK", us: true, others: false },
  { feature: "57+ provider integrations", us: true, others: "partial" },
  { feature: "Encrypted secrets vault", us: true, others: "partial" },
  { feature: "Cross-project rollups", us: true, others: false },
];

export function FeaturesPage() {
  return (
    <MarketingShell>
      <section className="relative overflow-hidden border-b border-border/60">
        <DotGrid />
        <GradientOrb className="absolute -top-32 -left-32 h-96 w-96" color="hsl(var(--primary-soft))" />
        <div className="relative mx-auto max-w-6xl px-4 py-24 text-center sm:px-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-secondary/50 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
            <Sparkles className="h-3 w-3" /> 9 modules. 80+ pre-built widgets. Endless combinations.
          </div>
          <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
            Built for the <span className="bg-gradient-to-r from-[hsl(var(--primary-soft))] to-[hsl(var(--accent-2))] bg-clip-text text-transparent">whole agency stack</span>.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-muted-foreground sm:text-lg">
            Every cockpit module replaces a tool your team already pays for. Connect once, surface
            everything through a single, opinionated UI.
          </p>
        </div>
      </section>

      {/* Module deep dives */}
      <section className="bg-background py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {FEATURE_MODULES.map((m) => {
              const Icon = m.icon;
              return (
                <article
                  key={m.name}
                  className="group relative overflow-hidden rounded-xl border border-border bg-card/60 p-6 transition-all hover:border-border hover:bg-card hover:shadow-2xl"
                >
                  <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full opacity-0 blur-3xl transition-opacity group-hover:opacity-30" style={{ background: m.color }} />
                  <div className="relative flex items-start gap-4">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-secondary" style={{ color: m.color }}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-semibold">{m.name}</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">{m.tagline}</p>
                    </div>
                  </div>
                  <p className="relative mt-4 text-sm leading-relaxed text-muted-foreground">{m.body}</p>
                  <ul className="relative mt-4 grid grid-cols-2 gap-2 text-xs">
                    {m.bullets.map((b) => (
                      <li key={b} className="flex items-start gap-1.5">
                        <Check className="mt-0.5 h-3 w-3 shrink-0 text-[hsl(var(--accent-2))]" />
                        <span className="text-muted-foreground">{b}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section className="border-y border-border/60 bg-secondary/20 py-24">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          <div className="mx-auto mb-10 max-w-2xl text-center">
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              FounderOS vs. spreadsheets + Notion + 5 dashboards
            </h2>
            <p className="mt-3 text-muted-foreground">
              The honest comparison. We don't replace your IDE or your design tool — we replace the operational mess between them.
            </p>
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-secondary/30 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left">Capability</th>
                  <th className="px-4 py-3 text-center">FounderOS</th>
                  <th className="px-4 py-3 text-center">Others</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {COMPARISON.map((c) => (
                  <tr key={c.feature} className="hover:bg-secondary/30">
                    <td className="px-4 py-3">{c.feature}</td>
                    <td className="px-4 py-3 text-center">
                      {c.us === true ? <CheckCircle2 className="mx-auto h-5 w-5 text-[hsl(var(--accent-2))]" /> : "—"}
                    </td>
                    <td className="px-4 py-3 text-center text-xs">
                      {c.others === true ? (
                        <CheckCircle2 className="mx-auto h-5 w-5 text-muted-foreground" />
                      ) : c.others === "partial" ? (
                        <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-400">partial</span>
                      ) : (
                        <AlertCircle className="mx-auto h-4 w-4 text-muted-foreground/40" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <CtaBlock />
    </MarketingShell>
  );
}

/* ===================== Pricing Page ===================== */

const TIERS = [
  {
    name: "Free",
    price: "€0",
    suffix: "forever",
    description: "Solo founders and tiny teams getting started.",
    features: ["Up to 3 projects", "1 workspace", "All 57 integrations", "Community Discord support", "Encrypted vault", "Audit log (30 days)"],
    cta: "Start free",
    href: "/signup",
    highlight: false,
  },
  {
    name: "Pro",
    price: "€49",
    suffix: "/ month",
    description: "Agencies running several SaaS at once.",
    features: ["Up to 25 projects", "Unlimited team members", "Custom dashboards", "Admin actions + approvals", "Priority email support", "Audit log (1 year)", "White-label widgets", "14-day free trial"],
    cta: "Start 14-day trial",
    href: "/signup?plan=pro",
    highlight: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    suffix: "",
    description: "Compliance, SSO, dedicated support.",
    features: ["Unlimited projects", "SSO / SAML", "SCIM provisioning", "Audit log export", "SLA + 99.9% uptime", "Dedicated success engineer", "Custom contracts & DPA", "Onboarding workshop"],
    cta: "Talk to sales",
    href: "/contact",
    highlight: false,
  },
];

const COMPARE_MATRIX = [
  { feature: "Projects", free: "3", pro: "25", ent: "Unlimited" },
  { feature: "Team members", free: "Unlimited", pro: "Unlimited", ent: "Unlimited" },
  { feature: "Custom dashboards", free: "1", pro: "Unlimited", ent: "Unlimited" },
  { feature: "Audit log retention", free: "30 days", pro: "1 year", ent: "Forever + export" },
  { feature: "Approvals & RBAC", free: "—", pro: "✓", ent: "Advanced" },
  { feature: "SSO / SAML", free: "—", pro: "—", ent: "✓" },
  { feature: "SLA", free: "Best effort", pro: "99%", ent: "99.9%" },
  { feature: "Support", free: "Community", pro: "Email", ent: "Dedicated CSM" },
];

const PRICING_FAQ = [
  { q: "Can I change plans later?", a: "Yes, anytime. Upgrade unlocks features instantly; downgrade applies at the end of the billing period." },
  { q: "Do you offer non-profit pricing?", a: "Yes, 50% off Pro for verified non-profits. Email us with your proof." },
  { q: "What payment methods?", a: "Card via Stripe. Wire transfer + PO available on Enterprise." },
  { q: "Is there a free trial of Pro?", a: "Yes, 14 days, no credit card. Start from /signup." },
];

export function PricingPage() {
  const [annual, setAnnual] = useState(false);

  return (
    <MarketingShell>
      <section className="relative overflow-hidden border-b border-border/60">
        <DotGrid />
        <GradientOrb className="absolute top-0 left-1/2 h-96 w-96 -translate-x-1/2" color="hsl(var(--primary-soft))" />
        <div className="relative mx-auto max-w-3xl px-4 py-24 text-center sm:px-6">
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
            Simple pricing. <span className="bg-gradient-to-r from-[hsl(var(--primary-soft))] to-[hsl(var(--accent-2))] bg-clip-text text-transparent">Built for agencies.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-muted-foreground sm:text-lg">
            One subscription, every client. No per-user tax, no integration fees, no surprises.
          </p>

          {/* Annual toggle */}
          <div className="mt-8 inline-flex items-center gap-2 rounded-full border border-border bg-card p-1">
            <button
              onClick={() => setAnnual(false)}
              className={"rounded-full px-4 py-1.5 text-xs font-medium transition-colors " + (!annual ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
            >
              Monthly
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={"rounded-full px-4 py-1.5 text-xs font-medium transition-colors " + (annual ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
            >
              Annual <span className="ml-1 rounded bg-[hsl(var(--accent-2)/0.2)] px-1.5 py-0.5 text-[10px] text-[hsl(var(--accent-2))]">-20%</span>
            </button>
          </div>
        </div>
      </section>

      <section className="bg-background py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {TIERS.map((t) => {
              const monthlyPrice = t.name === "Pro" ? (annual ? "€39" : "€49") : t.price;
              return (
                <div
                  key={t.name}
                  className={
                    "relative flex flex-col rounded-2xl border p-6 transition-all " +
                    (t.highlight
                      ? "border-[hsl(var(--primary-soft)/0.5)] bg-gradient-to-b from-[hsl(var(--primary-soft)/0.08)] to-card shadow-2xl shadow-[hsl(var(--primary-soft)/0.1)]"
                      : "border-border bg-card/60 hover:bg-card")
                  }
                >
                  {t.highlight && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border border-[hsl(var(--primary-soft)/0.5)] bg-background px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--primary-soft))]">
                      Most popular
                    </span>
                  )}
                  <div className="text-lg font-semibold">{t.name}</div>
                  <div className="mt-1 text-sm text-muted-foreground">{t.description}</div>
                  <div className="mt-6 flex items-end gap-1">
                    <span className="text-4xl font-semibold tabular-nums">{monthlyPrice}</span>
                    <span className="pb-1 text-sm text-muted-foreground">{t.suffix}</span>
                  </div>
                  {annual && t.name === "Pro" && (
                    <div className="mt-1 text-xs text-[hsl(var(--accent-2))]">€468 billed annually</div>
                  )}
                  <ul className="mt-6 space-y-2.5 text-sm">
                    {t.features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--accent-2))]" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    to={t.href}
                    className={
                      "mt-8 inline-flex items-center justify-center rounded-md px-4 py-2.5 text-sm font-medium transition " +
                      (t.highlight
                        ? "bg-primary text-primary-foreground hover:opacity-90"
                        : "border border-border bg-secondary/40 hover:bg-secondary")
                    }
                  >
                    {t.cta}
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Comparison matrix */}
      <section className="border-t border-border/60 bg-secondary/20 py-24">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <h2 className="mb-8 text-center text-2xl font-semibold tracking-tight">Compare plans in detail</h2>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-secondary/30 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left">Feature</th>
                  <th className="px-4 py-3 text-center">Free</th>
                  <th className="px-4 py-3 text-center">Pro</th>
                  <th className="px-4 py-3 text-center">Enterprise</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {COMPARE_MATRIX.map((row) => (
                  <tr key={row.feature} className="hover:bg-secondary/30">
                    <td className="px-4 py-3 font-medium">{row.feature}</td>
                    <td className="px-4 py-3 text-center text-muted-foreground">{row.free}</td>
                    <td className="px-4 py-3 text-center font-medium">{row.pro}</td>
                    <td className="px-4 py-3 text-center text-muted-foreground">{row.ent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-border/60 bg-background py-24">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h2 className="text-center text-2xl font-semibold tracking-tight">Pricing FAQ</h2>
          <div className="mt-10 space-y-3">
            {PRICING_FAQ.map((f) => (
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

      <CtaBlock />
    </MarketingShell>
  );
}

/* ===================== Integrations Page ===================== */

export function IntegrationsPage() {
  const [search, setSearch] = useState("");
  const [activeCat, setActiveCat] = useState<string>("all");

  const cats = Array.from(new Set(PROVIDERS.map((p) => p.category)));
  const list = PROVIDERS.filter((p) => {
    if (activeCat !== "all" && p.category !== activeCat) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return p.name.toLowerCase().includes(q) || p.slug.includes(q);
  });

  const categoryCounts = cats.map((c) => ({ c, n: PROVIDERS.filter((p) => p.category === c).length }));

  return (
    <MarketingShell>
      <section className="relative overflow-hidden border-b border-border/60">
        <DotGrid />
        <GradientOrb className="absolute -top-32 right-0 h-96 w-96" color="hsl(var(--accent-2))" />
        <div className="relative mx-auto max-w-3xl px-4 py-24 text-center sm:px-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-secondary/50 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
            <Plug2 className="h-3 w-3" /> {PROVIDERS.length} integrations live · more weekly
          </div>
          <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
            All your tools, <span className="bg-gradient-to-r from-[hsl(var(--primary-soft))] to-[hsl(var(--accent-2))] bg-clip-text text-transparent">one vault</span>.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-muted-foreground sm:text-lg">
            Every integration ships with encryption, propagation and revocation built-in.
          </p>
        </div>
      </section>

      {/* Categories overview */}
      <section className="border-b border-border/60 bg-background py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {categoryCounts.map(({ c, n }) => (
              <button
                key={c}
                onClick={() => setActiveCat(c)}
                className={
                  "rounded-xl border p-4 text-left transition-all " +
                  (activeCat === c
                    ? "border-[hsl(var(--primary-soft)/0.5)] bg-[hsl(var(--primary-soft)/0.08)]"
                    : "border-border bg-card/60 hover:bg-card")
                }
              >
                <div className="text-xs uppercase tracking-wider text-muted-foreground">{c}</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">{n}</div>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-background py-12">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative max-w-sm flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search providers…"
                className="h-10 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setActiveCat("all")}
                className={
                  "rounded-full border px-2.5 py-1 text-xs transition " +
                  (activeCat === "all"
                    ? "border-[hsl(var(--primary-soft)/0.4)] bg-[hsl(var(--primary-soft)/0.12)] text-[hsl(var(--primary-soft))]"
                    : "border-border text-muted-foreground hover:bg-secondary")
                }
              >
                All
              </button>
              {cats.map((c) => (
                <button
                  key={c}
                  onClick={() => setActiveCat(c)}
                  className={
                    "rounded-full border px-2.5 py-1 text-xs transition " +
                    (activeCat === c
                      ? "border-[hsl(var(--primary-soft)/0.4)] bg-[hsl(var(--primary-soft)/0.12)] text-[hsl(var(--primary-soft))]"
                      : "border-border text-muted-foreground hover:bg-secondary")
                  }
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((p) => {
              const Icon = p.icon;
              return (
                <div
                  key={p.slug}
                  className="group flex items-start gap-3 rounded-xl border border-border bg-card/50 p-4 transition-all hover:border-border hover:bg-card hover:shadow-lg"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary transition-transform group-hover:scale-110">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{p.name}</span>
                      <span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        {p.category}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{p.description}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {list.length === 0 && (
            <p className="py-12 text-center text-sm text-muted-foreground">No match.</p>
          )}
        </div>
      </section>

      {/* Request integration CTA */}
      <section className="border-t border-border/60 bg-secondary/20 py-20">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
          <Plug2 className="mx-auto h-7 w-7 text-[hsl(var(--primary-soft))]" />
          <h2 className="mt-4 text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
            Need an integration we don't have yet?
          </h2>
          <p className="mt-3 text-muted-foreground">
            We ship 1-2 new providers every week. Tell us which one matters to you.
          </p>
          <Link
            to="/contact"
            className="mt-6 inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-4 py-2 text-sm hover:bg-secondary"
          >
            Request a provider <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </MarketingShell>
  );
}

/* ===================== Changelog Page ===================== */

const CHANGELOG = [
  {
    date: "2026-05-31",
    tag: "feature",
    title: "Deployment sync — Supabase, Firebase, Fly, Heroku, Railway, DO, Hetzner",
    items: ["kind / duration_ms / author / commit_message as first-class columns", "Infra events from VPS providers as a separate kind", "Sparkline summary per provider with brand colors"],
  },
  {
    date: "2026-05-30",
    tag: "feature",
    title: "Vercel-style SparkChart + multi-provider deployments",
    items: ["New <SparkChart /> component (drop-in for any KPI sparkline)", "Sync deployments from Vercel, GitHub Actions, Netlify, Render, Cloudflare", "Per-deployment dialog with logs, commit, redirects"],
  },
  {
    date: "2026-05-29",
    tag: "release",
    title: "Marketing site live + dashboard responsive overhaul",
    items: ["Public landing pages: Home, Features, Pricing, Integrations, Docs, Changelog, Contact", "Mobile-first dashboard: drawer sidebar, collapsing grids", "Toast system mounted globally"],
  },
  {
    date: "2026-05-27",
    tag: "feature",
    title: "SaaS Analytics module",
    items: ["Per-user analytics with timeline + LTV", "Group analytics by plan / billing / cohort", "Journeys: configurable funnel over activity_logs"],
  },
  {
    date: "2026-05-25",
    tag: "fix",
    title: "Credentials vault — surface secrets from connected providers",
    items: ["Every catalog connector's secret fields now appear in the vault", "Push from vault → backend in one click"],
  },
  {
    date: "2026-05-22",
    tag: "release",
    title: "Onboarding module for RAG agents",
    items: ["Flows, tours, checklists, analytics", "Dynamic onboarding with highlight + popup + navigate actions", "Embeddable SDK"],
  },
];

const TAG_STYLE: Record<string, string> = {
  feature: "border-[hsl(var(--primary-soft)/0.4)] bg-[hsl(var(--primary-soft)/0.12)] text-[hsl(var(--primary-soft))]",
  fix: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  release: "border-[hsl(var(--accent-2)/0.4)] bg-[hsl(var(--accent-2)/0.12)] text-[hsl(var(--accent-2))]",
};

export function ChangelogPage() {
  return (
    <MarketingShell>
      <section className="relative overflow-hidden border-b border-border/60">
        <DotGrid />
        <GradientOrb className="absolute top-0 left-0 h-72 w-72" color="hsl(var(--primary-soft))" />
        <div className="relative mx-auto max-w-3xl px-4 py-24 text-center sm:px-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-secondary/50 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
            <Zap className="h-3 w-3" /> Ship cycles: multiple per week
          </div>
          <h1 className="mt-6 text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
            Changelog
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-muted-foreground sm:text-lg">
            What we ship, when. We push updates several times a week.
          </p>
        </div>
      </section>

      <section className="bg-background py-16">
        <div className="mx-auto max-w-3xl space-y-6 px-4 sm:px-6">
          {CHANGELOG.map((c) => (
            <article key={c.date + c.title} className="relative rounded-xl border border-border bg-card/60 p-6">
              <div className="flex items-center gap-3">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">{c.date}</span>
                <span className={"rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider " + (TAG_STYLE[c.tag] ?? "")}>
                  {c.tag}
                </span>
              </div>
              <h2 className="mt-3 text-lg font-semibold">{c.title}</h2>
              <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
                {c.items.map((i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[hsl(var(--primary-soft))]" />
                    {i}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="border-t border-border/60 bg-secondary/20 py-16">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
          <Mail className="mx-auto h-6 w-6 text-[hsl(var(--accent-2))]" />
          <h2 className="mt-3 text-xl font-semibold">Subscribe to release notes</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Get a monthly digest in your inbox. No spam, unsubscribe anytime.
          </p>
          <form className="mx-auto mt-5 flex max-w-sm gap-2">
            <input
              type="email"
              placeholder="you@agency.com"
              className="h-10 flex-1 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button className="rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">
              Subscribe
            </button>
          </form>
        </div>
      </section>
    </MarketingShell>
  );
}

/* ===================== Docs Page ===================== */

const DOC_SECTIONS = [
  { icon: Rocket, color: "hsl(var(--primary-soft))", title: "Getting started", links: ["Create your first workspace", "Add a project", "Connect Stripe", "Invite your team"] },
  { icon: Plug2, color: "#f6651a", title: "Integrations", links: ["Vercel", "GitHub", "Supabase", "Connect a custom provider"] },
  { icon: MessageSquareText, color: "#fbbf24", title: "RAG Agent", links: ["Train an agent on your docs", "Embed the widget", "Configure onboarding"] },
  { icon: ShieldCheck, color: "#a78bfa", title: "Admin actions", links: ["Run an action", "Approvals", "Audit log"] },
  { icon: Wallet, color: "hsl(var(--accent-2))", title: "Finance", links: ["Sync Stripe", "Configure cohorts", "Forecasting scenarios"] },
  { icon: Activity, color: "#34d399", title: "Analytics", links: ["Build a dashboard", "Add custom widgets", "Cross-project rollups"] },
];

const DOC_QUICK = [
  { icon: PlayCircle, label: "Watch 5-min product tour", body: "See the cockpit end-to-end." },
  { icon: BookOpen, label: "Read the architecture guide", body: "Understand multi-tenant scoping." },
  { icon: Sparkles, label: "Browse 80+ widget recipes", body: "Copy-paste configs for common KPIs." },
];

export function DocsPage() {
  return (
    <MarketingShell>
      <section className="relative overflow-hidden border-b border-border/60">
        <DotGrid />
        <GradientOrb className="absolute top-0 left-1/2 h-72 w-72 -translate-x-1/2" color="hsl(var(--primary-soft))" />
        <div className="relative mx-auto max-w-3xl px-4 py-24 text-center sm:px-6">
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
            Documentation
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-muted-foreground sm:text-lg">
            Pick a section to get started. We rewrite this every week as the product evolves.
          </p>
          <div className="relative mx-auto mt-8 max-w-xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              placeholder="Search docs…"
              className="h-11 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      </section>

      {/* Quick links */}
      <section className="border-b border-border/60 bg-background py-12">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {DOC_QUICK.map((q) => {
              const I = q.icon;
              return (
                <div key={q.label} className="flex items-start gap-3 rounded-xl border border-border bg-card/60 p-4">
                  <I className="h-5 w-5 shrink-0 text-[hsl(var(--primary-soft))]" />
                  <div>
                    <div className="text-sm font-medium">{q.label}</div>
                    <div className="text-xs text-muted-foreground">{q.body}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Sections grid */}
      <section className="bg-background py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {DOC_SECTIONS.map((s) => {
              const Icon = s.icon;
              return (
                <div key={s.title} className="rounded-xl border border-border bg-card/60 p-6 transition-colors hover:bg-card">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary" style={{ color: s.color }}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <h2 className="mt-4 text-base font-semibold">{s.title}</h2>
                  <ul className="mt-3 space-y-1.5 text-sm">
                    {s.links.map((l) => (
                      <li key={l}>
                        <a href="#" className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground">
                          {l}
                          <ExternalLink className="h-3 w-3 opacity-50" />
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>

          <div className="mt-10 rounded-xl border border-dashed border-border bg-secondary/30 p-6 text-center text-sm text-muted-foreground">
            Docs are growing — for anything missing, ping us at{" "}
            <Link to="/contact" className="underline hover:text-foreground">/contact</Link>{" "}
            and we'll write it.
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}

/* ===================== Contact Page ===================== */

const CONTACT_REASONS = [
  { value: "sales", label: "Talk to sales / Enterprise" },
  { value: "support", label: "Product support" },
  { value: "partnership", label: "Partnership" },
  { value: "press", label: "Press / media" },
  { value: "other", label: "Other" },
];

const OFFICES = [
  { city: "Paris", country: "France", icon: MapPin },
  { city: "Lisbon", country: "Portugal", icon: MapPin },
  { city: "Remote-first", country: "Worldwide", icon: Globe },
];

export function ContactPage() {
  const [reason, setReason] = useState("sales");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !message.trim()) return;
    setStatus("sending");
    try {
      const body = encodeURIComponent(`Reason: ${reason}\nCompany: ${company}\n\n${message}\n\n— ${name}`);
      window.location.href = `mailto:hello@founderos.dev?subject=Hello from ${encodeURIComponent(name)}&body=${body}`;
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  }

  return (
    <MarketingShell>
      <section className="relative overflow-hidden border-b border-border/60">
        <DotGrid />
        <GradientOrb className="absolute -top-32 -right-32 h-96 w-96" color="hsl(var(--accent-2))" />
        <div className="relative mx-auto max-w-3xl px-4 py-24 text-center sm:px-6">
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
            Get in touch.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-muted-foreground sm:text-lg">
            Enterprise pricing, partnership, press — we read every message and reply in 24h.
          </p>
        </div>
      </section>

      <section className="bg-background py-16">
        <div className="mx-auto grid max-w-5xl gap-8 px-4 sm:px-6 lg:grid-cols-[1fr_320px]">
          <form onSubmit={handleSubmit} className="space-y-5 rounded-2xl border border-border bg-card/60 p-6 sm:p-8">
            <div>
              <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                I'm reaching out about
              </label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {CONTACT_REASONS.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => setReason(r.value)}
                    className={
                      "rounded-md border px-3 py-2 text-xs transition " +
                      (reason === r.value
                        ? "border-[hsl(var(--primary-soft)/0.5)] bg-[hsl(var(--primary-soft)/0.1)] text-[hsl(var(--primary-soft))]"
                        : "border-border text-muted-foreground hover:bg-secondary")
                    }
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs text-muted-foreground">Your name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs text-muted-foreground">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground">Company (optional)</label>
              <input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground">Message</label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
                rows={6}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <button
              type="submit"
              disabled={status === "sending"}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {status === "sending" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              {status === "sent" ? "Mailto opened" : "Send message"}
            </button>
          </form>

          <aside className="space-y-6">
            <div className="rounded-2xl border border-border bg-card/60 p-6">
              <h3 className="text-sm font-semibold">Reach us directly</h3>
              <ul className="mt-4 space-y-3 text-sm">
                <li className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span className="font-mono text-xs">hello@founderos.dev</span>
                </li>
                <li className="flex items-center gap-2">
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <span className="font-mono text-xs">+33 1 23 45 67 89</span>
                </li>
                <li className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <a href="#" className="text-xs underline">Book a demo</a>
                </li>
              </ul>
            </div>

            <div className="rounded-2xl border border-border bg-card/60 p-6">
              <h3 className="text-sm font-semibold">Where we are</h3>
              <ul className="mt-4 space-y-3 text-sm">
                {OFFICES.map((o) => {
                  const I = o.icon;
                  return (
                    <li key={o.city} className="flex items-center gap-2">
                      <I className="h-4 w-4 text-muted-foreground" />
                      <span>
                        <strong>{o.city}</strong>
                        <span className="text-muted-foreground"> · {o.country}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="rounded-2xl border border-border bg-gradient-to-br from-[hsl(var(--primary-soft)/0.08)] to-card p-6">
              <Star className="h-5 w-5 text-[hsl(var(--accent-2))]" />
              <p className="mt-3 text-sm">
                "Customer success replies within 4 hours during EU business days."
              </p>
            </div>
          </aside>
        </div>
      </section>
    </MarketingShell>
  );
}

/* ===================== Shared CTA ===================== */

function CtaBlock() {
  return (
    <section className="relative overflow-hidden border-t border-border/60 bg-background py-24">
      <DotGrid />
      <GradientOrb className="absolute -bottom-32 left-1/2 h-96 w-96 -translate-x-1/2" color="hsl(var(--primary-soft))" />
      <div className="relative mx-auto max-w-3xl px-4 text-center sm:px-6">
        <Rocket className="mx-auto h-7 w-7 text-[hsl(var(--accent-2))]" />
        <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Try it on a real project today.
        </h2>
        <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row">
          <Link
            to="/signup"
            className="group inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 sm:w-auto"
          >
            Start free <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link
            to="/contact"
            className="inline-flex w-full items-center justify-center rounded-md border border-border bg-secondary/50 px-5 py-2.5 text-sm hover:bg-secondary sm:w-auto"
          >
            Book a demo
          </Link>
        </div>
      </div>
    </section>
  );
}
