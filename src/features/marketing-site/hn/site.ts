import type { Art } from "./HnKit";

/* ══ What the site sells, in one place ═══════════════════════════════════════
   The nav, the footer, the home page and the product pages all read these, so
   a product cannot end up named one way in the menu and another on its page.
   The six solutions stay in ../solutions.ts, which predates this file. */

export type Product = {
  slug: string;
  name: string;
  /** The product word in the lockup bubble (Audiowide, like the navbar). */
  short: string;
  /** A real capture of the product, in /public/marketing. */
  shot: string;
  shotAlt: string;
  /** One line for the nav and the home card. */
  blurb: string;
  /** Who it is "best for" — the eyebrow on its home band. */
  bestFor: string;
  art: Art;
};

export const PRODUCTS: Product[] = [
  {
    slug: "agents",
    name: "Anduran Workforce",
    short: "WORKFORCE",
    shot: "/marketing/product-agents.jpg",
    shotAlt: "The Cloud collaborator roster in Anduran: internal and public workers, their tools and models",
    blurb: "Cloud collaborators that work inside your systems: they read freely, stop for approval before they write, and hand in finished work.",
    bestFor: "Best for growing teams",
    art: "blue",
  },
  {
    slug: "govern",
    name: "Anduran Govern",
    short: "GOVERN",
    shot: "/marketing/product-audit.jpg",
    shotAlt: "The access log in Anduran: every tool call with its Cloud collaborator, result and run",
    blurb: "The registry, guardrails, approvals and audit trail that keep every Cloud collaborator accountable, for the teams that answer to an auditor.",
    bestFor: "Best for regulated teams",
    art: "violet",
  },
];

export const RESOURCES = [
  { label: "Blog", to: "/blog", blurb: "Field notes on putting Cloud collaborators to work." },
  { label: "Docs", to: "/docs", blurb: "How the product works, on one page." },
  { label: "Changelog", to: "/changelog", blurb: "What shipped, and when." },
  { label: "Integrations", to: "/integrations", blurb: "The tools Cloud collaborators connect to." },
  { label: "FAQ", to: "/faq", blurb: "The questions teams ask first." },
  { label: "About", to: "/about", blurb: "Who we are and why we build this." },
  { label: "Get in touch", to: "/contact", blurb: "Sales, support and press." },
];

/** The artwork each solution wears, in solutions.ts order. */
export const SOLUTION_ART: Record<string, Art> = {
  readiness: "blue",
  agents: "violet",
  foundation: "olive",
  adoption: "orange",
  governance: "pink",
  managed: "gold",
};

/** The artwork a blog post wears, by category — so the shelf reads as a set. */
export const CATEGORY_ART: Record<string, Art> = {
  Governance: "violet",
  Agents: "blue",
  Adoption: "orange",
  Security: "olive",
  Engineering: "pink",
};
