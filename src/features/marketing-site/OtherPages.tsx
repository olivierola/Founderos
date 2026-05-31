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
} from "lucide-react";
import { MarketingShell, DotGrid } from "./MarketingShell";
import { PROVIDERS } from "@/lib/providers";

/* ===================== Features Page ===================== */

const MODULES = [
  {
    icon: LayoutDashboard,
    name: "Overview",
    body: "Daily briefing, custom dashboards built from any table, cross-project rollups.",
  },
  {
    icon: Wallet,
    name: "Finance & Costs",
    body: "MRR, churn, cohorts, forecasting with best/base/worst. LLM spend, providers, budgets.",
  },
  {
    icon: ShieldCheck,
    name: "Admin panel",
    body: "Refund, reset password, ban user, run runbooks. Approvals with audit trail.",
  },
  {
    icon: Braces,
    name: "Code & Security",
    body: "Repo scan, dependencies, CVE alerts, secrets detection, compliance watch.",
  },
  {
    icon: Activity,
    name: "SaaS Analytics",
    body: "Per-user analytics, group analytics, journeys, cohorts, funnels, health scores.",
  },
  {
    icon: MessageSquareTextIcon,
    name: "RAG Agent",
    body: "Embeddable chat trained on your docs. Onboarding flows the AI drives live.",
  },
  {
    icon: Brain,
    name: "AI Agent",
    body: "Workflows, prompt templates, guardrails. Talk to the cockpit in natural language.",
  },
  {
    icon: Plug2,
    name: "Integrations",
    body: "50+ providers, encrypted vault, propagate secrets to Vercel / Supabase / Railway.",
  },
  {
    icon: Cog,
    name: "Settings",
    body: "Workspaces, projects, team roles, billing, 2FA, data & privacy.",
  },
];

function MessageSquareTextIcon(props: { className?: string }) {
  return <Sparkles {...props} />;
}

export function FeaturesPage() {
  return (
    <MarketingShell>
      <section className="relative border-b border-border/60">
        <DotGrid />
        <div className="relative mx-auto max-w-6xl px-4 py-20 text-center sm:px-6">
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Twelve modules. <span className="text-muted-foreground">One panel.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
            Every cockpit module replaces a tool your team already pays for. Connect once, surface
            everything through a single, opinionated UI.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => {
            const Icon = m.icon;
            return (
              <div
                key={m.name}
                className="rounded-xl border border-border bg-card/50 p-5 transition-colors hover:bg-card"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-secondary text-[hsl(var(--primary-soft))]">
                  <Icon className="h-4 w-4" />
                </div>
                <h3 className="mt-4 text-sm font-semibold">{m.name}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{m.body}</p>
              </div>
            );
          })}
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
    description: "Solo founders and tiny teams.",
    features: ["Up to 3 projects", "1 workspace", "All integrations", "Community support"],
    cta: "Start free",
    href: "/signup",
    highlight: false,
  },
  {
    name: "Pro",
    price: "€49",
    suffix: "/ month",
    description: "Agencies running several SaaS at once.",
    features: [
      "Up to 25 projects",
      "Unlimited team members",
      "Custom dashboards",
      "Admin actions + approvals",
      "Priority email support",
    ],
    cta: "Start 14-day trial",
    href: "/signup?plan=pro",
    highlight: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    suffix: "",
    description: "Compliance, SSO, dedicated support.",
    features: [
      "Unlimited projects",
      "SSO / SAML",
      "Audit log export",
      "SLA + 99.9% uptime",
      "Dedicated success engineer",
    ],
    cta: "Talk to sales",
    href: "/contact",
    highlight: false,
  },
];

export function PricingPage() {
  return (
    <MarketingShell>
      <section className="relative border-b border-border/60">
        <DotGrid />
        <div className="relative mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Simple pricing. <span className="text-muted-foreground">Built for agencies.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            One subscription, every client. No per-user tax, no integration fees.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {TIERS.map((t) => (
            <div
              key={t.name}
              className={
                "relative flex flex-col rounded-xl border p-6 " +
                (t.highlight
                  ? "border-[hsl(var(--primary-soft)/0.5)] bg-[hsl(var(--primary-soft)/0.05)] shadow-xl"
                  : "border-border bg-card/50")
              }
            >
              {t.highlight && (
                <span className="absolute right-4 top-4 rounded-full border border-[hsl(var(--primary-soft)/0.4)] bg-[hsl(var(--primary-soft)/0.12)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[hsl(var(--primary-soft))]">
                  Most popular
                </span>
              )}
              <div className="text-lg font-semibold">{t.name}</div>
              <div className="mt-1 text-sm text-muted-foreground">{t.description}</div>
              <div className="mt-5 flex items-end gap-1">
                <span className="text-4xl font-semibold tabular-nums">{t.price}</span>
                <span className="pb-1 text-sm text-muted-foreground">{t.suffix}</span>
              </div>
              <ul className="mt-6 space-y-2 text-sm">
                {t.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--accent-2))]" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                to={t.href}
                className={
                  "mt-6 inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition " +
                  (t.highlight
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "border border-border bg-secondary/40 hover:bg-secondary")
                }
              >
                {t.cta}
              </Link>
            </div>
          ))}
        </div>

        <p className="mt-10 text-center text-xs text-muted-foreground">
          Prices in EUR. Annual billing saves 20%. Need an invoice or PO? <Link to="/contact" className="underline">Contact us</Link>.
        </p>
      </section>
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

  return (
    <MarketingShell>
      <section className="relative border-b border-border/60">
        <DotGrid />
        <div className="relative mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            {PROVIDERS.length}+ providers.{" "}
            <span className="text-muted-foreground">All in one vault.</span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            Every integration ships with encryption, propagation and revocation built-in.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search providers…"
              className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
                className="flex items-start gap-3 rounded-lg border border-border bg-card/50 p-4 transition-colors hover:bg-card"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary">
                  <Icon className="h-4 w-4" />
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
      </section>
    </MarketingShell>
  );
}

