import {
  Shield, ShieldCheck, Code2, Server, TestTube2,
  BarChart3, GitBranch, Brain, Eraser, Activity,
  Bot, Cpu, UserCheck, Workflow,
  KanbanSquare, Clock, FlaskConical, PenTool,
  FileText, Image, Video, Megaphone,
  Headphones, Phone, BookOpen,
  Package, ShoppingCart, Truck,
  PieChart, Receipt, CreditCard, Landmark,
  Plug, Users, GraduationCap, Star, DollarSign,
  type LucideIcon,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProjectTypeDef {
  key: string;
  label: string;
  icon: LucideIcon;
  description: string;
  color: string;
  category: string;
}

export interface ModuleProjectConfig {
  moduleSlug: string;
  label: string;
  projectTypes: ProjectTypeDef[];
}

// ─── All project types ──────────────────────────────────────────────────────
// Every project type gets the same 6 universal tabs:
//   Assets · Agents · Artifacts · Timeline · Tasks · Notes
// The "type" determines the project's domain context and icon, not its tabs.

const TYPES: ProjectTypeDef[] = [
  // Security & DevOps
  { key: "audit", label: "Audit", icon: Shield, color: "#ef4444", category: "Security & DevOps",
    description: "Cadrer le périmètre, collecter les preuves, tester les contrôles, produire le rapport." },
  { key: "compliance", label: "Compliance", icon: ShieldCheck, color: "#3b82f6", category: "Security & DevOps",
    description: "Mapper exigences → contrôles, surveiller la posture en continu." },
  { key: "code_security", label: "Code Security", icon: Code2, color: "#8b5cf6", category: "Security & DevOps",
    description: "Scanner au commit/build, générer le SBOM, trier criticité, suivre le MTTR." },
  { key: "sys_admin", label: "System Administration", icon: Server, color: "#10b981", category: "Security & DevOps",
    description: "Gérer parc et configs, surveiller drift et menaces runtime." },
  { key: "app_testing", label: "App Testing", icon: TestTube2, color: "#f59e0b", category: "Security & DevOps",
    description: "Définir les cas, exécuter en staging, suivre passif et escape rate." },

  // Data & Analytics
  { key: "data_analysis", label: "Data Analysis", icon: BarChart3, color: "#3b82f6", category: "Data & Analytics",
    description: "Explorer depuis le warehouse, partager des chiffres cohérents." },
  { key: "data_pipeline", label: "Data Pipeline", icon: GitBranch, color: "#10b981", category: "Data & Analytics",
    description: "Orchestrer ingestion → transformation → serving." },
  { key: "ml", label: "Machine Learning", icon: Brain, color: "#8b5cf6", category: "Data & Analytics",
    description: "Entraîner → évaluer → versionner → servir → monitorer." },
  { key: "data_cleaning", label: "Data Cleaning", icon: Eraser, color: "#f59e0b", category: "Data & Analytics",
    description: "Profiler, appliquer les règles de nettoyage, tester la qualité." },
  { key: "saas_analytics", label: "SaaS Analytics", icon: Activity, color: "#ec4899", category: "Data & Analytics",
    description: "Modéliser les KPI produit/business, activer les données." },

  // AI & Agents
  { key: "public_agent", label: "Public Agent", icon: Bot, color: "#8b5cf6", category: "AI & Agents",
    description: "Déployer un agent face client avec garde-fous." },
  { key: "autonomous_agent", label: "Autonomous Agent", icon: Cpu, color: "#ef4444", category: "AI & Agents",
    description: "L'agent exécute en autonomie avec validation humaine (HITL)." },
  { key: "onboarding_agent", label: "Onboarding Agent", icon: UserCheck, color: "#10b981", category: "AI & Agents",
    description: "Guider l'utilisateur en temps réel dans l'app hôte." },
  { key: "ai_workflows", label: "AI Workflows", icon: Workflow, color: "#3b82f6", category: "AI & Agents",
    description: "Composer des workflows multi-agents." },

  // Project Management
  { key: "agile_scrum", label: "Agile / Scrum", icon: KanbanSquare, color: "#3b82f6", category: "Project Management",
    description: "Backlog → sprint → exécution → review → livraison." },
  { key: "psa", label: "PSA", icon: Clock, color: "#10b981", category: "Project Management",
    description: "Devis → staffing → exécution → facturation → rentabilité." },
  { key: "simulation", label: "Simulation", icon: FlaskConical, color: "#8b5cf6", category: "Project Management",
    description: "Modéliser des scénarios what-if, comparer les outcomes." },
  { key: "whiteboard", label: "Whiteboard", icon: PenTool, color: "#f59e0b", category: "Project Management",
    description: "Idéation et cartographie visuelles libres." },

  // Creation & Docs
  { key: "document_project", label: "Document Project", icon: FileText, color: "#3b82f6", category: "Creation & Docs",
    description: "Produire des documents structurés avec cycle de revue." },
  { key: "content_generation", label: "Content Generation", icon: Image, color: "#ec4899", category: "Creation & Docs",
    description: "Brief → génération → revue → publication, à l'échelle." },
  { key: "campaign", label: "Campaign", icon: Megaphone, color: "#f59e0b", category: "Creation & Docs",
    description: "Planifier → exécuter → mesurer. Scheduling multicanal." },

  // Support
  { key: "help_desk", label: "Help Desk", icon: Headphones, color: "#3b82f6", category: "Support",
    description: "Capter → catégoriser → prioriser → router → résoudre." },
  { key: "call_center", label: "Call Center", icon: Phone, color: "#10b981", category: "Support",
    description: "Gérer volume d'appels, files et effectifs en temps réel." },
  { key: "self_service", label: "Self-Service", icon: BookOpen, color: "#8b5cf6", category: "Support",
    description: "Exposer un catalogue de services et une KB." },

  // Supply Chain
  { key: "inventory_management", label: "Inventory Management", icon: Package, color: "#3b82f6", category: "Supply Chain",
    description: "Suivre niveaux et mouvements, déclencher le réappro." },
  { key: "procurement", label: "Procurement", icon: ShoppingCart, color: "#10b981", category: "Supply Chain",
    description: "Sourcing → réquisition → PO → réception." },
  { key: "logistics", label: "Logistics", icon: Truck, color: "#f59e0b", category: "Supply Chain",
    description: "Planifier et suivre expéditions et itinéraires." },

  // Finance
  { key: "financial_reporting", label: "Financial Reporting", icon: PieChart, color: "#3b82f6", category: "Finance",
    description: "GL → rapprochement → clôture → consolidation → reporting." },
  { key: "accounts_receivable", label: "Accounts Receivable", icon: Receipt, color: "#10b981", category: "Finance",
    description: "Facture → recouvrement → lettrage → réconciliation." },
  { key: "accounts_payable", label: "Accounts Payable", icon: CreditCard, color: "#ef4444", category: "Finance",
    description: "Réquisition → PO → rapprochement 3-way → paiement." },
  { key: "treasury", label: "Treasury", icon: Landmark, color: "#8b5cf6", category: "Finance",
    description: "Consolider la position cash, prévoir les flux." },

  // Human Resources
  { key: "recruitment", label: "Recruitment", icon: Users, color: "#3b82f6", category: "Human Resources",
    description: "Réquisition → posting → sourcing → screening → offre." },
  { key: "onboarding", label: "Onboarding", icon: GraduationCap, color: "#10b981", category: "Human Resources",
    description: "De l'offre acceptée à l'intégration." },
  { key: "performance", label: "Performance", icon: Star, color: "#f59e0b", category: "Human Resources",
    description: "Fixer objectifs → feedback continu → revues → calibrage." },
  { key: "payroll", label: "Payroll", icon: DollarSign, color: "#8b5cf6", category: "Human Resources",
    description: "Collecter temps → calculer → approuver → verser." },
];

// ─── Registry ───────────────────────────────────────────────────────────────

const ALL_PROJECTS: ModuleProjectConfig = {
  moduleSlug: "projects",
  label: "Projects",
  projectTypes: TYPES,
};

export const MODULE_PROJECT_CONFIGS: Record<string, ModuleProjectConfig> = {
  projects: ALL_PROJECTS,
};

export function getModuleConfig(moduleSlug: string): ModuleProjectConfig | undefined {
  return MODULE_PROJECT_CONFIGS[moduleSlug];
}

export function getProjectType(moduleSlug: string, typeKey: string): ProjectTypeDef | undefined {
  return MODULE_PROJECT_CONFIGS[moduleSlug]?.projectTypes.find((t) => t.key === typeKey);
}

// Group types by category for the type picker UI.
export function getTypesByCategory(): Array<{ category: string; types: ProjectTypeDef[] }> {
  const order: string[] = [];
  const map: Record<string, ProjectTypeDef[]> = {};
  for (const t of TYPES) {
    if (!map[t.category]) { map[t.category] = []; order.push(t.category); }
    map[t.category].push(t);
  }
  return order.map((category) => ({ category, types: map[category] }));
}
