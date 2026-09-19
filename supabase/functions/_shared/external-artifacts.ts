// Where a link comes from, read off the link itself.
//
// An agent that just created a Notion page knows the URL; it does not know our
// icon vocabulary, and asking it to guess a slug would produce `notion.so`,
// `Notion`, `notion-page` and `NOTION_CREATE_PAGE` on four different runs. So
// the slug is DERIVED here, from the host, and the tool's `provider` argument
// is only an override for the cases the host cannot settle (a self-hosted
// GitLab, an intranet wiki).
//
// The table stays permissive on purpose: an unknown provider still renders — the
// logo component falls back to the domain's favicon, then to a generic glyph —
// so a tool we have never heard of produces a correct card rather than an error.

export interface LinkedArtifact {
  provider: string;
  kind: string;
  title: string;
  url: string;
}

/** host suffix → (slug, default kind). Longest match wins. */
const HOSTS: Array<[string, string, string]> = [
  ["notion.so", "notion", "page"],
  ["notion.site", "notion", "page"],
  ["docs.google.com", "google", "document"],
  ["drive.google.com", "google", "file"],
  ["sheets.google.com", "google", "sheet"],
  ["slides.google.com", "google", "slides"],
  ["calendar.google.com", "google-calendar", "event"],
  ["mail.google.com", "gmail", "email"],
  ["github.com", "github", "repo"],
  ["gitlab.com", "gitlab", "repo"],
  ["linear.app", "linear", "issue"],
  ["atlassian.net", "jira", "issue"],
  ["figma.com", "figma", "design"],
  ["slack.com", "slack", "message"],
  ["airtable.com", "airtable", "base"],
  ["hubspot.com", "hubspot", "record"],
  ["salesforce.com", "salesforce", "record"],
  ["pipedrive.com", "pipedrive", "record"],
  ["attio.com", "attio", "record"],
  ["stripe.com", "stripe", "record"],
  ["intercom.com", "intercom", "conversation"],
  ["zendesk.com", "zendesk", "ticket"],
  ["sentry.io", "sentry", "issue"],
  ["vercel.com", "vercel", "deployment"],
  ["supabase.com", "supabase", "project"],
  ["posthog.com", "posthog", "insight"],
  ["dropbox.com", "dropbox", "file"],
  ["sharepoint.com", "microsoft", "file"],
  ["office.com", "microsoft", "document"],
  ["trello.com", "trello", "card"],
  ["asana.com", "asana", "task"],
  ["monday.com", "monday", "item"],
  ["clickup.com", "clickup", "task"],
  ["youtube.com", "youtube", "video"],
  ["loom.com", "loom", "video"],
];

export function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/** The provider slug and a sensible kind for this URL. */
export function inferProvider(url: string): { provider: string; kind: string } {
  const host = hostOf(url);
  if (!host) return { provider: "link", kind: "link" };
  let best: [string, string, string] | null = null;
  for (const row of HOSTS) {
    if (host === row[0] || host.endsWith(`.${row[0]}`)) {
      if (!best || row[0].length > best[0].length) best = row;
    }
  }
  if (best) return { provider: best[1], kind: best[2] };
  // Unknown host: the bare domain is a usable slug — the logo component resolves
  // it by favicon, and the card still says where the thing lives.
  return { provider: host.split(".").slice(-2)[0] || "link", kind: "link" };
}

/** Only http(s) links become artifacts. A `javascript:` or `file:` URL on a card
 *  everyone clicks is not a feature. */
export function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}