/* ===================== Changelog Page ===================== */

const CHANGELOG = [
  {
    date: "2026-05-31",
    title: "Deployment sync — Supabase, Firebase, Fly, Heroku, Railway, DO, Hetzner",
    items: [
      "kind / duration_ms / author / commit_message as first-class columns",
      "Infra events from VPS providers as a separate kind",
      "Sparkline summary per provider with brand colors",
    ],
  },
  {
    date: "2026-05-30",
    title: "Vercel-style SparkChart + multi-provider deployments",
    items: [
      "New <SparkChart /> component (drop-in for any KPI sparkline)",
      "Sync deployments from Vercel, GitHub Actions, Netlify, Render, Cloudflare",
      "Per-deployment dialog with logs, commit, redirects",
    ],
  },
  {
    date: "2026-05-29",
    title: "Marketing site live + dashboard responsive overhaul",
    items: [
      "Public landing pages: Home, Features, Pricing, Integrations, Docs, Changelog, Contact",
      "Mobile-first dashboard: drawer sidebar, collapsing grids",
      "Toast system mounted globally",
    ],
  },
  {
    date: "2026-05-27",
    title: "SaaS Analytics module",
    items: [
      "Per-user analytics with timeline + LTV",
      "Group analytics by plan / billing / cohort",
      "Journeys: configurable funnel over activity_logs",
    ],
  },
];

export function ChangelogPage() {
  return (
    <MarketingShell>
      <section className="relative border-b border-border/60">
        <DotGrid />
        <div className="relative mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Changelog
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            What we ship, when. We push updates several times a week.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl space-y-10 px-4 py-16 sm:px-6">
        {CHANGELOG.map((c) => (
          <article key={c.date} className="border-l-2 border-border pl-6">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">{c.date}</div>
            <h2 className="mt-1 text-xl font-semibold">{c.title}</h2>
            <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
              {c.items.map((i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                  {i}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>
    </MarketingShell>
  );
}

/* ===================== Docs Page (placeholder) ===================== */

const DOC_SECTIONS = [
  {
    title: "Getting started",
    links: [
      { label: "Create your first workspace", to: "#" },
      { label: "Add a project", to: "#" },
      { label: "Connect Stripe", to: "#" },
      { label: "Invite your team", to: "#" },
    ],
  },
  {
    title: "Integrations",
    links: [
      { label: "Vercel", to: "#" },
      { label: "GitHub", to: "#" },
      { label: "Supabase", to: "#" },
      { label: "Connect a custom provider", to: "#" },
    ],
  },
  {
    title: "RAG Agent",
    links: [
      { label: "Train an agent on your docs", to: "#" },
      { label: "Embed the widget", to: "#" },
      { label: "Configure onboarding", to: "#" },
    ],
  },
  {
    title: "Admin actions",
    links: [
      { label: "Run an action", to: "#" },
      { label: "Approvals", to: "#" },
      { label: "Audit log", to: "#" },
    ],
  },
];

export function DocsPage() {
  return (
    <MarketingShell>
      <section className="relative border-b border-border/60">
        <DotGrid />
        <div className="relative mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Documentation
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            Pick a section to get started. We rewrite this every week as the product evolves.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {DOC_SECTIONS.map((s) => (
            <div key={s.title} className="rounded-xl border border-border bg-card/50 p-6">
              <h2 className="text-base font-semibold">{s.title}</h2>
              <ul className="mt-4 space-y-2 text-sm">
                {s.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.to}
                      className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {l.label}
                      <ExternalLink className="h-3 w-3 opacity-50" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 rounded-xl border border-dashed border-border bg-secondary/30 p-6 text-center text-sm text-muted-foreground">
          Docs are growing — for anything missing, ping us at{" "}
          <Link to="/contact" className="underline hover:text-foreground">
            /contact
          </Link>{" "}
          and we'll write it.
        </div>
      </section>
    </MarketingShell>
  );
}

/* ===================== Contact Page ===================== */

export function ContactPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !message.trim()) return;
    setStatus("sending");
    try {
      // No backend on the marketing form yet — open the user's mail client as
      // a safe fallback that always works.
      const body = encodeURIComponent(`${message}\n\n— ${name}`);
      window.location.href = `mailto:hello@founderos.dev?subject=Hello from ${encodeURIComponent(name)}&body=${body}`;
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  }

  return (
    <MarketingShell>
      <section className="relative border-b border-border/60">
        <DotGrid />
        <div className="relative mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Get in touch.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            Enterprise pricing, partnership, press — we read every message and reply in 24h.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-xl border border-border bg-card/50 p-6"
        >
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Your name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Message</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
              rows={6}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Mail className="h-3 w-3" />
              Or email <span className="font-mono">hello@founderos.dev</span>
            </div>
            <button
              type="submit"
              disabled={status === "sending"}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {status === "sending" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
              {status === "sent" ? "Mailto opened" : "Send message"}
            </button>
          </div>
        </form>
      </section>
    </MarketingShell>
  );
}

/* ===================== Shared CTA ===================== */

function CtaBlock() {
  return (
    <section className="border-t border-border/60 bg-background py-20">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <Rocket className="mx-auto h-7 w-7 text-[hsl(var(--accent-2))]" />
        <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Try it on a real project today.
        </h2>
        <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row">
          <Link
            to="/signup"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 sm:w-auto"
          >
            Start free <ArrowRight className="h-4 w-4" />
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
