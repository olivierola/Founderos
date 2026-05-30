import { useMemo, useState } from "react";
import { Search, Plus, ArrowRight, Link2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PROVIDERS } from "@/lib/providers";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Slugs of providers configured in the catalog (we mark them as "reusable"). */
  configuredSlugs: Set<string>;
  /** Variable names already pushed (we mark them to avoid duplicates). */
  pushedKeys: Set<string>;
  /** When the user picks a provider, suggest a sensible default env name. */
  onPickProvider: (providerSlug: string, suggestedKey: string) => void;
  /** When the user wants to add a free-form variable name. */
  onPickCustom: () => void;
}

// Map provider slug → canonical env var name used in user code.
const DEFAULT_ENV_NAME: Record<string, string> = {
  stripe: "STRIPE_SECRET_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  github: "GITHUB_TOKEN",
  gitlab: "GITLAB_TOKEN",
  supabase: "SUPABASE_SERVICE_ROLE_KEY",
  vercel: "VERCEL_TOKEN",
  resend: "RESEND_API_KEY",
  sendgrid: "SENDGRID_API_KEY",
  postmark: "POSTMARK_SERVER_TOKEN",
  posthog: "POSTHOG_API_KEY",
  mixpanel: "MIXPANEL_TOKEN",
  amplitude: "AMPLITUDE_API_KEY",
  sentry: "SENTRY_AUTH_TOKEN",
  datadog: "DATADOG_API_KEY",
  slack: "SLACK_WEBHOOK_URL",
  discord: "DISCORD_WEBHOOK_URL",
  telegram: "TELEGRAM_BOT_TOKEN",
  clerk: "CLERK_SECRET_KEY",
  twilio: "TWILIO_AUTH_TOKEN",
  algolia: "ALGOLIA_ADMIN_KEY",
  cloudflare: "CLOUDFLARE_API_TOKEN",
  cloudinary: "CLOUDINARY_API_KEY",
  hubspot: "HUBSPOT_ACCESS_TOKEN",
  intercom: "INTERCOM_ACCESS_TOKEN",
  linear: "LINEAR_API_KEY",
  notion: "NOTION_API_KEY",
  buffer: "BUFFER_ACCESS_TOKEN",
  typefully: "TYPEFULLY_API_KEY",
  hypefury: "HYPEFURY_API_KEY",
  x: "X_BEARER_TOKEN",
  linkedin: "LINKEDIN_ACCESS_TOKEN",
  inngest: "INNGEST_EVENT_KEY",
  upstash: "UPSTASH_REDIS_REST_TOKEN",
  neon: "NEON_API_KEY",
  planetscale: "PLANETSCALE_SERVICE_TOKEN",
  netlify: "NETLIFY_AUTH_TOKEN",
  railway: "RAILWAY_TOKEN",
  render: "RENDER_API_KEY",
  snyk: "SNYK_TOKEN",
  segment: "SEGMENT_WRITE_KEY",
  paddle: "PADDLE_API_KEY",
  lemonsqueezy: "LEMONSQUEEZY_API_KEY",
  betterstack: "BETTERSTACK_API_KEY",
};

export function suggestEnvName(slug: string): string {
  return DEFAULT_ENV_NAME[slug] ?? `${slug.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

export function AddSecretPicker({
  open,
  onOpenChange,
  configuredSlugs,
  pushedKeys,
  onPickProvider,
  onPickCustom,
}: Props) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return PROVIDERS.filter((p) => {
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.slug.includes(q) || p.category.includes(q);
    });
  }, [search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a secret</DialogTitle>
          <DialogDescription>
            Pick a provider whose credentials you want to push to your backend, or add a custom variable.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search providers…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              autoFocus
            />
          </div>

          <button
            type="button"
            onClick={() => {
              onOpenChange(false);
              onPickCustom();
            }}
            className="flex w-full items-center justify-between rounded-md border border-dashed border-border px-3 py-2.5 text-left transition-colors hover:bg-secondary"
          >
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary">
                <Plus className="h-4 w-4" />
              </div>
              <div>
                <div className="text-sm font-medium">Custom variable</div>
                <div className="text-xs text-muted-foreground">Enter any environment variable name and value.</div>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
          </button>

          <div className="max-h-[55vh] space-y-1 overflow-y-auto pr-1">
            {filtered.map((p) => {
              const Icon = p.icon;
              const isConfigured = configuredSlugs.has(p.slug);
              const suggestedKey = suggestEnvName(p.slug);
              const alreadyPushed = pushedKeys.has(suggestedKey);
              return (
                <button
                  key={p.slug}
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    onPickProvider(p.slug, suggestedKey);
                  }}
                  className="flex w-full items-center justify-between rounded-md border border-transparent px-3 py-2 text-left transition-colors hover:border-border hover:bg-secondary/50"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{p.name}</span>
                        {isConfigured && (
                          <Badge variant="success" className="gap-1 text-[10px]">
                            <Link2 className="h-2.5 w-2.5" />
                            in catalog
                          </Badge>
                        )}
                        {alreadyPushed && (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            already pushed
                          </Badge>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        Suggested: <span className="font-mono">{suggestedKey}</span>
                      </div>
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">No provider matches.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
