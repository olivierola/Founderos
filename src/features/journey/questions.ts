import {
  BriefcaseIcon, BuildingsIcon, ChartLineUpIcon, ChatsCircleIcon, CodeIcon, CompassIcon,
  CurrencyEurIcon, GraduationCapIcon, HandshakeIcon, HeadsetIcon, HeartbeatIcon, HouseLineIcon,
  LightbulbIcon, LightningIcon, MagnifyingGlassIcon, MegaphoneIcon, NewspaperIcon, PaintBrushIcon,
  PersonIcon, PlantIcon, RobotIcon, RocketLaunchIcon, ShoppingBagIcon, SparkleIcon, StorefrontIcon,
  TargetIcon, TimerIcon, TreeStructureIcon, UserCircleIcon, UsersThreeIcon, WrenchIcon,
  YoutubeLogoIcon, LinkedinLogoIcon, XLogoIcon, GoogleLogoIcon, CalendarDotsIcon, ChartBarIcon,
  UserPlusIcon, GearSixIcon, BankIcon, FactoryIcon, type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

/**
 * Les questions du parcours d'arrivée.
 *
 * Chaque question propose des réponses et accepte une réponse libre
 * (« Autre »). Une valeur proposée est enregistrée par sa clé ; une réponse
 * libre est enregistrée telle quelle. La personnalisation (personalize.ts) ne
 * lit que les clés, la vue d'équipe montre tout.
 */

export interface Choice { value: string; label: string; icon?: PhosphorIcon }

export type QuestionKey =
  | "first_name" | "persona" | "industry" | "company_size" | "discovery_source"
  | "goals" | "use_cases" | "ai_experience" | "expectations";

export interface Question {
  key: QuestionKey;
  title: string;
  sub: string;
  kind: "text" | "single" | "multi" | "long";
  choices?: Choice[];
  /** Autorise une réponse libre en plus des propositions. */
  other?: boolean;
  /** Un champ texte secondaire, sous les propositions. */
  detail?: { key: "job_title" | "discovery_detail"; label: string; placeholder: string };
  placeholder?: string;
  /** Combien de colonnes pour les propositions. */
  cols?: 2 | 3;
  optional?: boolean;
}

export const QUESTIONS: Question[] = [
  {
    key: "first_name",
    title: "Comment doit-on vous appeler ?",
    sub: "Votre prénom, pour que l'outil et vos agents s'adressent à vous.",
    kind: "text",
    placeholder: "Votre prénom",
  },
  {
    key: "persona",
    title: "Quel est votre rôle ?",
    sub: "Il décide de ce qu'on vous montre en premier.",
    kind: "single",
    other: true,
    cols: 3,
    detail: { key: "job_title", label: "Votre intitulé de poste", placeholder: "Ex. Responsable relation client" },
    choices: [
      { value: "founder", label: "Fondateur ou dirigeant", icon: RocketLaunchIcon },
      { value: "manager", label: "Manager d'équipe", icon: UsersThreeIcon },
      { value: "product", label: "Produit", icon: CompassIcon },
      { value: "developer", label: "Développeur", icon: CodeIcon },
      { value: "marketing", label: "Marketing", icon: MegaphoneIcon },
      { value: "sales", label: "Commercial", icon: HandshakeIcon },
      { value: "support", label: "Support client", icon: HeadsetIcon },
      { value: "operations", label: "Opérations", icon: GearSixIcon },
      { value: "consultant", label: "Consultant ou agence", icon: BriefcaseIcon },
      { value: "freelance", label: "Indépendant", icon: PersonIcon },
      { value: "student", label: "Étudiant", icon: GraduationCapIcon },
    ],
  },
  {
    key: "industry",
    title: "Dans quel secteur travaillez-vous ?",
    sub: "Pour vous proposer des agents et des exemples de votre métier.",
    kind: "single",
    other: true,
    cols: 3,
    choices: [
      { value: "saas", label: "Logiciel et SaaS", icon: CodeIcon },
      { value: "ecommerce", label: "E-commerce", icon: ShoppingBagIcon },
      { value: "services", label: "Services et conseil", icon: BriefcaseIcon },
      { value: "finance", label: "Finance et assurance", icon: BankIcon },
      { value: "health", label: "Santé", icon: HeartbeatIcon },
      { value: "education", label: "Éducation", icon: GraduationCapIcon },
      { value: "real_estate", label: "Immobilier", icon: HouseLineIcon },
      { value: "industry", label: "Industrie", icon: FactoryIcon },
      { value: "public", label: "Secteur public", icon: BuildingsIcon },
      { value: "media", label: "Médias et création", icon: PaintBrushIcon },
      { value: "retail", label: "Commerce de proximité", icon: StorefrontIcon },
    ],
  },
  {
    key: "company_size",
    title: "Combien êtes-vous ?",
    sub: "La taille de votre équipe, vous compris.",
    kind: "single",
    cols: 3,
    choices: [
      { value: "solo", label: "Juste moi", icon: UserCircleIcon },
      { value: "2-10", label: "2 à 10", icon: UsersThreeIcon },
      { value: "11-50", label: "11 à 50", icon: UsersThreeIcon },
      { value: "51-200", label: "51 à 200", icon: BuildingsIcon },
      { value: "201-1000", label: "201 à 1 000", icon: BuildingsIcon },
      { value: "1000+", label: "Plus de 1 000", icon: BuildingsIcon },
    ],
  },
  {
    key: "discovery_source",
    title: "Comment nous avez-vous connus ?",
    sub: "Ça nous aide à savoir où vous trouver.",
    kind: "single",
    other: true,
    cols: 3,
    detail: { key: "discovery_detail", label: "Un détail ? (facultatif)", placeholder: "Le nom de la personne, de l'article, de l'événement…" },
    choices: [
      { value: "search", label: "Recherche Google", icon: GoogleLogoIcon },
      { value: "ai_assistant", label: "Un assistant IA", icon: SparkleIcon },
      { value: "linkedin", label: "LinkedIn", icon: LinkedinLogoIcon },
      { value: "x", label: "X (Twitter)", icon: XLogoIcon },
      { value: "youtube", label: "YouTube", icon: YoutubeLogoIcon },
      { value: "word_of_mouth", label: "Bouche à oreille", icon: ChatsCircleIcon },
      { value: "event", label: "Événement", icon: CalendarDotsIcon },
      { value: "press", label: "Article ou newsletter", icon: NewspaperIcon },
      { value: "colleague", label: "Mon entreprise l'utilise", icon: BuildingsIcon },
    ],
  },
  {
    key: "goals",
    title: "Qu'attendez-vous de nous ?",
    sub: "Plusieurs choix possibles.",
    kind: "multi",
    other: true,
    cols: 2,
    choices: [
      { value: "save_time", label: "Gagner du temps sur le répétitif", icon: TimerIcon },
      { value: "customers_247", label: "Répondre à mes clients 24 h/24", icon: HeadsetIcon },
      { value: "grow", label: "Trouver plus de clients", icon: ChartLineUpIcon },
      { value: "steer", label: "Mieux piloter mon activité", icon: TargetIcon },
      { value: "team_agents", label: "Une équipe d'agents à mes côtés", icon: RobotIcon },
      { value: "automate", label: "Automatiser mes processus", icon: TreeStructureIcon },
      { value: "explore", label: "Explorer ce que l'IA peut faire", icon: LightbulbIcon },
      { value: "cut_costs", label: "Réduire mes coûts", icon: CurrencyEurIcon },
    ],
  },
  {
    key: "use_cases",
    title: "Par quoi voulez-vous commencer ?",
    sub: "Ce que vous voulez confier à vos agents en premier. Plusieurs choix possibles.",
    kind: "multi",
    other: true,
    cols: 2,
    choices: [
      { value: "public_support", label: "Un agent sur mon site, pour mes visiteurs", icon: ChatsCircleIcon },
      { value: "assistant", label: "Un assistant personnel (agenda, e-mails)", icon: CalendarDotsIcon },
      { value: "sales", label: "Prospection et ventes", icon: HandshakeIcon },
      { value: "content", label: "Contenu et marketing", icon: MegaphoneIcon },
      { value: "dev", label: "Développement et code", icon: CodeIcon },
      { value: "data", label: "Analyse de données et reporting", icon: ChartBarIcon },
      { value: "research", label: "Veille et recherche", icon: MagnifyingGlassIcon },
      { value: "recruiting", label: "Recrutement et RH", icon: UserPlusIcon },
      { value: "ops", label: "Opérations et suivi", icon: WrenchIcon },
      { value: "user_onboarding", label: "Accueillir les utilisateurs de mon app", icon: PlantIcon },
    ],
  },
  {
    key: "ai_experience",
    title: "Où en êtes-vous avec l'IA ?",
    sub: "Pour régler le niveau de détail des explications.",
    kind: "single",
    cols: 2,
    choices: [
      { value: "new", label: "Je découvre", icon: PlantIcon },
      { value: "occasional", label: "J'utilise un assistant de temps en temps", icon: SparkleIcon },
      { value: "daily", label: "Tous les jours", icon: LightningIcon },
      { value: "builder", label: "Je construis déjà des agents", icon: RobotIcon },
    ],
  },
  {
    key: "expectations",
    title: "Autre chose à nous dire ?",
    sub: "Un besoin précis, une attente, une inquiétude. Facultatif.",
    kind: "long",
    optional: true,
    placeholder: "Ex. Je voudrais qu'un agent réponde aux questions de mes clients sur les délais de livraison.",
  },
];

/** Le libellé d'une réponse : la proposition si c'en est une, sinon le texte libre. */
export function choiceLabel(key: QuestionKey, value: string | null | undefined): string {
  if (!value) return "";
  const q = QUESTIONS.find((x) => x.key === key);
  return q?.choices?.find((c) => c.value === value)?.label ?? value;
}

export function isChoice(key: QuestionKey, value: string): boolean {
  const q = QUESTIONS.find((x) => x.key === key);
  return !!q?.choices?.some((c) => c.value === value);
}
