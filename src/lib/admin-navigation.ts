import {
  BuildingsIcon,
  ShieldCheckIcon,
  UsersThreeIcon,
  KanbanIcon,
  PlugsConnectedIcon,
  LockKeyIcon,
  SparkleIcon,
  CreditCardIcon,
  FingerprintIcon,
  EyeIcon,
  WalletIcon,
  SirenIcon,
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
      { label: "Connecteurs", slug: "connectors", icon: PlugsConnectedIcon },
      { label: "Sécurité", slug: "security", icon: LockKeyIcon },
    ],
  },
  {
    label: "Abonnements",
    items: [
      { label: "Abonnements", slug: "subscription", icon: SparkleIcon },
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
