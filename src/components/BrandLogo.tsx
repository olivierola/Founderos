import { useState } from "react";
import { PlugIcon as Plug } from "@phosphor-icons/react";
import {
  siGmail, siGoogle, siGithub, siStripe, siHubspot, siIntercom, siNotion,
  siLinear, siAirtable, siPosthog, siPlausibleanalytics, siSentry, siFigma,
  siDiscord, siTelegram, siGooglecalendar, siGooglebigquery, siGooglecloud,
} from "simple-icons";

// Real brand logos for connected third-party tools. Prefers the official inline
// SVG from `simple-icons`; for brands Simple Icons no longer ships (trademark
// removals) it falls back to the Clearbit logo CDN by domain, then a generic
// plug glyph. Shared by the agent cards and any other connected-tools surface.
type Glyph = { hex: string; path: string; title: string };
const ICONS: Record<string, Glyph> = {
  gmail: siGmail, google: siGoogle, "google-mail": siGmail,
  github: siGithub, stripe: siStripe, hubspot: siHubspot, intercom: siIntercom,
  notion: siNotion, linear: siLinear, airtable: siAirtable, posthog: siPosthog,
  plausible: siPlausibleanalytics, sentry: siSentry, figma: siFigma,
  discord: siDiscord, telegram: siTelegram,
  "google-calendar": siGooglecalendar, bigquery: siGooglebigquery, gcs: siGooglecloud,
};
const DOMAINS: Record<string, string> = {
  slack: "slack.com", teams: "microsoft.com", salesforce: "salesforce.com",
  pipedrive: "pipedrive.com", attio: "attio.com", bamboohr: "bamboohr.com",
  deel: "deel.com", factorial: "factorialhr.com", lever: "lever.co",
  workable: "workable.com", "linkedin-talent": "linkedin.com",
  resend: "resend.com", sendgrid: "sendgrid.com", twilio: "twilio.com",
  vercel: "vercel.com", supabase: "supabase.com", openai: "openai.com",
  anthropic: "anthropic.com", deepseek: "deepseek.com",
};

export function BrandLogo({ slug, className = "h-5 w-5" }: { slug: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const key = slug.toLowerCase();
  const icon = ICONS[key];
  if (icon) {
    return (
      <svg role="img" viewBox="0 0 24 24" className={className} fill={`#${icon.hex}`} aria-label={icon.title}>
        <path d={icon.path} />
      </svg>
    );
  }
  const domain = DOMAINS[key];
  if (domain && !failed) {
    return (
      <img
        src={`https://logo.clearbit.com/${domain}`}
        alt={slug}
        className={`${className} rounded-sm object-contain`}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return <Plug className={`${className} text-muted-foreground`} />;
}
