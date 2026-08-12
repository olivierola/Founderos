import {
  BuildingsIcon,
  ShieldCheckIcon,
  UsersThreeIcon,
  KanbanIcon,
  GithubLogoIcon,
  LockKeyIcon,
  SparkleIcon,
  CreditCardIcon,
  GaugeIcon,
  FingerprintIcon,
  EyeIcon,
  WalletIcon,
  SirenIcon,
  SealCheckIcon,
  CrosshairIcon,
  type Icon,
} from "@phosphor-icons/react";

/**
 * The Admin dashboard is a self-contained area with a SINGLE left sidebar
 * (unlike the two-sidebar product shell). It consolidates every admin surface
 * — organisation, access, members, workspaces, connectors, subscriptions,
 * billing, AI governance and API — that used to be scattered across the
 * Settings / Integrations / Governance modules. Reached from the top-left
 * dashboard switcher ("Admin"). Route namespace: /app/:ws/:proj/admin/<slug>.
 */

export interface AdminNavItem {
  label: string;
  slug: string;
  icon: Icon;
}

export interface AdminNavSection {
  /** Coral, uppercase section label with a small square bullet (see mockup). */
  label: string;
  items: AdminNavItem[];
}

export const ADMIN_SECTIONS: AdminNavSection[] = [
  {
    label: "Administration",
    items: [
      { label: "Organisation", slug: "organisation", icon: BuildingsIcon },
      { label: "Accès", slug: "access", icon: ShieldCheckIcon },
      { label: "Membres", slug: "members", icon: UsersThreeIcon },
      { label: "Espaces de travail", slug: "workspaces", icon: KanbanIcon },
      // "Connecteurs" moved to AI Workforce → Connexions (agent/connectors):
      // connecting an app is about what the agents can act on, not admin.
      // The Dépôts module left the nav with the "Outils IA" dashboard, but
      // connecting a repository is a prerequisite of the Vibe Code studio
      // agent — so it lives here, next to the other connection surfaces.
      { label: "Dépôts", slug: "repositories", icon: GithubLogoIcon },
      { label: "Sécurité", slug: "security", icon: LockKeyIcon },
    ],
  },
  {
    label: "Abonnements",
    items: [
      { label: "Abonnements", slug: "subscription", icon: SparkleIcon },
      // Séparé de « Abonnements » : l'un répond « qu'ai-je droit de faire ? »,
      // l'autre « où sont passés mes crédits ? ». Les mélanger noie la seconde.
      { label: "Consommation", slug: "usage", icon: GaugeIcon },
      { label: "Facturation", slug: "billing", icon: CreditCardIcon },
    ],
  },
  {
    label: "Gouvernance IA",
    items: [
      { label: "Guardrails", slug: "gov-guardrails", icon: ShieldCheckIcon },
      { label: "Accès agents", slug: "gov-access", icon: FingerprintIcon },
      { label: "Prompts", slug: "gov-prompts", icon: EyeIcon },
      { label: "Dépenses", slug: "gov-costs", icon: WalletIcon },
      { label: "Incidents", slug: "gov-incidents", icon: SirenIcon },
      { label: "Actions admin", slug: "gov-actions", icon: SealCheckIcon },
      { label: "Périmètre pentest", slug: "gov-pentest-scope", icon: CrosshairIcon },
    ],
  },
];

/** Landing tab of the Admin dashboard. */
export const ADMIN_LANDING = "organisation";

/** Flat list of every admin item (for route generation). */
export const ADMIN_ITEMS: AdminNavItem[] = ADMIN_SECTIONS.flatMap((s) => s.items);

export function findAdminItem(slug: string | undefined): AdminNavItem | undefined {
  if (!slug) return undefined;
  return ADMIN_ITEMS.find((i) => i.slug === slug);
}

/** True when the given pathname is inside the Admin dashboard. */
export function isAdminRoute(pathname: string): boolean {
  return /\/app\/[^/]+\/[^/]+\/admin(\/|$)/.test(pathname);
}
