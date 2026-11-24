import {
  ChatsCircleIcon, CodeIcon, HandshakeIcon, MegaphoneIcon, ChartBarIcon, MagnifyingGlassIcon,
  UserPlusIcon, WrenchIcon, CalendarDotsIcon, PlantIcon, type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { JourneyProfile } from "./api";

/**
 * Ce que les réponses du parcours changent dans l'outil.
 *
 *   · le premier agent proposé (parcours d'entreprise, galerie) ;
 *   · les raccourcis « Pour vous » de l'accueil d'un service ;
 *   · le prénom utilisé partout.
 *
 * Une table de correspondance, pas un modèle : on doit pouvoir lire d'ici
 * pourquoi telle personne voit tel agent.
 */

/** Cas d'usage → modèles d'agents (clés d'agentTemplates.ts), du plus parlant au moins. */
const USE_CASE_TEMPLATES: Record<string, string[]> = {
  public_support: ["support-resolver", "customer-success"],
  assistant: ["ai-secretary", "personal-daily", "chief-of-staff"],
  sales: ["crm-sdr", "account-executive", "revenue-guardian"],
  content: ["growth-content", "social-media", "seo-strategist"],
  dev: ["code-reviewer", "fullstack-engineer", "studio-vibe-code"],
  data: ["data-analyst", "exec-briefer", "data-engineer"],
  research: ["market-watch", "exec-briefer"],
  recruiting: ["talent-recruiter", "people-ops"],
  ops: ["ops-sentinel", "finance-controller", "supply-planner"],
  user_onboarding: ["tool-trainer", "customer-success"],
};

/** Rôle → modèles, quand les cas d'usage ne suffisent pas à remplir la liste. */
const PERSONA_TEMPLATES: Record<string, string[]> = {
  founder: ["exec-briefer", "chief-of-staff", "ai-secretary"],
  manager: ["exec-briefer", "ai-secretary"],
  product: ["product-manager", "product-feedback-synth"],
  developer: ["code-reviewer", "fullstack-engineer"],
  marketing: ["growth-content", "seo-strategist"],
  sales: ["crm-sdr", "account-executive"],
  support: ["support-resolver", "customer-success"],
  operations: ["ops-sentinel", "finance-controller"],
  consultant: ["market-watch", "ai-secretary"],
  freelance: ["ai-secretary", "personal-admin"],
  student: ["personal-learning", "personal-daily"],
};

const DEFAULT_TEMPLATES = ["ai-secretary", "support-resolver", "exec-briefer", "growth-content"];

/** Les modèles d'agents à proposer en premier, sans doublon. */
export function recommendedTemplates(p: JourneyProfile | null | undefined, n = 4): string[] {
  const out: string[] = [];
  const push = (k: string) => { if (!out.includes(k)) out.push(k); };
  for (const u of p?.use_cases ?? []) (USE_CASE_TEMPLATES[u] ?? []).slice(0, 2).forEach(push);
  if (p?.persona) (PERSONA_TEMPLATES[p.persona] ?? []).forEach(push);
  DEFAULT_TEMPLATES.forEach(push);
  return out.slice(0, n);
}

export interface Suggestion { key: string; label: string; sub: string; icon: PhosphorIcon; href: string }

/** Les raccourcis « Pour vous » de l'accueil d'un service, d'après les cas d'usage. */
export function homeSuggestions(p: JourneyProfile | null | undefined, base: string): Suggestion[] {
  const all: Record<string, Suggestion> = {
    public_support: { key: "public_support", label: "Un agent sur votre site", sub: "Il répond à vos visiteurs, jour et nuit", icon: ChatsCircleIcon, href: `${base}/agents/new?type=public` },
    assistant: { key: "assistant", label: "Votre assistant personnel", sub: "Agenda, e-mails, relances", icon: CalendarDotsIcon, href: `${base}/agents/new?type=templates` },
    sales: { key: "sales", label: "Un agent de prospection", sub: "Il qualifie et relance vos prospects", icon: HandshakeIcon, href: `${base}/agents/new?type=templates` },
    content: { key: "content", label: "Un agent de contenu", sub: "Articles, posts, newsletters", icon: MegaphoneIcon, href: `${base}/agents/new?type=templates` },
    dev: { key: "dev", label: "Un agent développeur", sub: "Revues de code, corrections, tests", icon: CodeIcon, href: `${base}/agents/new?type=templates` },
    data: { key: "data", label: "Un analyste de données", sub: "Tableaux de bord et synthèses", icon: ChartBarIcon, href: `${base}/agents/new?type=templates` },
    research: { key: "research", label: "Un agent de veille", sub: "Concurrents, marché, tendances", icon: MagnifyingGlassIcon, href: `${base}/agents/new?type=templates` },
    recruiting: { key: "recruiting", label: "Un agent recruteur", sub: "Tri des candidatures, entretiens", icon: UserPlusIcon, href: `${base}/agents/new?type=templates` },
    ops: { key: "ops", label: "Un agent opérations", sub: "Suivi, alertes, routines", icon: WrenchIcon, href: `${base}/agents/new?type=templates` },
    user_onboarding: { key: "user_onboarding", label: "Accueillir vos utilisateurs", sub: "Un guide dans votre application", icon: PlantIcon, href: `${base}/agents/new?type=public` },
  };
  return (p?.use_cases ?? []).map((u) => all[u]).filter((s): s is Suggestion => !!s).slice(0, 3);
}

/** Les débutants voient les explications ; les bâtisseurs, l'essentiel. */
export function wantsGuidance(p: JourneyProfile | null | undefined): boolean {
  return !p?.ai_experience || p.ai_experience === "new" || p.ai_experience === "occasional";
}
