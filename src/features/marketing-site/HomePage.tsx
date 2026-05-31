import { Link } from "react-router-dom";
import {
  ArrowRight,
  Layers,
  Wallet,
  ShieldCheck,
  Plug2,
  Sparkles,
  Activity,
  MessageSquareText,
  GitBranch,
  Building2,
} from "lucide-react";
import { MarketingShell, DotGrid } from "./MarketingShell";

const FEATURE_CARDS = [
  {
    icon: Layers,
    title: "One cockpit per client",
    body:
      "Switch between every client's SaaS in two clicks. Each project gets isolated metrics, secrets and actions.",
  },
  {
    icon: Wallet,
    title: "Money, infra, ops — together",
    body:
      "Stripe MRR, Vercel deploys, Supabase secrets, GitHub scans. One pane of glass, zero context switching.",
  },
  {
    icon: ShieldCheck,
    title: "Admin actions with audit trail",
    body:
      "Refund a customer, rotate a key, kick a deploy. Every action is logged and approval-gated.",
  },
  {
    icon: Sparkles,
    title: "AI agents shipped to your clients",
    body:
      "RAG-powered widgets and dynamic onboarding the agent drives — highlights, popups, navigation, live.",
  },
  {
    icon: Activity,
    title: "Real deployments, real logs",
    body:
      "Synced from Vercel, GitHub Actions, Netlify, Fly, Heroku, Supabase, Firebase, Render and bare-metal VPS.",
  },
  {
    icon: Plug2,
    title: "50+ providers — and your own DB",
    body:
      "Query the client's Supabase project directly. Build custom dashboards from any table.",
  },
];

const STATS = [
  { value: "50+", label: "Provider integrations" },
  { value: "12+", label: "Cockpit modules" },
  { value: "80+", label: "Pre-built widgets" },
  { value: "100ms", label: "Edge response p50" },
];

const LOGOS = [
  "Stripe", "Vercel", "GitHub", "Supabase", "Vercel", "Resend",
  "Slack", "Linear", "PostHog", "Sentry", "Cloudflare", "Fly.io",
];

export function HomePage() {
  return (
    <MarketingShell>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border/60">
        <DotGrid />
        <div className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-28">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border/60 bg-secondary/50 px-3 py-1 text-xs text-muted-foreground">
              <Building2 className="h-3 w-3" />
              Built for technical agencies
            </div>
            <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
              The cockpit{" "}
              <span className="bg-gradient-to-r from-[hsl(var(--primary-soft))] to-[hsl(var(--accent-2))] bg-clip-text text-transparent">
                agencies run on
              </span>
              .
            </h1>
            <p className="mt-5 text-pretty text-base text-muted-foreground sm:text-lg">
              Manage every client SaaS from one panel — billing, infra, deploys, secrets, support
              and AI agents. Replace 12 dashboards with one.
            </p>
            <div className="mt-7 flex flex-col items-center justify-center gap-2 sm:flex-row">
              <Link
                to="/signup"
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 sm:w-auto"
              >
                Start free — no card <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/features"
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-secondary/50 px-5 py-2.5 text-sm transition-colors hover:bg-secondary sm:w-auto"
              >
                See features
              </Link>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Unlimited team members on the Free plan. 14-day Pro trial.
            </p>
          </div>

          {/* Stats strip */}
          <div className="mx-auto mt-16 grid max-w-3xl grid-cols-2 gap-4 sm:grid-cols-4">
            {STATS.map((s) => (
              <div key={s.label} className="rounded-lg border border-border bg-card/60 p-4 text-center">
                <div className="text-2xl font-semibold tabular-nums">{s.value}</div>
                <div className="mt-1 text-xs text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Logos strip */}
      <section className="border-b border-border/60 bg-background py-10">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <p className="text-center text-xs uppercase tracking-wider text-muted-foreground">
            Plugs into the tools your clients already use
          </p>
          <div className="mt-6 grid grid-cols-3 gap-y-4 text-center text-sm text-muted-foreground sm:grid-cols-4 md:grid-cols-6">
            {LOGOS.map((l, i) => (
              <span key={i} className="opacity-60 transition-opacity hover:opacity-100">
                {l}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Feature grid */}
      <section className="border-b border-border/60 bg-background py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
              Everything you'd build yourself,{" "}
              <span className="text-muted-foreground">already running</span>.
            </h2>
            <p className="mt-4 text-muted-foreground">
              Stop wiring Stripe to Supabase to Slack at 11pm. Connect once, get a full cockpit.
            </p>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {FEATURE_CARDS.map((f) => {
              const Icon = f.icon;
              return (
                <div
                  key={f.title}
                  className="rounded-xl border border-border bg-card/50 p-5 transition-colors hover:border-border/80 hover:bg-card"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-secondary text-[hsl(var(--primary-soft))]">
                    <Icon className="h-4 w-4" />
                  </div>
                  <h3 className="mt-4 text-sm font-semibold">{f.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Agency pitch / split */}
      <section className="border-b border-border/60 bg-secondary/30 py-20">
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
                logs. Invite stakeholders with granular roles. White-label support coming.
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
                <div className="space-y-3">
                  <ProjectRow name="acme-inc.com" mrr="€12,440" status="healthy" />
                  <ProjectRow name="byte-studio" mrr="€7,180" status="warning" />
                  <ProjectRow name="pixel-labs" mrr="€21,090" status="healthy" />
                  <ProjectRow name="nordic-ops" mrr="€4,520" status="error" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-background py-20">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
          <MessageSquareText className="mx-auto h-8 w-8 text-[hsl(var(--primary-soft))]" />
          <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Spin up your first cockpit in 90 seconds.
          </h2>
          <p className="mt-4 text-muted-foreground">
            Free plan covers up to 3 client projects with all integrations.
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-2 sm:flex-row">
            <Link
              to="/signup"
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 sm:w-auto"
            >
              Get started <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/pricing"
              className="inline-flex w-full items-center justify-center rounded-md border border-border bg-secondary/50 px-5 py-2.5 text-sm transition-colors hover:bg-secondary sm:w-auto"
            >
              See pricing
            </Link>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}

function ProjectRow({ name, mrr, status }: { name: string; mrr: string; status: "healthy" | "warning" | "error" }) {
  const dot =
    status === "healthy"
      ? "bg-[hsl(var(--accent-2))]"
      : status === "warning"
        ? "bg-amber-400"
        : "bg-destructive";
  return (
    <div className="flex items-center justify-between rounded-md border border-border/60 bg-secondary/30 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="font-mono text-xs">{name}</span>
      </div>
      <span className="text-xs tabular-nums">{mrr}</span>
    </div>
  );
}
