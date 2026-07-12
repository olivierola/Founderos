import { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Bot, Plus, Trash2, Save, Check, FileText, Target,
  Wrench, Users as UsersIcon, BarChart3, Settings as SettingsIcon,
  MessageSquare, Globe, Database, Zap, KeyRound, Play, Clock,
  CheckCircle2, XCircle, AlertCircle, Download, Package, Pencil,
  CalendarClock, Repeat, UserCircle2, ShieldCheck, Ban, BookOpen,
  ListTree, Gauge, Brain, Pin, PinOff, ArrowLeft, ChevronDown, ChevronUp, History,
  Network, MessagesSquare, Send, ArrowRight, Plug, AlertTriangle, Search, Slack, Workflow,
  X, FileCode, TerminalSquare, BrainCircuit, Copy, ThumbsUp, ThumbsDown, RotateCcw,
  SlidersHorizontal, MoreVertical, LayoutGrid, Columns3, Smartphone,
  type LucideIcon,
} from "lucide-react";
import {
  ChatCircleIcon, TargetIcon, SlidersHorizontalIcon, ShareNetworkIcon,
  SlackLogoIcon, ChartBarIcon, GearSixIcon,
} from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/EmptyState";
import { useRegisterTopbarTabs } from "@/components/layout/TopbarTabs";
import { ChatComposer } from "@/components/ui/chat-composer";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { InstructionsEditor } from "./InstructionsEditor";
import { AgentAvatar } from "./AvatarPicker";
import { AgentChannelsTab } from "./AgentChannelsTab";
import { AgentHostedModelCard } from "./AgentHostedModel";
import { AgentAutomationsTab } from "./AgentAutomationsTab";
import { RunTimeline } from "./RunTimeline";
import { toolSummary } from "./runEventMeta";
import { CONNECTOR_ACTION_GROUPS, connectorActionProvider } from "./connectorActionProviders";
import { ConnectorDialog } from "@/features/integrations/ConnectorDialog";
import { findProvider, type ProviderDef } from "@/lib/providers";
import {
  siDiscord, siTelegram, siHubspot, siIntercom, siStripe, siGreenhouse,
  siNotion, siLinear, siAirtable, siGithub, siPosthog, siPlausibleanalytics,
  siSentry, siFigma, siGooglecalendar, siGooglebigquery, siGooglecloud,
} from "simple-icons";
import { Settings2 } from "lucide-react";
import { DeliverablesHub } from "./DeliverablesHub";
import { AgentPlanning, type PlanStep, type PlanStepStatus } from "@/components/ui/ai-planning";
import { MissionWizard, type MissionDraft } from "./MissionWizard";
import {
  type InternalAgent, type Mission, type MissionRun, type Deliverable,
  type WorkspaceMemberRow, type RunEvent,
  type AgentConversation, type AgentMemory, type MemoryKind, type BoardColumn,
  type A2AMessage,
  PRIORITY_META, MEMORY_KIND_META, BOARD_COLUMNS, loadWorkspaceMembers, memberLabel,
  dueDateMeta, downloadDeliverable, relativeDate,
} from "./shared";

export type InternalAgentTab =
  | "chat"
  | "mission"
  | "deliverables"
  | "artifacts"
  | "customize"
  // Legacy sub-slugs — still valid so old deep-links resolve; they now open the
  // "Personnaliser" tab on the matching sub-section instead of a standalone tab.
  | "skills"
  | "memory"
  | "connectors"
  | "instructions"
  | "collaboration"
  | "channels"
  | "analytics"
  | "settings";

const VALID_TABS: InternalAgentTab[] = [
  "chat", "mission", "deliverables", "artifacts", "customize",
  "skills", "memory", "connectors", "instructions",
  "collaboration", "channels", "analytics", "settings",
];

export function InternalAgentDetailPage() {
  const { agentId, tab: tabParam } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const tab: InternalAgentTab = VALID_TABS.includes(tabParam as InternalAgentTab)
    ? (tabParam as InternalAgentTab)
    : "chat";

  const { data: agent, isLoading } = useQuery({
    queryKey: ["internal_agent", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents")
        .select("*")
        .eq("id", agentId!)
        .maybeSingle();
      return data as InternalAgent | null;
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!agent) return <EmptyState icon={Bot} title="Agent not found" />;

  // The route is full-bleed: the chat fills the whole area (scrollbar at the
  // screen edge); the other tabs restore their own padding + max-width + scroll.
  if (tab === "chat") {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <ChatTab agent={agent} workspaceId={workspaceId} projectId={projectId} />
      </div>
    );
  }
  // Collaboration is full-bleed too — a two-panel split that fills the whole area.
  if (tab === "collaboration") {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden p-4 sm:p-6">
        <CollaborationTab agent={agent} />
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-4 sm:py-6 lg:px-6">
      <div className="mx-auto w-full max-w-6xl">
        {MISSION_TAB_SLUGS.includes(tab) && <MissionsHubTab agent={agent} workspaceId={workspaceId} projectId={projectId} initialSection={missionSectionFor(tab)} />}
        {CUSTOMIZE_TAB_SLUGS.includes(tab) && <CustomizeTab agent={agent} initialSection={customizeSectionFor(tab)} />}
        {tab === "channels" && <AgentChannelsTab agent={agent} />}
        {tab === "analytics" && <AnalyticsTab agent={agent} />}
        {tab === "settings" && <SettingsTab agent={agent} />}
      </div>
    </div>
  );
}

// Reusable agent tab body — lets other surfaces (e.g. the CRM record view)
// embed the real agent tabs (Chat / Missions / Deliverables / …) by agent id,
// without leaving their module. Loads the agent then renders the chosen tab.
export function AgentTabContent({ agentId, tab, embedded }: { agentId: string; tab: InternalAgentTab; embedded?: boolean }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { data: agent, isLoading } = useQuery({
    queryKey: ["internal_agent", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("*").eq("id", agentId).maybeSingle();
      return data as InternalAgent | null;
    },
  });
  if (isLoading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!agent) return <EmptyState icon={Bot} title="Agent not found" />;
  return (
    <>
      {tab === "chat" && <ChatTab agent={agent} workspaceId={workspaceId} projectId={projectId} />}
      {MISSION_TAB_SLUGS.includes(tab) && <MissionsHubTab agent={agent} workspaceId={workspaceId} projectId={projectId} initialSection={missionSectionFor(tab)} embedded={embedded} />}
      {CUSTOMIZE_TAB_SLUGS.includes(tab) && <CustomizeTab agent={agent} initialSection={customizeSectionFor(tab)} embedded={embedded} />}
      {tab === "collaboration" && <CollaborationTab agent={agent} />}
      {tab === "channels" && <AgentChannelsTab agent={agent} />}
      {tab === "analytics" && <AnalyticsTab agent={agent} />}
      {tab === "settings" && <SettingsTab agent={agent} embedded={embedded} />}
    </>
  );
}

// Inline horizontal sub-tab bar — used when the agent tabs are embedded in
// another surface (the CRM record view), where sub-tabs must render inside the
// content instead of being published to the global navbar.
function InlineSubTabs<T extends string>({
  sections, active, onSelect,
}: {
  sections: { key: T; label: string; icon: any }[];
  active: T;
  onSelect: (k: T) => void;
}) {
  return (
    <div className="mb-4 flex items-center gap-1 overflow-x-auto border-b border-border">
      {sections.map((s) => {
        const Icon = s.icon;
        const on = s.key === active;
        return (
          <button
            key={s.key}
            onClick={() => onSelect(s.key)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
              on
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />} {s.label}
          </button>
        );
      })}
    </div>
  );
}

// ============================================================================
// CUSTOMIZE TAB ("Personnaliser") — one sidebar entry that groups the agent's
// configuration surfaces (instructions, skills, memory, connectors) behind a
// horizontal sub-tab bar, mirroring the SettingsTab sub-tab pattern. Keeps the
// secondary sidebar short instead of one entry per surface.
// ============================================================================

type CustomizeSection = "instructions" | "skills" | "memory" | "connectors" | "automation";

const CUSTOMIZE_SECTIONS: { key: CustomizeSection; label: string; icon: any }[] = [
  { key: "instructions", label: "Instructions", icon: FileText },
  { key: "skills", label: "Skills", icon: Zap },
  { key: "memory", label: "Memory", icon: Brain },
  { key: "connectors", label: "Connectors", icon: Plug },
  { key: "automation", label: "Automation", icon: Workflow },
];

// Tab slugs that now resolve to the Customize tab. The legacy slugs
// (skills/memory/instructions/connectors) open it on the matching sub-section so
// old deep-links keep working.
const CUSTOMIZE_TAB_SLUGS: InternalAgentTab[] = [
  "customize", "skills", "memory", "connectors", "instructions",
];

function customizeSectionFor(tab: InternalAgentTab): CustomizeSection | undefined {
  if (tab === "skills") return "skills";
  if (tab === "memory") return "memory";
  if (tab === "instructions") return "instructions";
  if (tab === "connectors") return "connectors";
  return undefined; // "customize" → default (instructions)
}

function CustomizeTab({ agent, initialSection, embedded }: { agent: InternalAgent; initialSection?: CustomizeSection; embedded?: boolean }) {
  const [section, setSection] = useState<CustomizeSection>(initialSection ?? "instructions");
  // The sub-tabs (Instructions · Skills · Memory · Connectors) render up in the
  // Topbar (where the breadcrumb used to be) — except when embedded (CRM record
  // view), where they render inline so they don't leak into the global navbar.
  useRegisterTopbarTabs(embedded ? null : CUSTOMIZE_SECTIONS, section, (k) => setSection(k as CustomizeSection));
  return (
    <div>
      {embedded && <InlineSubTabs sections={CUSTOMIZE_SECTIONS} active={section} onSelect={setSection} />}
      {section === "instructions" && <InstructionsEditor agent={agent} />}
      {section === "skills" && <SkillsTab agentId={agent.id} />}
      {section === "memory" && <MemoryTab agent={agent} />}
      {section === "connectors" && <AgentConnectorsTab agent={agent} />}
      {section === "automation" && <AgentAutomationsTab agent={agent} />}
    </div>
  );
}

// ============================================================================
// CONNECTORS — Perplexity-style gallery of app integrations the agent can use.
// Real brand logos come from the Simple Icons CDN, with the provider's lucide
// icon as a fallback when a brand isn't found.
// ============================================================================

// Real brand logos from the `simple-icons` package (inline SVG, official brand
// colour). Only the brands Simple Icons actually ships are mapped — the rest
// (Slack, Salesforce, Teams, LinkedIn… removed upstream for trademark reasons)
// fall back to the provider's lucide icon.
type BrandGlyph = { hex: string; path: string; title: string };
const BRAND_ICONS: Record<string, BrandGlyph> = {
  discord: siDiscord,
  telegram: siTelegram,
  hubspot: siHubspot,
  intercom: siIntercom,
  stripe: siStripe,
  greenhouse: siGreenhouse,
  notion: siNotion,
  linear: siLinear,
  airtable: siAirtable,
  github: siGithub,
  posthog: siPosthog,
  plausible: siPlausibleanalytics,
  sentry: siSentry,
  figma: siFigma,
  "google-calendar": siGooglecalendar,
  bigquery: siGooglebigquery,
  gcs: siGooglecloud,
};

// Brands Simple Icons no longer ships (trademark removals) → real logo by domain
// via the Clearbit logo CDN, then the lucide icon as a last resort.
const BRAND_DOMAIN: Record<string, string> = {
  slack: "slack.com",
  teams: "microsoft.com",
  salesforce: "salesforce.com",
  pipedrive: "pipedrive.com",
  attio: "attio.com",
  bamboohr: "bamboohr.com",
  deel: "deel.com",
  factorial: "factorialhr.com",
  lever: "lever.co",
  workable: "workable.com",
  "linkedin-talent": "linkedin.com",
};

function BrandIcon({ slug, fallback: Fallback }: { slug: string; fallback: LucideIcon }) {
  const [imgFailed, setImgFailed] = useState(false);
  const icon = BRAND_ICONS[slug];
  if (icon) {
    return (
      <svg role="img" viewBox="0 0 24 24" className="h-5 w-5" fill={`#${icon.hex}`} aria-hidden="true">
        <path d={icon.path} />
      </svg>
    );
  }
  const domain = BRAND_DOMAIN[slug];
  if (domain && !imgFailed) {
    return (
      <img
        src={`https://logo.clearbit.com/${domain}`}
        alt=""
        className="h-5 w-5 rounded-sm object-contain"
        loading="lazy"
        onError={() => setImgFailed(true)}
      />
    );
  }
  return <Fallback className="h-5 w-5 text-zinc-600" />;
}

const CONNECTOR_FILTERS = [
  { key: "all", label: "Tous" },
  { key: "connected", label: "Connecté" },
  { key: "available", label: "Disponible" },
] as const;

function AgentConnectorsTab({ agent }: { agent: InternalAgent }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "connected" | "available">("all");
  const [category, setCategory] = useState<string | null>(null);
  const [configureSlug, setConfigureSlug] = useState<string | null>(null);

  const { data: tools } = useQuery({
    queryKey: ["internal_agent_tools", agent.id],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_tools").select("*").eq("agent_id", agent.id);
      return (data ?? []) as AgentTool[];
    },
  });
  const { data: connectors } = useQuery({
    queryKey: ["project_connectors_for_tools", agent.project_id],
    queryFn: async () => {
      const { data } = await supabase.from("connectors").select("provider, status").eq("project_id", agent.project_id);
      return (data ?? []) as Array<{ provider: string; status: string }>;
    },
  });

  const connectedSet = new Set((connectors ?? []).filter((c) => c.status === "connected").map((c) => c.provider));
  const enabledSet = new Set(
    (tools ?? []).filter((t) => t.kind === "connector_action").map((t) => String(t.config?.provider ?? "")),
  );

  async function toggleIntegration(slug: string) {
    const existing = (tools ?? []).find(
      (t) => t.kind === "connector_action" && String(t.config?.provider ?? "") === slug,
    );
    if (existing) {
      await supabase.from("internal_agent_tools").delete().eq("id", existing.id);
      queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
      return;
    }
    const p = connectorActionProvider(slug);
    const { error } = await supabase.from("internal_agent_tools").insert({
      agent_id: agent.id,
      kind: "connector_action",
      name: p ? `Use ${p.name}` : `Use ${slug}`,
      description: p?.description ?? null,
      config: { provider: slug },
      requires_approval: false,
    });
    if (error) { alert(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
    if (!connectedSet.has(slug)) setConfigureSlug(slug);
  }

  const q = search.trim().toLowerCase();
  const sections = CONNECTOR_ACTION_GROUPS
    .filter((g) => !category || g.label === category)
    .map((g) => ({
      label: g.label,
      items: g.slugs
        .map((slug) => ({ slug, p: connectorActionProvider(slug) }))
        .filter((x): x is { slug: string; p: ProviderDef } => !!x.p)
        .filter(({ slug, p }) => {
          if (filter === "connected" && !connectedSet.has(slug)) return false;
          if (filter === "available" && connectedSet.has(slug)) return false;
          if (q && !`${p.name} ${p.description} ${slug}`.toLowerCase().includes(q)) return false;
          return true;
        }),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="mx-auto max-w-5xl">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Connecteurs</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Connectez des services pour permettre à {agent.name} d'accéder à vos données et d'agir en conséquence.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher tous les connecteurs"
            className="h-10 rounded-lg pl-9"
          />
        </div>
      </div>

      {/* Filter pills + category dropdown */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {CONNECTOR_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-full border px-4 py-1.5 text-sm transition-colors",
                filter === f.key
                  ? "border-border bg-secondary text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
              {category ?? "Toutes les catégories"} <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
            <DropdownMenuItem onClick={() => setCategory(null)}>Toutes les catégories</DropdownMenuItem>
            <DropdownMenuSeparator />
            {CONNECTOR_ACTION_GROUPS.map((g) => (
              <DropdownMenuItem key={g.label} onClick={() => setCategory(g.label)}>{g.label}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Sections by category */}
      {sections.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">Aucun connecteur trouvé.</p>
      ) : (
        <div className="mt-6 space-y-8">
          {sections.map((g) => (
            <div key={g.label}>
              <h3 className="mb-3 text-sm font-semibold text-foreground">{g.label}</h3>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {g.items.map(({ slug, p }) => {
                  const on = enabledSet.has(slug);
                  const connected = connectedSet.has(slug);
                  return (
                    <div
                      key={slug}
                      onClick={() => toggleIntegration(slug)}
                      className={cn(
                        "group relative flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors",
                        on ? "border-primary/50 bg-primary/5" : "border-border bg-card/40 hover:bg-card",
                      )}
                    >
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white">
                        <BrandIcon slug={slug} fallback={p.icon} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-foreground">{p.name}</span>
                          {on && <Check className="h-4 w-4 shrink-0 text-primary" />}
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{p.description}</p>
                        <span className={cn("mt-1.5 inline-flex items-center gap-1 text-[10px]", connected ? "text-emerald-500" : "text-muted-foreground")}>
                          {connected ? <><ShieldCheck className="h-3 w-3" /> Connecté · réutilisé</> : "Non connecté"}
                        </span>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfigureSlug(slug); }}
                        title={connected ? "Reconfigurer les identifiants" : "Configurer les identifiants"}
                        className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover:opacity-100"
                        aria-label="Configurer"
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <ConnectorDialog
        open={!!configureSlug}
        onOpenChange={(o) => { if (!o) setConfigureSlug(null); }}
        provider={configureSlug ? findProvider(configureSlug) ?? null : null}
        workspaceId={agent.workspace_id}
        projectId={agent.project_id}
        onConnected={() => {
          setConfigureSlug(null);
          queryClient.invalidateQueries({ queryKey: ["project_connectors_for_tools", agent.project_id] });
        }}
      />
    </div>
  );
}

// ============================================================================
// MISSIONS HUB — one sidebar entry grouping Missions · Deliverables · Artifacts
// behind topbar sub-tabs (same pattern as Personnaliser). Deliverables and
// artifacts used to be their own sidebar tabs.
// ============================================================================

type MissionSection = "missions" | "deliverables" | "artifacts";

const MISSION_SECTIONS: { key: MissionSection; label: string; icon: any }[] = [
  { key: "missions", label: "Missions", icon: Target },
  { key: "deliverables", label: "Délivrables", icon: Package },
  { key: "artifacts", label: "Artifacts", icon: FileCode },
];

const MISSION_TAB_SLUGS: InternalAgentTab[] = ["mission", "deliverables", "artifacts"];

function missionSectionFor(tab: InternalAgentTab): MissionSection | undefined {
  if (tab === "deliverables") return "deliverables";
  if (tab === "artifacts") return "artifacts";
  return undefined; // "mission" → default (missions)
}

function MissionsHubTab({
  agent, workspaceId, projectId, initialSection, embedded,
}: {
  agent: InternalAgent;
  workspaceId: string | null;
  projectId: string | null;
  initialSection?: MissionSection;
  embedded?: boolean;
}) {
  const [section, setSection] = useState<MissionSection>(initialSection ?? "missions");
  useRegisterTopbarTabs(embedded ? null : MISSION_SECTIONS, section, (k) => setSection(k as MissionSection));
  return (
    <div>
      {embedded && <InlineSubTabs sections={MISSION_SECTIONS} active={section} onSelect={setSection} />}
      {section === "missions" && <MissionTab agent={agent} workspaceId={workspaceId} projectId={projectId} />}
      {section === "deliverables" && <DeliverablesHub agent={agent} />}
      {section === "artifacts" && <AgentArtifactsTab agentId={agent.id} />}
    </div>
  );
}

// ============================================================================
// CHAT TAB — conversation with the agent (uses internal_agent_conversations)
// ============================================================================

interface ChatMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  created_at: string;
  /** The run that produced this assistant turn — anchors its timeline card. */
  run_id?: string | null;
}

// Our base models (the agent runs server-side on DeepSeek, Groq as fallback) —
// shown in the composer's model selector instead of the generic Claude defaults.
const AGENT_MODELS = [
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "Default — strong reasoning & tool calling" },
  { id: "groq-llama-3.3", name: "Groq Llama 3.3", description: "Fast fallback for quick replies" },
];

function ChatTab({
  agent,
  workspaceId,
  projectId,
}: {
  agent: InternalAgent;
  workspaceId: string | null;
  projectId: string | null;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  function openDeliverable(id: string) {
    navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal/${agent.id}/deliverables?d=${id}`);
  }
  const [convoId, setConvoId] = useState<string | null>(null);
  // null convoId + started=false → resume the latest session; once the user
  // clicks "New session" we stay on the blank state until they send.
  const [startedFresh, setStartedFresh] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const { data: conversations } = useQuery({
    queryKey: ["internal_agent_conversations", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_conversations")
        .select("id, agent_id, title, user_id, created_at, updated_at")
        .eq("agent_id", agent.id)
        .order("updated_at", { ascending: false })
        .limit(50);
      return (data ?? []) as AgentConversation[];
    },
  });

  // Is a run for this agent in flight RIGHT NOW (server truth, not local state)?
  // Keeps the live timeline visible across navigation and blocks a second send
  // while the agent works (which would spawn a concurrent run that restarts).
  const { data: activeRun } = useQuery({
    queryKey: ["agent_active_run", agent.id],
    refetchInterval: 3000,
    queryFn: async () => {
      // Lock the composer while a CHAT run is alive. Chat now runs on the durable
      // tick runtime, so it can legitimately last well beyond the Edge wall-clock
      // — no time cap. Genuine zombies are flipped to `failed` by the reconciler
      // (and so drop out of this status filter), which unlocks the composer.
      const { data } = await supabase
        .from("internal_agent_runs")
        .select("id, status")
        .eq("agent_id", agent.id)
        .eq("triggered_via", "chat")
        .in("status", ["running", "queued"])
        .order("created_at", { ascending: false })
        .limit(1);
      return (data?.[0] ?? null) as { id: string; status: string } | null;
    },
  });
  const isBusy = sending || !!activeRun;

  // Resume the most recent session by default.
  useEffect(() => {
    if (!convoId && !startedFresh && conversations && conversations.length > 0) {
      setConvoId(conversations[0].id);
    }
  }, [conversations, convoId, startedFresh]);

  async function deleteConversation(id: string) {
    if (!confirm("Delete this session and its messages?")) return;
    await supabase.from("internal_agent_conversations").delete().eq("id", id);
    if (convoId === id) { setConvoId(null); setStartedFresh(true); }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_conversations", agent.id] });
  }

  const { data: messages } = useQuery({
    queryKey: ["internal_agent_messages", convoId],
    enabled: !!convoId,
    // While a run is in flight, poll so the agent's reply appears even if the
    // user navigated away and came back (the run finishes server-side).
    refetchInterval: isBusy ? 2500 : false,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_messages")
        .select("id, conversation_id, role, content, tool_calls, tokens_in, tokens_out, cost_usd, created_at, run_id")
        .eq("conversation_id", convoId!)
        .order("created_at", { ascending: true });
      return (data ?? []) as ChatMessage[];
    },
  });

  // Deliverables this agent produced during this chat session — rendered as
  // artifact cards under the matching assistant message.
  const { data: convoDeliverables } = useQuery({
    queryKey: ["internal_agent_convo_deliverables", convoId],
    enabled: !!convoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_deliverables")
        .select("id, kind, name, summary, created_at")
        .eq("conversation_id", convoId!)
        .order("created_at", { ascending: true });
      return (data ?? []) as Array<{ id: string; kind: string; name: string; summary: string | null; created_at: string }>;
    },
  });

  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages?.length]);

  async function handleSend(text: string) {
    if (!user || !workspaceId || !projectId || !text.trim() || sending) return;
    // NB: sending is allowed WHILE a run is active — the message is folded into the
    // running agent on its next tick (mid-run steering), not queued as a new run.
    if (!agent?.id) { setError("Agent is still loading — please retry in a moment."); return; }
    setSending(true);
    setError(null);
    try {
      let cid = convoId;
      if (!cid) {
        const { data, error } = await supabase
          .from("internal_agent_conversations")
          .insert({
            agent_id: agent.id,
            workspace_id: workspaceId,
            project_id: projectId,
            user_id: user.id,
            title: text.slice(0, 60),
          })
          .select("id")
          .single();
        if (error) throw error;
        cid = data!.id;
        setConvoId(cid);
      }
      const { error: msgErr } = await supabase
        .from("internal_agent_messages")
        .insert({ conversation_id: cid, agent_id: agent.id, role: "user", content: text });
      if (msgErr) throw msgErr;
      setInput("");
      queryClient.invalidateQueries({ queryKey: ["internal_agent_messages", cid] });

      // Call the worker edge in "chat" mode. It now runs the agent loop in the
      // BACKGROUND and returns immediately (avoids the 504 on long runs), so we
      // poll the run until it finishes while the live timeline streams progress.
      const resp = await callEdge<{ run_id?: string; async?: boolean }>("internal-agent-run", {
        agent_id: agent.id,
        mode: "chat",
        conversation_id: cid,
      });
      const runId = resp?.run_id ?? null;
      if (runId && resp?.async) {
        const deadline = Date.now() + 8 * 60 * 1000; // safety cap
        // eslint-disable-next-line no-constant-condition
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          queryClient.invalidateQueries({ queryKey: ["internal_agent_messages", cid] });
          const { data: run } = await supabase
            .from("internal_agent_runs")
            .select("status")
            .eq("id", runId)
            .maybeSingle();
          const st = (run as { status?: string } | null)?.status;
          if (st && st !== "running" && st !== "queued") break;
        }
      }
      queryClient.invalidateQueries({ queryKey: ["internal_agent_messages", cid] });
      queryClient.invalidateQueries({ queryKey: ["internal_agent_conversations", agent.id] });
      queryClient.invalidateQueries({ queryKey: ["internal_agent_convo_deliverables", cid] });
    } catch (e: any) {
      setError(e?.message ?? "Failed to send");
    } finally {
      setSending(false);
    }
  }

  const isEmpty = !messages || messages.length === 0;
  const currentConvo = conversations?.find((c) => c.id === convoId) ?? null;

  return (
    <div className="font-poppins relative flex h-full min-h-0 flex-col">
      {/* Floating session switcher — overlays the chat, no full-width navbar */}
      <div className="absolute left-2 top-2 z-20">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 max-w-[240px] gap-1 rounded-lg border border-border/60 bg-background/70 px-2 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground">
              <History className="mr-1 h-3.5 w-3.5 shrink-0" />
              <span className="truncate text-xs">
                {currentConvo ? (currentConvo.title || "Untitled session") : "New session"}
              </span>
              <ChevronDown className="ml-0.5 h-3.5 w-3.5 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuItem
              onClick={() => { setConvoId(null); setStartedFresh(true); setError(null); }}
            >
              <Plus className="mr-2 h-3.5 w-3.5" /> New session
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">
              Recent sessions
            </DropdownMenuLabel>
            {!conversations || conversations.length === 0 ? (
              <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">No sessions yet.</div>
            ) : (
              <div className="max-h-72 overflow-y-auto">
                {conversations.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    className={cn("group flex items-center gap-2", convoId === c.id && "bg-foreground/5")}
                    onClick={() => { setConvoId(c.id); setStartedFresh(false); setError(null); }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{c.title || "Untitled session"}</div>
                      <div className="text-[10px] text-muted-foreground">{relativeDate(c.updated_at)}</div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteConversation(c.id); }}
                      className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                      title="Delete session"
                    >
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </button>
                  </DropdownMenuItem>
                ))}
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isEmpty ? (
        // Perplexity-style hero: centered title + composer + suggestion cards.
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-10">
          <AgentAvatar
            url={agent.avatar_url}
            seed={agent.name}
            className="mb-4 h-14 w-14 overflow-hidden rounded-2xl"
          />
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">{agent.name}</h1>
          {agent.description && (
            <p className="mt-2 max-w-md text-center text-sm text-muted-foreground">{agent.description}</p>
          )}
          <div className="mt-7 w-full max-w-2xl">
            <ChatComposer
              value={input}
              onValueChange={setInput}
              onSubmit={({ message }) => handleSend(message)}
              loading={isBusy}
              disabled={isBusy}
              placeholder={isBusy ? "L'agent travaille…" : `Demandez à ${agent.name}…`}
              models={AGENT_MODELS}
              className="max-w-full"
            />
            {error && <p className="mt-2 text-center text-xs text-destructive">{error}</p>}
          </div>
          <div className="mt-5 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
            <button
              onClick={() => setInput("Quelles sont tes capacités, et que peux-tu faire pour moi ?")}
              className="rounded-2xl border p-4 text-left transition-all hover:brightness-110"
              style={{ background: "linear-gradient(135deg, hsl(187 48% 18% / 0.6), hsl(187 45% 11% / 0.35))", borderColor: "hsl(187 45% 35% / 0.4)" }}
            >
              <div className="mb-1 flex items-center gap-2 text-sm font-medium text-foreground">
                <Search className="h-4 w-4" style={{ color: "hsl(187 65% 62%)" }} /> Poser une question
              </div>
              <p className="text-xs text-foreground/70">Réponses rapides et sourcées à partir du web et de tes données.</p>
            </button>
            <button
              onClick={() => setInput("Analyse un dataset, construis un modèle prédictif et rends-moi un rapport structuré avec graphes.")}
              className="rounded-2xl border p-4 text-left transition-all hover:brightness-110"
              style={{ background: "linear-gradient(135deg, hsl(255 40% 24% / 0.55), hsl(255 40% 14% / 0.3))", borderColor: "hsl(255 45% 50% / 0.4)" }}
            >
              <div className="mb-1 flex items-center gap-2 text-sm font-medium text-foreground">
                <Target className="h-4 w-4" style={{ color: "hsl(255 65% 74%)" }} /> Confier une tâche
              </div>
              <p className="text-xs text-foreground/70">Donne-lui un projet : il produit des livrables fiables, en autonomie.</p>
            </button>
          </div>
        </div>
      ) : (
        <>
          <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-4xl space-y-8 px-6 pb-6 pt-14">
              {messages!.map((m, i) => {
                const isLastAssistant =
                  m.role === "assistant" &&
                  !messages!.slice(i + 1).some((x) => x.role === "assistant");
                return (
                  <div key={m.id} className="space-y-3">
                    {/* Persistent run card: each assistant turn keeps its own
                        timeline (todos + actions), collapsed, re-openable —
                        Claude-Code-style. Skipped while that run is still the
                        ACTIVE one (the live card below already shows it). */}
                    {m.role === "assistant" && m.run_id && m.run_id !== activeRun?.id && (
                      <RunTimeline runId={m.run_id} />
                    )}
                    <ChatBubble
                      msg={m}
                      artifacts={isLastAssistant ? (convoDeliverables ?? []) : []}
                      onOpenArtifact={openDeliverable}
                      onEdit={(c) => setInput(c)}
                      onResend={(c) => handleSend(c)}
                    />
                  </div>
                );
              })}
              {/* Live run — anchored on the ACTIVE run id (never "latest run"),
                  so it can't vanish mid-run or mix runs. */}
              {activeRun && <RunTimeline runId={activeRun.id} live defaultOpen />}
              {sending && !activeRun && (
                <div className="flex items-center gap-2 rounded-xl border border-blue-500/30 bg-card px-3.5 py-2.5 text-sm text-blue-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> Démarrage du run…
                </div>
              )}
            </div>
          </div>
          <div className="shrink-0 bg-gradient-to-t from-background via-background/95 to-transparent pt-2 pb-7 backdrop-blur">
            <div className="mx-auto w-full max-w-4xl px-6">
              <ChatComposer
                value={input}
                onValueChange={setInput}
                onSubmit={({ message }) => handleSend(message)}
                loading={false}
                disabled={false}
                running={isBusy}
                placeholder={isBusy ? "L'agent travaille — écris pour ajouter ou corriger en cours de route…" : `Message ${agent.name}…`}
                models={AGENT_MODELS}
                className="max-w-full"
              />
              {error && <p className="mt-2 text-center text-xs text-destructive">{error}</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface ChatArtifact { id: string; kind: string; name: string; summary: string | null }

function ChatBubble({
  msg, artifacts = [], onOpenArtifact, onEdit, onResend,
}: {
  msg: ChatMessage;
  artifacts?: ChatArtifact[];
  onOpenArtifact?: (id: string) => void;
  onEdit?: (content: string) => void;
  onResend?: (content: string) => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="group flex flex-col items-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-foreground/10 px-4 py-2.5 text-sm leading-relaxed">{msg.content}</div>
        <UserMessageActions content={msg.content} createdAt={msg.created_at} onEdit={onEdit} onResend={onResend} />
      </div>
    );
  }
  if (msg.role === "tool") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs font-mono text-muted-foreground">
          <Wrench className="mb-1 inline h-3 w-3" /> {msg.content}
        </div>
      </div>
    );
  }
  const toolCalls = msg.tool_calls ?? [];

  // Build rich tool call steps for AgentPlanning
  const toolSteps: PlanStep[] = toolCalls.map((tc, i) => {
    const name = tc.name;
    const args = tc.args ?? {};
    const argsStr = JSON.stringify(args, null, 2);

    // Icon based on tool type
    let icon: React.ReactNode = <TerminalSquare className="w-3.5 h-3.5" />;
    if (name.includes("browser") || name === "browse_web") icon = <Globe className="w-3.5 h-3.5" />;
    else if (name.includes("search") || name === "deep_research") icon = <Search className="w-3.5 h-3.5" />;
    else if (name.includes("file") || name === "list_files") icon = <FileText className="w-3.5 h-3.5" />;
    else if (name.includes("python") || name.includes("nodejs") || name === "shell_exec" || name === "jupyter_exec") icon = <TerminalSquare className="w-3.5 h-3.5" />;
    else if (name === "create_deliverable") icon = <Package className="w-3.5 h-3.5" />;
    else if (name === "save_memory" || name === "search_memory") icon = <Brain className="w-3.5 h-3.5" />;
    else if (name === "send_email") icon = <Globe className="w-3.5 h-3.5" />;
    else if (name === "http_get") icon = <Globe className="w-3.5 h-3.5" />;

    // Build a human-readable summary
    let summary = name;
    if (name === "http_get" && args.url) summary = `GET ${String(args.url).slice(0, 60)}`;
    else if (name === "browse_web" && args.url) summary = `Navigate → ${String(args.url).slice(0, 60)}`;
    else if (name === "browse_web" && args.action) summary = `Browser: ${args.action} ${args.selector ? `on ${String(args.selector).slice(0, 30)}` : ""}`;
    else if (name === "web_search") summary = `Search: "${String(args.query ?? "").slice(0, 50)}"`;
    else if (name === "deep_research") summary = `Research: "${String(args.query ?? "").slice(0, 50)}"`;
    else if (name === "file_write") summary = `Write file: ${String(args.path ?? "").slice(0, 40)}`;
    else if (name === "file_read") summary = `Read file: ${String(args.path ?? "").slice(0, 40)}`;
    else if (name === "shell_exec") summary = `$ ${String(args.command ?? "").slice(0, 60)}`;
    else if (name === "python_exec") summary = `Python: ${String(args.code ?? "").slice(0, 50)}…`;
    else if (name === "nodejs_exec") summary = `Node: ${String(args.code ?? "").slice(0, 50)}…`;
    else if (name === "jupyter_exec") summary = `Jupyter: ${String(args.code ?? "").slice(0, 50)}…`;
    else if (name === "create_deliverable") summary = `Create: ${String(args.name ?? "deliverable")}`;
    else if (name === "create_task") summary = `Task: ${String(args.title ?? "")}`;
    else if (name === "save_memory") summary = `Remember: ${String(args.content ?? "").slice(0, 40)}…`;
    else if (name === "sandbox_browser_action") summary = `Browser ${String(args.action ?? "")}`;
    else if (name === "mcp_call_tool") summary = `MCP: ${String(args.tool_name ?? "")}`;

    return {
      id: String(i),
      title: summary,
      status: "success" as PlanStepStatus,
      icon,
      content: argsStr.length > 5 ? (
        <div className="font-mono text-[11px] mt-1 rounded-md bg-zinc-950 border border-border/50 p-2.5 text-zinc-400 max-h-48 overflow-y-auto whitespace-pre-wrap">
          {argsStr.slice(0, 3000)}
        </div>
      ) : undefined,
    };
  });

  return (
    <div className="group flex justify-start">
      <div className="w-full max-w-[95%]">
        {/* Tool calls timeline */}
        {toolSteps.length > 0 && (
          <AgentPlanning
            title={`${toolSteps.length} tool${toolSteps.length > 1 ? "s" : ""} used · ${msg.tokens_in ?? 0} tokens in · ${msg.tokens_out ?? 0} out${msg.cost_usd ? ` · $${msg.cost_usd.toFixed(4)}` : ""}`}
            steps={toolSteps}
          />
        )}
        {/* Message content */}
        {msg.content && msg.content.trim() && (
          <div className="chat-prose break-words">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
          </div>
        )}
        {artifacts.length > 0 && (
          <div className="mt-3 space-y-2">
            {artifacts.map((a) => (
              <ArtifactCard key={a.id} artifact={a} onOpen={() => onOpenArtifact?.(a.id)} />
            ))}
          </div>
        )}
        {/* Quick actions under the AI reply */}
        {msg.content && msg.content.trim() && <MessageActions content={msg.content} />}
      </div>
    </div>
  );
}

// Quick-action row under a USER message (right-aligned, on hover): time, resend,
// edit (puts the text back in the composer), copy.
function UserMessageActions({ content, createdAt, onEdit, onResend }: {
  content: string;
  createdAt?: string;
  onEdit?: (content: string) => void;
  onResend?: (content: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  const btn = "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground";
  return (
    <div className="mt-1 mr-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      {createdAt && <span className="mr-1 text-[11px] text-muted-foreground/70 tabular-nums">{new Date(createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>}
      {onResend && (
        <button onClick={() => onResend(content)} className={btn} title="Renvoyer" aria-label="Renvoyer">
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}
      {onEdit && (
        <button onClick={() => onEdit(content)} className={btn} title="Modifier" aria-label="Modifier">
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
      <button onClick={copy} className={btn} title={copied ? "Copié" : "Copier"} aria-label="Copier">
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

// Quick-action row under an assistant reply: copy + thumbs feedback.
function MessageActions({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const copy = async () => {
    try { await navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  const btn = "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground";
  return (
    <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      <button onClick={copy} className={btn} title={copied ? "Copié" : "Copier"} aria-label="Copier">
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <button onClick={() => setVote(vote === "up" ? null : "up")} className={cn(btn, vote === "up" && "text-emerald-500")} title="Bonne réponse" aria-label="Pouce en haut">
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <button onClick={() => setVote(vote === "down" ? null : "down")} className={cn(btn, vote === "down" && "text-rose-500")} title="Réponse à améliorer" aria-label="Pouce en bas">
        <ThumbsDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// A clickable card representing a deliverable the agent produced in chat.
function ArtifactCard({ artifact, onOpen }: { artifact: ChatArtifact; onOpen: () => void }) {
  const Icon =
    artifact.kind === "report" ? BarChart3
    : artifact.kind === "json" ? Database
    : artifact.kind === "code" ? FileText
    : artifact.kind === "url" ? Globe
    : FileText;
  const label = artifact.kind === "report" ? "Structured report" : artifact.kind;
  return (
    <button
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-600 text-white">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{artifact.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {artifact.summary || label}
        </div>
      </div>
      <span className="flex items-center gap-1 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
        Open <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

// ============================================================================
// MISSION TAB — give the agent a structured task with deliverables
// ============================================================================

function MissionTab({
  agent,
  workspaceId,
  projectId,
}: {
  agent: InternalAgent;
  workspaceId: string | null;
  projectId: string | null;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [dragOverCol, setDragOverCol] = useState<BoardColumn | null>(null);
  const [view, setView] = useState<"board" | "cards">("board");

  const { data: missions } = useQuery({
    queryKey: ["internal_agent_missions", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_missions")
        .select("id, agent_id, title, brief, acceptance_criteria, expected_deliverables, status, priority, due_date, assigned_to, tags, schedule, board_column, last_run_at, next_run_at, created_at")
        .eq("agent_id", agent.id)
        .neq("status", "archived")
        .order("updated_at", { ascending: false });
      return (data ?? []) as Mission[];
    },
    // The agent moves cards itself (move_mission + worker auto-moves):
    // refresh the board while any of its missions is being worked on.
    refetchInterval: (q) =>
      (q.state.data as Mission[] | undefined)?.some((m) => m.board_column === "in_progress") ? 4000 : false,
  });

  const { data: members } = useQuery({
    queryKey: ["ws_members_for_assign", agent.workspace_id],
    enabled: !!agent.workspace_id,
    queryFn: () => loadWorkspaceMembers(agent.workspace_id),
  });
  const memberById = useMemo(() => {
    const m: Record<string, WorkspaceMemberRow> = {};
    (members ?? []).forEach((x) => { m[x.user_id] = x; });
    return m;
  }, [members]);

  const selected = useMemo(
    () => missions?.find((m) => m.id === selectedId) ?? null,
    [missions, selectedId],
  );

  async function moveMission(missionId: string, column: BoardColumn) {
    // Optimistic: snap the card into place before the round-trip.
    queryClient.setQueryData(["internal_agent_missions", agent.id], (old: Mission[] | undefined) =>
      (old ?? []).map((m) => (m.id === missionId ? { ...m, board_column: column } : m)));
    await supabase
      .from("internal_agent_missions")
      .update({ board_column: column, updated_at: new Date().toISOString() })
      .eq("id", missionId);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_missions", agent.id] });
  }

  async function createMission(draft: MissionDraft) {
    if (!user || !workspaceId || !projectId) return;
    const { data, error } = await supabase
      .from("internal_agent_missions")
      .insert({
        agent_id: agent.id,
        workspace_id: workspaceId,
        project_id: projectId,
        title: draft.title,
        brief: draft.brief || null,
        acceptance_criteria: draft.acceptance_criteria || null,
        expected_deliverables: draft.expected_deliverables,
        priority: draft.priority,
        due_date: draft.due_date,
        assigned_to: draft.assigned_to,
        tags: draft.tags,
        schedule: draft.schedule,
        // Scheduled missions become due immediately; the scheduler then bumps
        // next_run_at after each run.
        next_run_at: draft.schedule ? new Date().toISOString() : null,
        status: "active",
        created_by: user.id,
      })
      .select("id")
      .single();
    if (error) {
      alert(error.message);
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_missions", agent.id] });
    setWizardOpen(false);
    if (data) setSelectedId(data.id);
  }

  // Inline detail (no side-by-side): selecting a card swaps the board out.
  if (selected) {
    return (
      <div className="space-y-3">
        <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)}>
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Board
        </Button>
        <MissionDetail mission={selected} agent={agent} members={members ?? []} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {view === "board"
            ? "Drag cards between columns — the agent moves them too as it works (running → In progress, output ready → Review)."
            : "Toutes les missions en cartes. Cliquez une carte pour l'ouvrir."}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <ViewToggle view={view} onChange={setView} />
          <Button size="sm" onClick={() => setWizardOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Assign mission
          </Button>
        </div>
      </div>

      {(!missions || missions.length === 0) ? (
        <EmptyState
          icon={Target}
          title="Assign a mission"
          description="Give this agent a structured task with a brief, expected deliverables, an owner and a deadline."
          action={<Button onClick={() => setWizardOpen(true)}><Plus className="mr-1.5 h-3.5 w-3.5" /> Assign mission</Button>}
        />
      ) : view === "cards" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(missions ?? []).map((m) => (
            <MissionCard
              key={m.id}
              m={m}
              showStatus
              assignee={m.assigned_to ? memberById[m.assigned_to] : undefined}
              onOpen={() => setSelectedId(m.id)}
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {BOARD_COLUMNS.map((col) => {
            const cards = (missions ?? []).filter((m) => (m.board_column ?? "todo") === col.key);
            return (
              <div
                key={col.key}
                onDragOver={(e) => { e.preventDefault(); setDragOverCol(col.key); }}
                onDragLeave={() => setDragOverCol((c) => (c === col.key ? null : c))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverCol(null);
                  const id = e.dataTransfer.getData("text/mission-id");
                  if (id) moveMission(id, col.key);
                }}
                className={cn(
                  "flex min-h-[280px] flex-col rounded-lg border bg-muted/20 transition-colors",
                  dragOverCol === col.key ? "border-primary/60 bg-primary/5" : "border-border",
                )}
              >
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <span className={cn("h-2 w-2 rounded-full", col.accent)} />
                  <span className="text-xs font-semibold">{col.label}</span>
                  <span className="ml-auto rounded-full bg-foreground/10 px-1.5 text-[10px] text-muted-foreground">{cards.length}</span>
                </div>
                <div className="flex-1 space-y-2 px-2 pb-2">
                  {cards.map((m) => (
                    <MissionCard
                      key={m.id}
                      m={m}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/mission-id", m.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      assignee={m.assigned_to ? memberById[m.assigned_to] : undefined}
                      onOpen={() => setSelectedId(m.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <MissionWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        workspaceId={workspaceId}
        onSubmit={createMission}
      />
    </div>
  );
}

// Kanban/board view switcher.
function ViewToggle({ view, onChange }: { view: "board" | "cards"; onChange: (v: "board" | "cards") => void }) {
  const opts = [
    { key: "board", label: "Kanban", icon: Columns3 },
    { key: "cards", label: "Cartes", icon: LayoutGrid },
  ] as const;
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
      {opts.map((v) => (
        <button
          key={v.key}
          onClick={() => onChange(v.key)}
          className={cn(
            "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
            view === v.key ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <v.icon className="h-3.5 w-3.5" /> {v.label}
        </button>
      ))}
    </div>
  );
}

// A mission rendered as a rich card — used both in the Kanban columns
// (draggable) and in the flat "Cartes" grid (showStatus adds the column badge).
function MissionCard({
  m, assignee, onOpen, draggable, onDragStart, showStatus,
}: {
  m: Mission;
  assignee?: WorkspaceMemberRow;
  onOpen: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  showStatus?: boolean;
}) {
  const pr = PRIORITY_META[m.priority];
  const due = dueDateMeta(m.due_date);
  const col = BOARD_COLUMNS.find((c) => c.key === (m.board_column ?? "todo"));
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onOpen}
      className={cn(
        "group rounded-xl border border-border bg-background p-3 shadow-sm transition-all hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-md",
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
      )}
    >
      <div className="flex items-start gap-2">
        <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", pr.dot)} title={pr.label} />
        <span className="line-clamp-2 flex-1 text-sm font-medium leading-tight">{m.title}</span>
        {m.board_column === "in_progress" && (
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-amber-500" />
        )}
      </div>
      {m.brief && <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{m.brief}</p>}
      {(showStatus && col) || (m.tags && m.tags.length > 0) ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {showStatus && col && (
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
              <span className={cn("h-1.5 w-1.5 rounded-full", col.accent)} /> {col.label}
            </span>
          )}
          {(m.tags ?? []).slice(0, 2).map((t) => (
            <span key={t} className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">{t}</span>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        {m.schedule && (
          <span className="inline-flex items-center gap-0.5"><Repeat className="h-2.5 w-2.5" />{m.schedule}</span>
        )}
        {due && (
          <span className={cn("inline-flex items-center gap-0.5", due.overdue && "text-destructive")}>
            <CalendarClock className="h-2.5 w-2.5" />{due.label}
          </span>
        )}
        {assignee && (
          <span className="inline-flex items-center gap-0.5">
            <UserCircle2 className="h-2.5 w-2.5" />{memberLabel(assignee)}
          </span>
        )}
      </div>
    </div>
  );
}

function MissionDetail({
  mission, agent, members,
}: {
  mission: Mission;
  agent: InternalAgent;
  members: WorkspaceMemberRow[];
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(mission.title);
  const [brief, setBrief] = useState(mission.brief ?? "");
  const [acceptance, setAcceptance] = useState(mission.acceptance_criteria ?? "");
  const [deliverables, setDeliverables] = useState(mission.expected_deliverables ?? []);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [launching, setLaunching] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const assignee = mission.assigned_to ? members.find((m) => m.user_id === mission.assigned_to) : undefined;
  const due = dueDateMeta(mission.due_date);
  const pr = PRIORITY_META[mission.priority];

  // Hydrate fields when switching mission.
  useEffect(() => {
    setTitle(mission.title);
    setBrief(mission.brief ?? "");
    setAcceptance(mission.acceptance_criteria ?? "");
    setDeliverables(mission.expected_deliverables ?? []);
  }, [mission.id]);

  async function saveFromWizard(draft: MissionDraft) {
    const { error } = await supabase
      .from("internal_agent_missions")
      .update({
        title: draft.title,
        brief: draft.brief || null,
        acceptance_criteria: draft.acceptance_criteria || null,
        expected_deliverables: draft.expected_deliverables,
        priority: draft.priority,
        due_date: draft.due_date,
        assigned_to: draft.assigned_to,
        tags: draft.tags,
        schedule: draft.schedule,
        next_run_at: draft.schedule ? (mission.next_run_at ?? new Date().toISOString()) : null,
        updated_by: user?.id ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", mission.id);
    if (error) { alert(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_missions", agent.id] });
    setEditOpen(false);
  }

  async function save() {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("internal_agent_missions")
        .update({
          title,
          brief,
          acceptance_criteria: acceptance,
          expected_deliverables: deliverables,
          updated_at: new Date().toISOString(),
        })
        .eq("id", mission.id);
      if (error) throw error;
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["internal_agent_missions", agent.id] });
    } finally {
      setSaving(false);
    }
  }

  async function launchRun() {
    if (!user) return;
    setLaunching(true);
    try {
      const { data, error } = await supabase
        .from("internal_agent_runs")
        .insert({
          mission_id: mission.id,
          agent_id: agent.id,
          workspace_id: agent.workspace_id,
          project_id: agent.project_id,
          status: "queued",
          triggered_by: user.id,
        })
        .select("id")
        .single();
      if (error) throw error;
      // Fire-and-forget worker invocation. Worker writes events/deliverables async.
      try { await callEdge("internal-agent-run", { agent_id: agent.id, mode: "mission", run_id: data!.id }); }
      catch { /* swallow — worker will be picked up on next poll */ }
      queryClient.invalidateQueries({ queryKey: ["internal_agent_runs", mission.id] });
    } finally {
      setLaunching(false);
    }
  }

  const { data: runs } = useQuery({
    queryKey: ["internal_agent_runs", mission.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_runs")
        .select("*")
        .eq("mission_id", mission.id)
        .order("created_at", { ascending: false });
      return (data ?? []) as MissionRun[];
    },
    refetchInterval: (q) => {
      const list = q.state.data as MissionRun[] | undefined;
      const hasLive = list?.some((r) => r.status === "queued" || r.status === "running");
      return hasLive ? 3000 : false;
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="text-base">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="border-0 px-0 text-base font-semibold focus-visible:ring-0"
              />
            </CardTitle>
            <div className="flex items-center gap-2">
              {savedAt && Date.now() - savedAt < 4000 && (
                <span className="text-xs text-muted-foreground"><Check className="mr-1 inline h-3 w-3" /> Saved</span>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil className="h-3 w-3" /><span className="ml-1">Edit</span>
              </Button>
              <Button size="sm" variant="outline" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                <span className="ml-1">Save</span>
              </Button>
              <Button size="sm" onClick={launchRun} disabled={launching}>
                {launching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                <span className="ml-1">Run mission</span>
              </Button>
            </div>
          </div>
          {/* Assignment metadata strip */}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", pr.color)}>
              <span className={cn("h-2 w-2 rounded-full", pr.dot)} /> {pr.label}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted-foreground">
              <UserCircle2 className="h-3 w-3" /> {assignee ? memberLabel(assignee) : "Unassigned"}
            </span>
            {due && (
              <span className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
                due.overdue ? "border-destructive/40 text-destructive" : "border-border text-muted-foreground",
              )}>
                <CalendarClock className="h-3 w-3" /> {due.label}
              </span>
            )}
            {mission.schedule && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 capitalize text-muted-foreground"
                title={mission.next_run_at ? `Next run: ${new Date(mission.next_run_at).toLocaleString()}` : undefined}
              >
                <Repeat className="h-3 w-3" /> {mission.schedule}
                {mission.next_run_at && (
                  <span className="normal-case">· next {new Date(mission.next_run_at).toLocaleDateString()}</span>
                )}
              </span>
            )}
            {mission.tags.map((t) => (
              <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{t}</span>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Brief</label>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={7}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Describe the task in detail."
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Acceptance criteria</label>
            <textarea
              value={acceptance}
              onChange={(e) => setAcceptance(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="What counts as done?"
            />
          </div>
          <DeliverablesEditor deliverables={deliverables} onChange={setDeliverables} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Run history</CardTitle>
        </CardHeader>
        <CardContent>
          {!runs || runs.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No runs yet. Click <strong>Run mission</strong> to launch one.</p>
          ) : (
            <div className="space-y-2">
              {runs.map((r) => (
                <RunCard key={r.id} run={r} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <MissionWizard
        open={editOpen}
        onOpenChange={setEditOpen}
        workspaceId={agent.workspace_id}
        initial={{
          title: mission.title,
          brief: mission.brief ?? "",
          acceptance_criteria: mission.acceptance_criteria ?? "",
          expected_deliverables: mission.expected_deliverables ?? [],
          priority: mission.priority,
          due_date: mission.due_date,
          assigned_to: mission.assigned_to,
          tags: mission.tags,
          schedule: mission.schedule,
        }}
        onSubmit={saveFromWizard}
      />
    </div>
  );
}

const DELIVERABLE_KINDS = ["markdown", "json", "file", "url", "code"] as const;

function DeliverablesEditor({
  deliverables,
  onChange,
}: {
  deliverables: Array<{ kind: string; name: string; description?: string }>;
  onChange: (d: Array<{ kind: string; name: string; description?: string }>) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Expected deliverables</label>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange([...deliverables, { kind: "markdown", name: "Output" }])}
        >
          <Plus className="mr-1 h-3 w-3" /> Add
        </Button>
      </div>
      {deliverables.length === 0 ? (
        <p className="rounded border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          No deliverables specified.
        </p>
      ) : (
        <div className="space-y-2">
          {deliverables.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                value={d.kind}
                onChange={(e) => {
                  const next = [...deliverables]; next[i] = { ...d, kind: e.target.value }; onChange(next);
                }}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                {DELIVERABLE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <Input
                value={d.name}
                onChange={(e) => {
                  const next = [...deliverables]; next[i] = { ...d, name: e.target.value }; onChange(next);
                }}
                placeholder="Name"
                className="h-7 flex-1"
              />
              <Button size="sm" variant="ghost" onClick={() => onChange(deliverables.filter((_, j) => j !== i))}>
                <Trash2 className="h-3 w-3 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RunCard({ run }: { run: MissionRun }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const isLive = run.status === "queued" || run.status === "running";

  const { data: deliverables } = useQuery({
    queryKey: ["internal_agent_deliverables", run.id],
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_deliverables")
        .select("*")
        .eq("run_id", run.id)
        .order("created_at", { ascending: true });
      return (data ?? []) as Deliverable[];
    },
  });

  // Live activity timeline: every tool call/result the agent performs lands in
  // internal_agent_run_events; poll while the run is in flight.
  const { data: events } = useQuery({
    queryKey: ["internal_agent_run_events", run.id],
    enabled: open || isLive,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_run_events")
        .select("*")
        .eq("run_id", run.id)
        .order("created_at", { ascending: true })
        .limit(200);
      return (data ?? []) as RunEvent[];
    },
    refetchInterval: isLive ? 2500 : false,
  });

  async function cancelRun() {
    if (!confirm("Cancel this run? The agent stops before its next action.")) return;
    await supabase
      .from("internal_agent_runs")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", run.id)
      .in("status", ["queued", "running"]);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_runs", run.mission_id] });
  }

  const statusIcon = {
    queued: <Clock className="h-3.5 w-3.5 text-muted-foreground" />,
    running: <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />,
    succeeded: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />,
    failed: <XCircle className="h-3.5 w-3.5 text-destructive" />,
    cancelled: <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />,
  }[run.status];

  return (
    <div className="rounded-md border border-border">
      <div className="flex w-full items-center justify-between px-3 py-2 hover:bg-muted/40">
        <button onClick={() => setOpen(!open)} className="flex flex-1 items-center gap-2 text-left text-sm">
          {statusIcon}
          <span className="font-medium capitalize">{run.status}</span>
          {run.triggered_via === "schedule" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Repeat className="h-2.5 w-2.5" /> scheduled
            </span>
          )}
          <span className="text-xs text-muted-foreground">{new Date(run.created_at).toLocaleString()}</span>
        </button>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{run.action_count} actions</span>
          <span>${run.cost_usd.toFixed(4)}</span>
          {isLive && (
            <Button size="sm" variant="ghost" onClick={cancelRun} title="Cancel run">
              <Ban className="h-3 w-3 text-destructive" />
            </Button>
          )}
        </div>
      </div>
      {(open || isLive) && events && events.length > 0 && (
        <div className="border-t border-border px-3 py-2">
          <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <ListTree className="h-3 w-3" /> Activity
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {events.map((ev) => <RunEventLine key={ev.id} ev={ev} />)}
          </div>
        </div>
      )}
      {open && (
        <div className="border-t border-border px-3 py-3 text-sm">
          {run.error_message && (
            <div className="mb-3 rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {run.error_message}
            </div>
          )}
          {run.final_output && (
            <div className="prose prose-sm mb-3 max-w-none dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{run.final_output}</ReactMarkdown>
            </div>
          )}
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Deliverables</div>
            {!deliverables || deliverables.length === 0 ? (
              <p className="text-xs italic text-muted-foreground">No deliverables produced.</p>
            ) : (
              deliverables.map((d) => <DeliverableItem key={d.id} d={d} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RunEventLine({ ev }: { ev: RunEvent }) {
  const meta: Record<RunEvent["kind"], { icon: any; cls: string; text: string }> = {
    tool_call: { icon: Wrench, cls: "text-sky-600", text: `${ev.payload?.tool ?? "tool"}(${summarizeArgs(ev.payload?.args)})` },
    tool_result: {
      icon: ev.payload?.ok === false ? XCircle : CheckCircle2,
      cls: ev.payload?.ok === false ? "text-destructive" : "text-emerald-600",
      text: String(ev.payload?.preview ?? "").slice(0, 140) || "(empty result)",
    },
    llm_call: { icon: Zap, cls: "text-violet-500", text: `LLM ${ev.payload?.model ?? ""} · ${(ev.tokens_in + ev.tokens_out).toLocaleString()} tokens` },
    status: { icon: AlertCircle, cls: "text-muted-foreground", text: String(ev.payload?.message ?? "status") },
    log: { icon: FileText, cls: "text-muted-foreground", text: String(ev.payload?.message ?? "log") },
    error: { icon: XCircle, cls: "text-destructive", text: String(ev.payload?.error ?? "error") },
    plan: { icon: ListTree, cls: "text-primary", text: `Reasoned & planned · ${ev.payload?.plan?.tasks?.length ?? 0} tasks` },
    plan_step: {
      icon: ev.payload?.status === "done" ? CheckCircle2 : ev.payload?.status === "blocked" ? AlertCircle : Loader2,
      cls: ev.payload?.status === "done" ? "text-emerald-600" : ev.payload?.status === "blocked" ? "text-destructive" : "text-primary",
      text: `${ev.payload?.step_id ?? "step"} → ${ev.payload?.status ?? ""}${ev.payload?.note ? ` · ${ev.payload.note}` : ""}`,
    },
    tool_error: { icon: AlertTriangle, cls: "text-amber-600", text: String(ev.payload?.message ?? "Incomplete tool call") },
    question: { icon: MessageSquare, cls: "text-amber-600", text: `Asked: ${String(ev.payload?.question ?? "").slice(0, 120)}` },
  };
  const m = meta[ev.kind] ?? meta.log;
  const Icon = m.icon;
  return (
    <div className="flex items-start gap-1.5 text-[11px]">
      <Icon className={cn("mt-0.5 h-3 w-3 shrink-0", m.cls)} />
      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={m.text}>{m.text}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground/60">
        {new Date(ev.created_at).toLocaleTimeString()}
      </span>
    </div>
  );
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const s = JSON.stringify(args);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

function DeliverableItem({ d }: { d: Deliverable }) {
  return (
    <div className="rounded border border-border bg-muted/30 p-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium">{d.name}</span>
          <Badge variant="outline" className="text-[10px]">{d.kind}</Badge>
        </div>
        {d.file_url ? (
          <a href={d.file_url} target="_blank" rel="noreferrer">
            <Button size="sm" variant="ghost"><Download className="h-3 w-3" /></Button>
          </a>
        ) : d.content ? (
          <Button size="sm" variant="ghost" onClick={() => downloadDeliverable(d)}><Download className="h-3 w-3" /></Button>
        ) : null}
      </div>
      {d.content && d.kind === "markdown" && (
        <div className="prose prose-sm mt-2 max-w-none dark:prose-invert">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{d.content}</ReactMarkdown>
        </div>
      )}
      {d.content && d.kind !== "markdown" && (
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-background/60 p-2 text-[11px]">{d.content}</pre>
      )}
    </div>
  );
}

// ============================================================================
// TOOLS TAB
// ============================================================================

interface AgentTool {
  id: string;
  agent_id: string;
  kind: "web_search" | "web_fetch" | "db_read" | "rag_search" | "edge_function" | "vault_connector" | "connector_action" | "security_scan" | "custom";
  name: string;
  description: string | null;
  config: Record<string, any>;
  enabled: boolean;
  requires_approval: boolean;
}

const TOOL_CATALOGUE: Array<{ kind: AgentTool["kind"]; label: string; icon: any; description: string }> = [
  { kind: "web_search", label: "Web search", icon: Globe, description: "Search the web for fresh information." },
  { kind: "web_fetch", label: "Fetch URL", icon: Globe, description: "Download and extract text from a URL." },
  { kind: "rag_search", label: "Knowledge search", icon: BookOpen, description: "Semantic search over the project's indexed/ingested knowledge base." },
  { kind: "edge_function", label: "Internal action", icon: Zap, description: "Invoke an internal FounderOS function (notifications, email, marketing…)." },
  { kind: "vault_connector", label: "Connector inventory", icon: KeyRound, description: "List connected integrations (provider, status — no secrets)." },
  { kind: "connector_action", label: "Integration", icon: Plug, description: "Read data from a connected integration (CRM, HR, data lake) via its official API." },
  { kind: "security_scan", label: "Security scan", icon: ShieldCheck, description: "Run a consented security scan against a registered target." },
  { kind: "custom", label: "Custom webhook tool", icon: Wrench, description: "Call an external webhook with model-provided arguments." },
];

// Curated internal connections the agent can be granted as edge_function
// tools — pre-configured slug + description, one click to add.
const EDGE_FUNCTION_CATALOGUE: Array<{ slug: string; label: string; description: string }> = [
  { slug: "send-notification", label: "Send notification", description: "Send an in-app notification to the team." },
  { slug: "send-email", label: "Send email", description: "Send a transactional email." },
  { slug: "send-bulk-email", label: "Send bulk email", description: "Send an email campaign to a list of recipients." },
  { slug: "marketing-generate", label: "Generate marketing content", description: "Draft marketing copy/visuals with the marketing engine." },
  { slug: "marketing-publish", label: "Publish marketing post", description: "Publish a post through the connected marketing channels." },
  { slug: "run-workflow", label: "Run ops workflow", description: "Trigger an automation workflow." },
  { slug: "analytics-query", label: "Analytics query", description: "Run a product-analytics query on tracked events." },
  { slug: "calculate-metrics", label: "Recompute metrics", description: "Recalculate the project metrics snapshot." },
  { slug: "daily-briefing", label: "Daily briefing", description: "Generate the project's daily briefing." },
];

function ToolsTab({ agent, variant = "full" }: { agent: InternalAgent; variant?: "full" | "tools" | "connectors" }) {
  // Which sections render. "connectors" = the agent's integrations only (used by
  // the Personnaliser → Connectors sub-tab); "tools" = generic capabilities only
  // (used by Settings → Tools); "full" = both.
  const showTools = variant !== "connectors";
  const showIntegrations = variant !== "tools";
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  // Second step of the add dialog: pick a concrete connection from the catalogue.
  const [addStep, setAddStep] = useState<"kinds" | "edge_function" | "vault_connector">("kinds");
  // Provider slug whose project-level credentials we're (re)configuring.
  const [configureSlug, setConfigureSlug] = useState<string | null>(null);

  const { data: tools } = useQuery({
    queryKey: ["internal_agent_tools", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_tools")
        .select("*")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: true });
      return (data ?? []) as AgentTool[];
    },
  });

  // Live connections of the project, surfaced in the picker + integrations section.
  const { data: connectors } = useQuery({
    queryKey: ["project_connectors_for_tools", agent.project_id],
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("provider, status")
        .eq("project_id", agent.project_id);
      return (data ?? []) as Array<{ provider: string; status: string }>;
    },
  });
  const connectedSet = new Set((connectors ?? []).filter((c) => c.status === "connected").map((c) => c.provider));

  // Integrations = connector_action tools. Toggle one per provider slug.
  const integrationSlugs = new Set(
    (tools ?? [])
      .filter((t) => t.kind === "connector_action")
      .map((t) => String(t.config?.provider ?? "")),
  );

  async function toggleIntegration(slug: string) {
    const existing = (tools ?? []).find(
      (t) => t.kind === "connector_action" && String(t.config?.provider ?? "") === slug,
    );
    if (existing) {
      await supabase.from("internal_agent_tools").delete().eq("id", existing.id);
      queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
      return;
    }
    const p = connectorActionProvider(slug);
    const { error } = await supabase.from("internal_agent_tools").insert({
      agent_id: agent.id,
      kind: "connector_action",
      name: p ? `Use ${p.name}` : `Use ${slug}`,
      description: p?.description ?? null,
      config: { provider: slug },
      requires_approval: false,
    });
    if (error) { alert(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
    // If the integration isn't connected yet, open the config panel so the user
    // can drop in the credentials (reused project-wide afterwards).
    if (!connectedSet.has(slug)) setConfigureSlug(slug);
  }

  function closeAdd() {
    setAddOpen(false);
    setAddStep("kinds");
  }

  async function addTool(
    kind: AgentTool["kind"],
    name: string,
    overrides?: { description?: string; config?: Record<string, any> },
  ) {
    const def = TOOL_CATALOGUE.find((t) => t.kind === kind)!;
    const { error } = await supabase.from("internal_agent_tools").insert({
      agent_id: agent.id,
      kind,
      name: name || def.label,
      description: overrides?.description ?? def.description,
      config: overrides?.config ?? {},
      // Action tools start approval-gated — safe by default; owners can relax it.
      requires_approval: kind === "edge_function" || kind === "custom",
    });
    if (error) { alert(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
    closeAdd();
  }

  async function toggle(tool: AgentTool) {
    await supabase.from("internal_agent_tools").update({ enabled: !tool.enabled }).eq("id", tool.id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
  }

  async function remove(id: string) {
    if (!confirm("Remove this tool?")) return;
    await supabase.from("internal_agent_tools").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
  }

  async function updateConfig(id: string, config: Record<string, any>) {
    await supabase.from("internal_agent_tools").update({ config }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
  }

  async function toggleApproval(tool: AgentTool) {
    await supabase
      .from("internal_agent_tools")
      .update({ requires_approval: !tool.requires_approval })
      .eq("id", tool.id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
  }

  return (
    <div className="flex flex-col">
      {showTools && (<>
      <div className="order-2 mt-8 flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Wrench className="h-4 w-4 text-muted-foreground" /> Generic tools</h3>
          <p className="text-xs text-muted-foreground">Capabilities not tied to a specific app — web search, knowledge, internal actions.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add tool</Button>
      </div>
      <div className="order-2 mt-4">
        {(() => {
          const builtinTools = (tools ?? []).filter((t) => t.kind !== "connector_action");
          return builtinTools.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No tools yet. Add one to give this agent capabilities.</p>
        ) : (
          <div className="space-y-2">
            {builtinTools.map((t) => {
              const def = TOOL_CATALOGUE.find((d) => d.kind === t.kind);
              const Icon = def?.icon ?? Wrench;
              const configIssue = toolConfigIssue(t);
              return (
                <div key={t.id} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {t.name}
                          {configIssue && t.enabled && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600"
                              title={configIssue}
                            >
                              <AlertCircle className="h-2.5 w-2.5" /> Needs configuration
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground">{def?.description ?? t.description}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {(t.kind === "edge_function" || t.kind === "custom") && (
                        <button
                          onClick={() => toggleApproval(t)}
                          title="When on, the agent's calls to this tool wait for human approval before executing."
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                            t.requires_approval ? "bg-amber-500/15 text-amber-600" : "bg-muted text-muted-foreground",
                          )}
                        >
                          <ShieldCheck className="h-2.5 w-2.5" />
                          {t.requires_approval ? "Approval required" : "Auto-execute"}
                        </button>
                      )}
                      <button
                        onClick={() => toggle(t)}
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-medium",
                          t.enabled ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground",
                        )}
                      >
                        {t.enabled ? "Enabled" : "Disabled"}
                      </button>
                      <Button size="sm" variant="ghost" onClick={() => remove(t.id)}>
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    </div>
                  </div>
                  <ToolConfigEditor tool={t} onSave={(c) => updateConfig(t.id, c)} />
                </div>
              );
            })}
          </div>
          );
        })()}
      </div>
      </>)}

      {showIntegrations && (<>
      {/* Integrations — connector_action data sources (CRM / HR / data lakes). */}
      <div className="order-1">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Plug className="h-4 w-4 text-muted-foreground" /> Integrations</h3>
          <p className="text-xs text-muted-foreground">
            Add an integration and the agent gets its tools. Already-connected integrations are reused — no keys to
            re-enter. Click the gear to (re)configure an integration's credentials for this project.
          </p>
        </div>
        <div className="mt-4 space-y-5">
          {CONNECTOR_ACTION_GROUPS.map((group) => (
            <div key={group.label} className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase text-muted-foreground">{group.label}</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.slugs.map((slug) => {
                  const p = connectorActionProvider(slug);
                  if (!p) return null;
                  const on = integrationSlugs.has(slug);
                  const connected = connectedSet.has(slug);
                  const Icon = p.icon;
                  return (
                    <div
                      key={slug}
                      className={cn(
                        "flex items-start gap-2.5 rounded-lg border p-2.5 transition-colors",
                        on ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30",
                      )}
                    >
                      <button onClick={() => toggleIntegration(slug)} className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
                        <div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md", on ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground")}>
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{p.name}</span>
                            {on && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                          </div>
                          <p className="line-clamp-2 text-[11px] text-muted-foreground">{p.description}</p>
                          <div className="mt-1">
                            {connected ? (
                              <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                                <ShieldCheck className="h-3 w-3" /> Connected · reused
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                                <AlertTriangle className="h-3 w-3" /> Not connected — click gear to set up
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                      <button
                        onClick={() => setConfigureSlug(slug)}
                        title={connected ? "Reconfigure credentials" : "Configure credentials"}
                        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Configure / connect an integration's project-level credentials. */}
      <ConnectorDialog
        open={!!configureSlug}
        onOpenChange={(o) => { if (!o) setConfigureSlug(null); }}
        provider={configureSlug ? findProvider(configureSlug) ?? null : null}
        workspaceId={agent.workspace_id}
        projectId={agent.project_id}
        onConnected={() => {
          setConfigureSlug(null);
          queryClient.invalidateQueries({ queryKey: ["project_connectors_for_tools", agent.project_id] });
        }}
      />
      </>)}

      {showTools && (
      <Dialog open={addOpen} onOpenChange={(o) => { if (!o) closeAdd(); else setAddOpen(true); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {addStep !== "kinds" && (
                <button onClick={() => setAddStep("kinds")} className="text-muted-foreground hover:text-foreground">
                  <ArrowLeft className="h-4 w-4" />
                </button>
              )}
              {addStep === "kinds" ? "Add a tool" : addStep === "edge_function" ? "Pick an internal action" : "Pick a connector"}
            </DialogTitle>
          </DialogHeader>

          {addStep === "kinds" && (
            <div className="grid grid-cols-1 gap-2">
              {/* connector_action is managed in the Integrations section below. */}
              {TOOL_CATALOGUE.filter((t) => t.kind !== "connector_action").map((t) => {
                const Icon = t.icon;
                const hasCatalogue = t.kind === "edge_function" || t.kind === "vault_connector";
                return (
                  <button
                    key={t.kind}
                    onClick={() => (hasCatalogue ? setAddStep(t.kind as "edge_function" | "vault_connector") : addTool(t.kind, t.label))}
                    className="flex items-start gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40"
                  >
                    <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    <div className="flex-1">
                      <div className="text-sm font-medium">{t.label}</div>
                      <div className="text-xs text-muted-foreground">{t.description}</div>
                    </div>
                    {hasCatalogue && <ChevronDown className="mt-1 h-3.5 w-3.5 -rotate-90 text-muted-foreground" />}
                  </button>
                );
              })}
            </div>
          )}

          {addStep === "edge_function" && (
            <div className="max-h-[55vh] space-y-2 overflow-y-auto">
              {EDGE_FUNCTION_CATALOGUE.map((fn) => (
                <button
                  key={fn.slug}
                  onClick={() => addTool("edge_function", fn.label, { description: fn.description, config: { slug: fn.slug } })}
                  className="flex w-full items-start gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40"
                >
                  <Zap className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <div className="text-sm font-medium">{fn.label}</div>
                    <div className="text-xs text-muted-foreground">{fn.description}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">{fn.slug}</div>
                  </div>
                </button>
              ))}
              <button
                onClick={() => addTool("edge_function", "Internal action")}
                className="w-full rounded-md border border-dashed border-border p-3 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40"
              >
                Other function… (add empty, then set the slug in Configure)
              </button>
              <p className="px-1 text-[10px] text-muted-foreground">
                Added actions are approval-gated by default — the agent's calls wait for a human until you switch them to auto-execute.
              </p>
            </div>
          )}

          {addStep === "vault_connector" && (
            <div className="space-y-2">
              {(connectors ?? []).length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  No connectors on this project yet. Connect one in Integrations first.
                </p>
              ) : (
                (connectors ?? []).map((c) => (
                  <button
                    key={c.provider}
                    onClick={() =>
                      addTool("vault_connector", `Connector: ${c.provider}`, {
                        description: `Visibility on the ${c.provider} connection (status, permissions — no secrets).`,
                        config: { provider: c.provider },
                      })
                    }
                    className="flex w-full items-center gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40"
                  >
                    <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="flex-1">
                      <div className="text-sm font-medium capitalize">{c.provider}</div>
                      <div className="text-xs text-muted-foreground">status: {c.status}</div>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      )}
    </div>
  );
}

// A tool whose required config is missing is silently skipped by the worker —
// surface that in the UI so the user knows why the agent can't use it.
function toolConfigIssue(t: AgentTool): string | null {
  if (t.kind === "db_read") {
    const tables = Array.isArray(t.config?.tables) ? t.config.tables : [];
    if (tables.length === 0) return "No tables allowed yet — the agent can't read anything. Configure the table allowlist.";
  }
  if (t.kind === "edge_function" && !/^[a-z0-9-]+$/.test(String(t.config?.slug ?? ""))) {
    return "No function slug configured — the worker skips this tool. Set the slug.";
  }
  if (t.kind === "custom" && !/^https?:\/\//.test(String(t.config?.webhook_url ?? ""))) {
    return "No webhook URL configured — the worker skips this tool. Set the URL.";
  }
  return null;
}

// Structured configuration per tool kind. Kinds without options (web_search,
// web_fetch, rag_search, vault_connector) show nothing; the rest get focused
// fields, with the raw JSON always available as an escape hatch.
function ToolConfigEditor({ tool, onSave }: { tool: AgentTool; onSave: (c: Record<string, any>) => void }) {
  const [open, setOpen] = useState(false);
  const hasConfig = tool.kind === "db_read" || tool.kind === "edge_function" || tool.kind === "custom";
  if (!hasConfig) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="text-[11px] text-muted-foreground hover:text-foreground"
      >
        {open ? "Hide config" : "Configure"}
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          {tool.kind === "db_read" && <DbReadConfig tool={tool} onSave={onSave} />}
          {tool.kind === "edge_function" && <EdgeFunctionConfig tool={tool} onSave={onSave} />}
          {tool.kind === "custom" && <CustomToolConfig tool={tool} onSave={onSave} />}
          <RawJsonConfig tool={tool} onSave={onSave} />
        </div>
      )}
    </div>
  );
}

function DbReadConfig({ tool, onSave }: { tool: AgentTool; onSave: (c: Record<string, any>) => void }) {
  const [tables, setTables] = useState(
    Array.isArray(tool.config?.tables) ? (tool.config.tables as string[]).join(", ") : "",
  );
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
        Allowed tables (comma-separated — the agent can only read these, scoped to this project)
      </label>
      <div className="flex gap-2">
        <Input
          value={tables}
          onChange={(e) => setTables(e.target.value)}
          placeholder="product_events, deals, marketing_posts"
          className="h-7 flex-1 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onSave({
              ...tool.config,
              tables: tables.split(",").map((t) => t.trim()).filter((t) => /^[a-zA-Z0-9_]+$/.test(t)),
            })
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function EdgeFunctionConfig({ tool, onSave }: { tool: AgentTool; onSave: (c: Record<string, any>) => void }) {
  const [slug, setSlug] = useState(typeof tool.config?.slug === "string" ? tool.config.slug : "");
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
        Function slug (the agent gets one tool that POSTs to this function)
      </label>
      <div className="flex gap-2">
        <Input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="send-notification"
          className="h-7 flex-1 font-mono text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!/^[a-z0-9-]+$/.test(slug)}
          onClick={() => onSave({ ...tool.config, slug })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function CustomToolConfig({ tool, onSave }: { tool: AgentTool; onSave: (c: Record<string, any>) => void }) {
  const [url, setUrl] = useState(typeof tool.config?.webhook_url === "string" ? tool.config.webhook_url : "");
  const [method, setMethod] = useState(typeof tool.config?.method === "string" ? tool.config.method : "POST");
  return (
    <div className="space-y-2">
      <label className="block text-[11px] font-medium text-muted-foreground">
        Webhook URL (called with the agent's JSON arguments)
      </label>
      <div className="flex gap-2">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        >
          {["POST", "GET", "PUT", "PATCH"].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.example.com/agent"
          className="h-7 flex-1 font-mono text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!/^https?:\/\//.test(url)}
          onClick={() => onSave({ ...tool.config, webhook_url: url, method })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function RawJsonConfig({ tool, onSave }: { tool: AgentTool; onSave: (c: Record<string, any>) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(JSON.stringify(tool.config ?? {}, null, 2));
  const [err, setErr] = useState<string | null>(null);

  function save() {
    try {
      const parsed = JSON.parse(text);
      onSave(parsed);
      setErr(null);
      setOpen(false);
    } catch (e: any) {
      setErr("Invalid JSON: " + e.message);
    }
  }

  return (
    <div>
      <button onClick={() => setOpen(!open)} className="text-[10px] text-muted-foreground/70 hover:text-foreground">
        {open ? "Hide advanced (raw JSON)" : "Advanced (raw JSON)"}
      </button>
      {open && (
        <div className="mt-1 space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            className="w-full rounded border border-input bg-background px-2 py-1.5 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {err && <p className="text-[11px] text-destructive">{err}</p>}
          <Button size="sm" variant="outline" onClick={save}>Save config</Button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// MEMORY TAB — the agent's persistent cross-session knowledge store
// ============================================================================

const MEMORY_KINDS: MemoryKind[] = ["fact", "preference", "learning", "context"];

function MemoryTab({ agent }: { agent: InternalAgent }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [kindFilter, setKindFilter] = useState<MemoryKind | "all">("all");
  const [search, setSearch] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newKind, setNewKind] = useState<MemoryKind>("fact");
  const [newImportance, setNewImportance] = useState(3);
  const [adding, setAdding] = useState(false);

  const { data: memories } = useQuery({
    queryKey: ["internal_agent_memories", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_memories")
        .select("*")
        .eq("agent_id", agent.id)
        .order("is_pinned", { ascending: false })
        .order("importance", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(300);
      return (data ?? []) as AgentMemory[];
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["internal_agent_memories", agent.id] });

  async function addMemory() {
    const content = newContent.trim();
    if (!content || !user) return;
    setAdding(true);
    try {
      const { error } = await supabase.from("internal_agent_memories").insert({
        agent_id: agent.id,
        workspace_id: agent.workspace_id,
        project_id: agent.project_id,
        kind: newKind,
        content: content.slice(0, 600),
        importance: newImportance,
        source: "user",
        created_by: user.id,
      });
      if (error) { alert(error.message); return; }
      setNewContent("");
      invalidate();
    } finally {
      setAdding(false);
    }
  }

  async function togglePin(m: AgentMemory) {
    await supabase
      .from("internal_agent_memories")
      .update({ is_pinned: !m.is_pinned, updated_at: new Date().toISOString() })
      .eq("id", m.id);
    invalidate();
  }

  async function removeMemory(id: string) {
    if (!confirm("Forget this memory? The agent will no longer see it.")) return;
    await supabase.from("internal_agent_memories").delete().eq("id", id);
    invalidate();
  }

  const visible = (memories ?? []).filter((m) => {
    if (kindFilter !== "all" && m.kind !== kindFilter) return false;
    if (search && !m.content.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const pinnedCount = (memories ?? []).filter((m) => m.is_pinned).length;

  return (
    <div className="space-y-4">
      {/* Header — the memory wall is the agent's own knowledge store. */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Brain className="h-4 w-4 text-muted-foreground" /> Memory
            <Badge variant="outline" className="text-[10px]">{memories?.length ?? 0} / 300</Badge>
            {pinnedCount > 0 && <Badge className="bg-amber-500/15 text-[10px] text-amber-600">{pinnedCount} pinned</Badge>}
          </h2>
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            Durable knowledge {agent.name} builds itself as it works (save_memory) and carries into every session.
            Pinned cards are always injected into its prompt. You can add or forget cards too.
          </p>
        </div>
      </div>

      {/* Add a memory card */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addMemory(); }}
          placeholder="Teach the agent something durable… (e.g. 'Our ICP is B2B agencies of 5-50 people')"
          className="h-8 min-w-[260px] flex-1 text-sm"
        />
        <select
          value={newKind}
          onChange={(e) => setNewKind(e.target.value as MemoryKind)}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
        >
          {MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>{MEMORY_KIND_META[k].emoji} {MEMORY_KIND_META[k].label}</option>
          ))}
        </select>
        <select
          value={newImportance}
          onChange={(e) => setNewImportance(Number(e.target.value))}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          title="Importance (drives prompt priority)"
        >
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>★ {n}</option>)}
        </select>
        <Button size="sm" onClick={addMemory} disabled={adding || !newContent.trim()}>
          {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          <span className="ml-1">Add</span>
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {(["all", ...MEMORY_KINDS] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKindFilter(k as MemoryKind | "all")}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] capitalize transition-colors",
                kindFilter === k ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-foreground/5",
              )}
            >
              {k}
            </button>
          ))}
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search memories…"
          className="h-7 max-w-[200px] text-xs"
        />
      </div>

      {/* Card grid */}
      {visible.length === 0 ? (
        <EmptyState
          icon={Brain}
          title={memories && memories.length > 0 ? "No memories match the filters" : "No memories yet"}
          description={
            memories && memories.length > 0
              ? "Try a different filter or search term."
              : "The agent saves memories as it works, or you can add one above."
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((m) => (
            <MemoryCard
              key={m.id}
              m={m}
              onTogglePin={() => togglePin(m)}
              onRemove={() => removeMemory(m.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// A single memory the agent built (or the team added), as a clean glass card —
// rounded, translucent, a faint top highlight line and a soft hover lift, with
// the meta pinned to a footer separated by a hairline (no image).
function MemoryCard({
  m, onTogglePin, onRemove,
}: {
  m: AgentMemory;
  onTogglePin: () => void;
  onRemove: () => void;
}) {
  const meta = MEMORY_KIND_META[m.kind];
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -4 }}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border p-4 backdrop-blur-md transition-[border-color,box-shadow] duration-300",
        "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-foreground/15 before:to-transparent before:opacity-60",
        m.is_pinned
          ? "border-amber-500/40 bg-amber-500/[0.04] hover:shadow-lg hover:shadow-amber-500/10"
          : "border-border/60 bg-card/30 hover:border-primary/40 hover:shadow-xl hover:shadow-primary/5",
      )}
    >
      {/* Header — kind badge + hover actions */}
      <div className="flex items-center justify-between gap-2">
        <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium", meta.cls)}>
          {meta.emoji} {meta.label}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {m.is_pinned && <Pin className="h-3 w-3 text-amber-500 group-hover:hidden" />}
          <button
            onClick={onTogglePin}
            title={m.is_pinned ? "Unpin" : "Pin (always in prompt)"}
            className="opacity-0 transition-opacity group-hover:opacity-100"
          >
            {m.is_pinned
              ? <PinOff className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
              : <Pin className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />}
          </button>
          <button
            onClick={onRemove}
            title="Forget"
            className="opacity-0 transition-opacity group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </button>
        </div>
      </div>

      {/* Content */}
      <p className="mt-3 flex-1 text-sm leading-relaxed text-foreground/90">{m.content}</p>

      {/* Footer — meta on a hairline, like the model */}
      <div className="mt-4 flex items-center gap-2 border-t border-border/50 pt-3 text-[10px] text-muted-foreground">
        <span title="Importance" className="text-amber-500">{"★".repeat(m.importance)}</span>
        <span className="inline-flex items-center gap-1">
          {m.source === "agent" ? <><Bot className="h-2.5 w-2.5" /> saved by agent</> : <><UserCircle2 className="h-2.5 w-2.5" /> added by team</>}
        </span>
        <span className="ml-auto">{relativeDate(m.updated_at)}</span>
      </div>
    </motion.div>
  );
}

// ============================================================================
// MEMBERS TAB — per-agent ACL
// ============================================================================

interface AgentMember {
  id: string;
  agent_id: string;
  user_id: string;
  role: "viewer" | "user" | "editor";
  added_at: string;
}


function MembersTab({ agent }: { agent: InternalAgent }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isOwner = user?.id === agent.created_by;

  const { data: members } = useQuery({
    queryKey: ["internal_agent_members", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_members")
        .select("id, agent_id, user_id, role, added_at")
        .eq("agent_id", agent.id);
      return (data ?? []) as AgentMember[];
    },
  });

  // Workspace members not yet on the agent (candidates to invite).
  const { data: candidates } = useQuery({
    queryKey: ["internal_agent_candidates", agent.id, agent.workspace_id, (members ?? []).length],
    enabled: !!agent.workspace_id,
    queryFn: async () => {
      const { data: wm } = await supabase
        .from("workspace_members")
        .select("user_id, profiles:profiles!workspace_members_user_id_fkey(email, full_name)")
        .eq("workspace_id", agent.workspace_id);
      const taken = new Set([agent.created_by, ...(members ?? []).map((m) => m.user_id)]);
      return (wm ?? [])
        .filter((m: any) => !taken.has(m.user_id))
        .map((m: any) => ({
          user_id: m.user_id,
          email: m.profiles?.email ?? null,
          full_name: m.profiles?.full_name ?? null,
        })) as WorkspaceMemberRow[];
    },
  });

  async function addMember(userId: string, role: AgentMember["role"]) {
    if (!user) return;
    const { error } = await supabase
      .from("internal_agent_members")
      .insert({ agent_id: agent.id, user_id: userId, role, added_by: user.id });
    if (error) { alert(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_members", agent.id] });
    queryClient.invalidateQueries({ queryKey: ["internal_agent_candidates", agent.id] });
  }

  async function changeRole(id: string, role: AgentMember["role"]) {
    await supabase.from("internal_agent_members").update({ role }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_members", agent.id] });
  }

  async function removeMember(id: string) {
    if (!confirm("Remove this member?")) return;
    await supabase.from("internal_agent_members").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_members", agent.id] });
    queryClient.invalidateQueries({ queryKey: ["internal_agent_candidates", agent.id] });
  }

  return (
    <div className="space-y-1">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><UsersIcon className="h-4 w-4 text-muted-foreground" /> Members</h3>
      <p className="text-xs text-muted-foreground">Who on your team can see and use this agent.</p>

      <div className="grid gap-6 pt-3 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-[11px] font-medium uppercase text-muted-foreground">Members with access</div>
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
              <div className="text-sm">
                <span className="font-medium">Creator</span>
                <span className="ml-2 text-xs text-muted-foreground">{agent.created_by.slice(0, 8)}…</span>
              </div>
              <Badge variant="outline" className="text-[10px]">Owner</Badge>
            </div>
            {(members ?? []).length === 0 && (
              <p className="py-2 text-center text-xs text-muted-foreground">No additional members.</p>
            )}
            {(members ?? []).map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div className="text-sm">{m.user_id.slice(0, 8)}…</div>
                <div className="flex items-center gap-2">
                  <select
                    value={m.role}
                    disabled={!isOwner}
                    onChange={(e) => changeRole(m.id, e.target.value as AgentMember["role"])}
                    className="rounded border border-input bg-background px-1.5 py-0.5 text-xs"
                  >
                    <option value="viewer">viewer</option>
                    <option value="user">user</option>
                    <option value="editor">editor</option>
                  </select>
                  {isOwner && (
                    <Button size="sm" variant="ghost" onClick={() => removeMember(m.id)}>
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {isOwner && (
          <div>
            <div className="mb-2 text-[11px] font-medium uppercase text-muted-foreground">Invite from workspace</div>
            {!candidates || candidates.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No more members to add.</p>
            ) : (
              <div className="space-y-2">
                {candidates.map((c) => (
                  <div key={c.user_id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                    <div className="text-sm">
                      {c.full_name ?? c.email ?? c.user_id.slice(0, 8) + "…"}
                      {c.email && c.full_name && <span className="ml-2 text-xs text-muted-foreground">{c.email}</span>}
                    </div>
                    <Button size="sm" variant="outline" onClick={() => addMember(c.user_id, "user")}>
                      <Plus className="mr-1 h-3 w-3" /> Add
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// ANALYTICS TAB — costs, actions, runs
// ============================================================================

function AnalyticsTab({ agent }: { agent: InternalAgent }) {
  const { data: runs } = useQuery({
    queryKey: ["internal_agent_runs_all", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_runs")
        .select("id, status, tokens_in, tokens_out, cost_usd, action_count, started_at, finished_at, created_at")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: false })
        .limit(200);
      return (data ?? []) as Array<{
        id: string; status: MissionRun["status"]; tokens_in: number; tokens_out: number;
        cost_usd: number; action_count: number; started_at: string | null; finished_at: string | null; created_at: string;
      }>;
    },
  });

  const { data: msgStats } = useQuery({
    queryKey: ["internal_agent_msg_stats", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_messages")
        .select("tokens_in, tokens_out, cost_usd")
        .eq("agent_id", agent.id);
      return (data ?? []) as Array<{ tokens_in: number; tokens_out: number; cost_usd: number }>;
    },
  });

  const totals = useMemo(() => {
    const r = runs ?? [];
    const m = msgStats ?? [];
    const totalRuns = r.length;
    const succeeded = r.filter((x) => x.status === "succeeded").length;
    const failed = r.filter((x) => x.status === "failed").length;
    const runCost = r.reduce((s, x) => s + Number(x.cost_usd ?? 0), 0);
    const chatCost = m.reduce((s, x) => s + Number(x.cost_usd ?? 0), 0);
    const totalCost = runCost + chatCost;
    const totalTokens = r.reduce((s, x) => s + x.tokens_in + x.tokens_out, 0)
      + m.reduce((s, x) => s + x.tokens_in + x.tokens_out, 0);
    const totalActions = r.reduce((s, x) => s + (x.action_count ?? 0), 0);
    return { totalRuns, succeeded, failed, totalCost, totalTokens, totalActions, runCost, chatCost };
  }, [runs, msgStats]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total runs" value={totals.totalRuns.toString()} hint={`${totals.succeeded} succeeded · ${totals.failed} failed`} />
        <Stat label="Total cost" value={`$${totals.totalCost.toFixed(4)}`} hint={`Missions $${totals.runCost.toFixed(4)} · Chat $${totals.chatCost.toFixed(4)}`} />
        <Stat label="Tokens used" value={totals.totalTokens.toLocaleString()} hint="In + out (all modes)" />
        <Stat label="Tool calls" value={totals.totalActions.toString()} hint="Across all runs" />
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Recent runs</CardTitle></CardHeader>
        <CardContent>
          {!runs || runs.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No runs recorded.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-2 py-1.5 text-left font-medium">Status</th>
                    <th className="px-2 py-1.5 text-left font-medium">Started</th>
                    <th className="px-2 py-1.5 text-right font-medium">Duration</th>
                    <th className="px-2 py-1.5 text-right font-medium">Tokens</th>
                    <th className="px-2 py-1.5 text-right font-medium">Actions</th>
                    <th className="px-2 py-1.5 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => {
                    const dur = r.started_at && r.finished_at
                      ? Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)
                      : null;
                    return (
                      <tr key={r.id} className="border-b border-border/40 last:border-0">
                        <td className="px-2 py-1.5">
                          <Badge variant="outline" className="text-[10px] capitalize">{r.status}</Badge>
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-right text-muted-foreground">{dur != null ? `${dur}s` : "—"}</td>
                        <td className="px-2 py-1.5 text-right">{(r.tokens_in + r.tokens_out).toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-right">{r.action_count}</td>
                        <td className="px-2 py-1.5 text-right font-mono">${Number(r.cost_usd ?? 0).toFixed(4)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="font-stat-number mt-1 text-xl font-semibold">{value}</div>
        {hint && <div className="mt-1 text-[10px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// SETTINGS TAB
// ============================================================================

function SettingsTab({ agent, embedded }: { agent: InternalAgent; embedded?: boolean }) {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isOwner = user?.id === agent.created_by;

  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [model, setModel] = useState(agent.model);
  const [temperature, setTemperature] = useState(agent.temperature);
  const [chatEnabled, setChatEnabled] = useState(agent.chat_enabled);
  const [missionEnabled, setMissionEnabled] = useState(agent.mission_enabled);
  const [maxSteps, setMaxSteps] = useState(agent.max_steps ?? 8);
  const [maxCost, setMaxCost] = useState(agent.max_run_cost_usd ?? 0.5);
  // Collaboration profile.
  const [role, setRole] = useState(agent.role ?? "");
  const [skills, setSkills] = useState<string[]>(agent.skills ?? []);
  const [skillInput, setSkillInput] = useState("");
  const [collabEnabled, setCollabEnabled] = useState(agent.collaboration_enabled ?? true);
  const [sandboxMode, setSandboxMode] = useState<"cloud" | "runner" | "sandbox">(agent.sandbox_mode ?? "cloud");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [section, setSection] = useState<SettingsSectionKey>("general");
  // Publish the settings sub-tabs to the Topbar (where the breadcrumb was).
  const settingsTabs = useMemo(
    () => SETTINGS_SECTIONS.filter((s) => s.key !== "danger" || isOwner),
    [isOwner],
  );
  useRegisterTopbarTabs(embedded ? null : settingsTabs, section, (k) => setSection(k as SettingsSectionKey));

  async function save() {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("internal_agents")
        .update({
          name,
          description,
          model,
          temperature,
          chat_enabled: chatEnabled,
          mission_enabled: missionEnabled,
          max_steps: Math.min(Math.max(Math.round(maxSteps) || 8, 1), 30),
          max_run_cost_usd: Math.max(Number(maxCost) || 0.5, 0),
          role: role.trim() || null,
          skills,
          collaboration_enabled: collabEnabled,
          sandbox_mode: sandboxMode,
          updated_at: new Date().toISOString(),
        })
        .eq("id", agent.id);
      if (error) throw error;
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    if (!confirm("Archive this agent? Members will lose access. You can restore it later from the database.")) return;
    await supabase.from("internal_agents").update({ is_archived: true }).eq("id", agent.id);
    queryClient.invalidateQueries({ queryKey: ["internal_agents"] });
    navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal-agents`);
  }

  return (
    <div className="mx-auto max-w-4xl">
      {embedded && <InlineSubTabs sections={settingsTabs} active={section} onSelect={setSection} />}
      {/* Header + Save — flush on the background. */}
      <div className="flex items-center justify-between pb-3">
        <h2 className="text-lg font-semibold">Settings</h2>
        <div className="flex items-center gap-2">
          {savedAt && Date.now() - savedAt < 4000 && (
            <span className="text-xs text-muted-foreground"><Check className="mr-1 inline h-3 w-3" /> Saved</span>
          )}
          {section !== "tools" && section !== "mobile" && section !== "members" && section !== "danger" && (
            <Button size="sm" onClick={save} disabled={saving || !isOwner}>
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              <span className="ml-1">Save</span>
            </Button>
          )}
        </div>
      </div>

      {/* General */}
      {section === "general" && (
      <SettingsSection>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} disabled={!isOwner} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={!isOwner}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            >
              <option value="deepseek">DeepSeek</option>
              <option value="groq">Groq (Llama 3.1)</option>
              <option value="gpt-4">GPT-4</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Temperature ({temperature})</label>
            <input
              type="range" min={0} max={1} step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              disabled={!isOwner}
              className="mt-2 w-full"
            />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <ToggleRow
            icon={MessageSquare} label="Chat mode"
            checked={chatEnabled} onChange={setChatEnabled} disabled={!isOwner}
          />
          <ToggleRow
            icon={Target} label="Mission mode"
            checked={missionEnabled} onChange={setMissionEnabled} disabled={!isOwner}
          />
        </div>
        <AgentHostedModelCard agent={agent} disabled={!isOwner} />
      </SettingsSection>
      )}

      {/* Autonomy budget */}
      {section === "autonomy" && (
      <SettingsSection
        title="Autonomy budget" icon={Gauge}
        description="Hard limits applied to every run. The agent stops when it reaches the step budget; runs exceeding the cost budget are flagged in the timeline."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Max steps per run (tool-call rounds, 1–30)
            </label>
            <Input
              type="number" min={1} max={30}
              value={maxSteps}
              onChange={(e) => setMaxSteps(Number(e.target.value))}
              disabled={!isOwner}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Max cost per run (USD)
            </label>
            <Input
              type="number" min={0} step={0.05}
              value={maxCost}
              onChange={(e) => setMaxCost(Number(e.target.value))}
              disabled={!isOwner}
            />
          </div>
        </div>
      </SettingsSection>
      )}

      {/* Infrastructure — sandbox mode */}
      {section === "infrastructure" && (
      <SettingsSection
        title="Execution Environment" icon={Database}
        description="Choose how this agent runs. Cloud = serverless edge (web/db/connectors). Runner = + a real browser, shell, Python/Node and files on your self-hosted runner machine. Sandbox = + a full Linux container with terminal, files and code execution."
      >
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <button onClick={() => setSandboxMode("cloud")}
              className={cn("rounded-xl border p-4 text-left transition-all",
                sandboxMode === "cloud" ? "border-primary ring-1 ring-primary/30 bg-primary/5" : "border-border hover:border-primary/40")}>
              <div className="flex items-center gap-2 mb-2">
                <Zap className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-semibold">Cloud</span>
                {sandboxMode === "cloud" && <Badge variant="outline" className="text-[9px] py-0 ml-auto">Active</Badge>}
              </div>
              <p className="text-[11px] text-muted-foreground">Serverless edge functions. Fast, stateless, pay-per-use. Best for chat, research, and data tasks.</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">web_search</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">deep_research</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">db_read</span>
              </div>
            </button>

            <button onClick={() => setSandboxMode("runner")}
              className={cn("rounded-xl border p-4 text-left transition-all",
                sandboxMode === "runner" ? "border-primary ring-1 ring-primary/30 bg-primary/5" : "border-border hover:border-primary/40")}>
              <div className="flex items-center gap-2 mb-2">
                <Globe className="h-4 w-4 text-sky-500" />
                <span className="text-sm font-semibold">Runner</span>
                {sandboxMode === "runner" && <Badge variant="outline" className="text-[9px] py-0 ml-auto">Active</Badge>}
              </div>
              <p className="text-[11px] text-muted-foreground">Cloud + a real browser, terminal, Python/Node and a persistent file workspace on your runner machine. Best for coding, scripts, data work and web automation.</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">browse_web</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">shell_exec</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">python_exec</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">file_read/write</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">+ cloud tools</span>
              </div>
            </button>

            <button onClick={() => setSandboxMode("sandbox")}
              className={cn("rounded-xl border p-4 text-left transition-all",
                sandboxMode === "sandbox" ? "border-primary ring-1 ring-primary/30 bg-primary/5" : "border-border hover:border-primary/40")}>
              <div className="flex items-center gap-2 mb-2">
                <TerminalSquare className="h-4 w-4 text-emerald-500" />
                <span className="text-sm font-semibold">Sandbox</span>
                {sandboxMode === "sandbox" && <Badge variant="outline" className="text-[9px] py-0 ml-auto">Active</Badge>}
              </div>
              <p className="text-[11px] text-muted-foreground">Dedicated Docker container with terminal, browser, filesystem, VSCode, Jupyter. Persistent between steps. Best for code, analysis, testing.</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">execute_code</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">file_read/write</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">browser</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">terminal</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">jupyter</span>
              </div>
            </button>
          </div>

          {sandboxMode === "runner" && (
            <div className="rounded-lg border border-border bg-secondary/20 p-3 space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <Globe className="h-3.5 w-3.5 text-sky-500" />
                <span className="font-medium">Runner mode needs the self-hosted runner connected (runner_browser_url in app config).</span>
              </div>
              <p className="text-[10px] text-muted-foreground">The agent gets real hands on the runner machine: a Playwright browser (pages, DOM snapshots, clicks, forms, screenshots) plus a terminal (PowerShell/bash), Python & Node.js execution and a persistent per-agent file workspace — enough for coding, scripting and data tasks without a Docker sandbox.</p>
            </div>
          )}

          {sandboxMode === "sandbox" && (
            <div className="rounded-lg border border-border bg-secondary/20 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                <span className="font-medium">Sandbox requires Docker running on the runner host.</span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                The runner will spin up an AIO Sandbox container (ghcr.io/agent-infra/sandbox) for each mission.
                The container provides a full Linux environment with Python, Node.js, shell, browser, and file access.
                It is destroyed after the mission completes.
              </p>
              {agent.sandbox_url && (
                <div className="flex items-center gap-2 text-xs">
                  <Globe className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono text-[10px] text-muted-foreground">{agent.sandbox_url}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </SettingsSection>
      )}

      {/* Collaboration profile */}
      {section === "collaboration" && (
      <SettingsSection
        title="Collaboration" icon={Network}
        description="Role and skills help teammate agents decide when to message or delegate to this one."
      >
        <ToggleRow
          icon={Network}
          label="Allow this agent to collaborate with other agents (message, delegate, share knowledge)"
          checked={collabEnabled} onChange={setCollabEnabled} disabled={!isOwner}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Role</label>
            <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Research analyst" disabled={!isOwner} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Skills</label>
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5">
              {skills.map((s) => (
                <span key={s} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                  {s}
                  {isOwner && <button onClick={() => setSkills(skills.filter((x) => x !== s))} className="text-muted-foreground hover:text-foreground">×</button>}
                </span>
              ))}
              {isOwner && (
                <input
                  value={skillInput}
                  onChange={(e) => setSkillInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const s = skillInput.trim().toLowerCase();
                      if (s && !skills.includes(s)) setSkills([...skills, s]);
                      setSkillInput("");
                    }
                  }}
                  placeholder="add skill…"
                  className="min-w-[80px] flex-1 bg-transparent text-xs focus:outline-none"
                />
              )}
            </div>
          </div>
        </div>
      </SettingsSection>
      )}

      {/* Tools — generic agent capabilities (web search, DB read, edge functions…).
          The app integrations live under Personnaliser → Connectors. */}
      {section === "tools" && (
        <div className="py-6">
          <ToolsTab agent={agent} variant="tools" />
        </div>
      )}

      {/* Mobile — pair this agent with the FounderOS mobile app via id + secret. */}
      {section === "mobile" && (
        <div className="py-6">
          <MobileAccessSection agent={agent} />
        </div>
      )}

      {/* Members — merged in from the former Members tab. */}
      {section === "members" && (
        <div className="py-6">
          <MembersTab agent={agent} />
        </div>
      )}

      {/* Danger zone */}
      {section === "danger" && isOwner && (
        <SettingsSection title="Danger zone" icon={Trash2} titleClassName="text-destructive"
          description="Archiving removes the agent from your team. You can restore it later from the database.">
          <Button variant="outline" onClick={archive} className="text-destructive">
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Archive agent
          </Button>
        </SettingsSection>
      )}
    </div>
  );
}

type SettingsSectionKey = "general" | "autonomy" | "infrastructure" | "collaboration" | "tools" | "mobile" | "members" | "danger";

const SETTINGS_SECTIONS: { key: SettingsSectionKey; label: string; icon: any }[] = [
  { key: "general", label: "General", icon: SettingsIcon },
  { key: "autonomy", label: "Autonomy", icon: Gauge },
  { key: "infrastructure", label: "Infrastructure", icon: Database },
  { key: "collaboration", label: "Collaboration", icon: Network },
  { key: "tools", label: "Tools", icon: Wrench },
  { key: "mobile", label: "Mobile", icon: Smartphone },
  { key: "members", label: "Members", icon: UsersIcon },
  { key: "danger", label: "Danger zone", icon: Trash2 },
];

function randomAgentSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256HexWeb(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Pair the agent with the mobile app: generate a random secret, store only its
// SHA-256 hash, and reveal the plaintext once for the user to paste into the app.
function MobileAccessSection({ agent }: { agent: InternalAgent }) {
  const queryClient = useQueryClient();
  const a = agent as InternalAgent & { mobile_enabled?: boolean; mobile_secret_hash?: string | null };
  const [enabled, setEnabled] = useState(!!a.mobile_enabled);
  const [generated, setGenerated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const hasSecret = !!a.mobile_secret_hash;

  function copy(text: string, which: string) {
    navigator.clipboard.writeText(text).then(
      () => { setCopied(which); setTimeout(() => setCopied(null), 1500); },
      () => {},
    );
  }

  async function toggleEnabled(v: boolean) {
    setEnabled(v);
    await supabase.from("internal_agents").update({ mobile_enabled: v }).eq("id", agent.id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
  }

  async function generate() {
    setBusy(true);
    try {
      const secret = randomAgentSecret();
      const hash = await sha256HexWeb(secret);
      const { error } = await supabase
        .from("internal_agents")
        .update({ mobile_secret_hash: hash, mobile_enabled: true })
        .eq("id", agent.id);
      if (error) { alert(error.message); return; }
      setGenerated(secret);
      setEnabled(true);
      queryClient.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection
      title="Mobile access" icon={Smartphone}
      description="Pair this agent with the FounderOS mobile app. Register it there with the ID and secret below, then chat from your phone."
    >
      <ToggleRow
        icon={Smartphone}
        label="Allow this agent to be used from the mobile app"
        checked={enabled}
        onChange={toggleEnabled}
      />

      <div className="rounded-lg border border-border p-3">
        <div className="text-[11px] font-medium text-muted-foreground">Agent ID</div>
        <div className="mt-1 flex items-center gap-2">
          <code className="flex-1 truncate rounded bg-secondary px-2 py-1 font-mono text-xs">{agent.id}</code>
          <Button size="sm" variant="outline" onClick={() => copy(agent.id, "id")}>
            <Copy className="mr-1 h-3 w-3" /> {copied === "id" ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={generate} disabled={busy}>
          {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <KeyRound className="mr-1 h-3 w-3" />}
          {hasSecret ? "Regenerate secret" : "Generate secret"}
        </Button>
        {hasSecret && !generated && (
          <span className="text-[11px] text-muted-foreground">A secret is set. Regenerate to reveal a new one.</span>
        )}
      </div>

      {generated && (
        <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <p className="text-[11px] font-medium text-foreground">Copy this secret now — it won't be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-background px-2 py-1 font-mono text-xs">{generated}</code>
            <Button size="sm" variant="outline" onClick={() => copy(generated, "secret")}>
              <Copy className="mr-1 h-3 w-3" /> {copied === "secret" ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

// A section of settings laid directly on the page background (no card). Optional
// title + description sit above the content.
function SettingsSection({
  title, icon: Icon, description, titleClassName, children,
}: {
  title?: string;
  icon?: any;
  description?: string;
  titleClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-5 py-6">
      {(title || description) && (
        <div className="space-y-1">
          {title && (
            <h3 className={cn("flex items-center gap-2 text-sm font-semibold", titleClassName)}>
              {Icon && <Icon className="h-4 w-4 text-muted-foreground" />} {title}
            </h3>
          )}
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

// A borderless checkbox row used inside settings sections.
function ToggleRow({
  icon: Icon, label, checked, onChange, disabled,
}: {
  icon?: any;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="h-4 w-4 accent-primary"
      />
      {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      {label}
    </label>
  );
}

// ============================================================================
// COLLABORATION TAB — this agent's inter-agent (A2A) messages + peers
// ============================================================================

// A stable per-agent colour (username text + avatar-fallback tint), so each
// teammate reads consistently across the channel feed — same idea as the
// per-user colours in the <ChatPreview /> component this view is styled after.
const A2A_COLORS = [
  { text: "text-sky-400", bg: "bg-sky-500/30" },
  { text: "text-pink-400", bg: "bg-pink-500/30" },
  { text: "text-emerald-400", bg: "bg-emerald-500/30" },
  { text: "text-amber-400", bg: "bg-amber-500/30" },
  { text: "text-violet-400", bg: "bg-violet-500/30" },
  { text: "text-indigo-400", bg: "bg-indigo-500/30" },
  { text: "text-rose-400", bg: "bg-rose-500/30" },
  { text: "text-teal-400", bg: "bg-teal-500/30" },
];

function a2aColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(id.length - 1 - i)) >>> 0;
  return A2A_COLORS[h % A2A_COLORS.length];
}

const A2A_STATUS_META: Record<A2AMessage["status"], { label: string; dot: string; text: string }> = {
  pending: { label: "En attente", dot: "bg-amber-500", text: "text-amber-500" },
  processing: { label: "En cours", dot: "bg-sky-500", text: "text-sky-500" },
  answered: { label: "Répondu", dot: "bg-emerald-500", text: "text-emerald-500" },
  ignored: { label: "Ignoré", dot: "bg-muted-foreground", text: "text-muted-foreground" },
};

// Renders an A2A message body as formatted markdown (agents write rich reports —
// tables, headings, code fences). Long messages are clamped behind a
// "Voir plus" toggle so one verbose mission report can't flood the channel.
const A2A_COLLAPSED_PX = 200;

function A2AMessageBody({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > A2A_COLLAPSED_PX + 24);
  }, [content]);

  const clamp = !expanded && overflowing;

  return (
    <div className="mt-0.5">
      <div
        ref={ref}
        className={cn("chat-prose break-words text-[13px]", clamp && "relative overflow-hidden")}
        style={clamp ? { maxHeight: A2A_COLLAPSED_PX } : undefined}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        {clamp && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-background via-background/80 to-transparent" />
        )}
      </div>
      {overflowing && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:underline"
        >
          {expanded ? <>Voir moins <ChevronUp className="h-3 w-3" /></> : <>Voir plus <ChevronDown className="h-3 w-3" /></>}
        </button>
      )}
    </div>
  );
}

function CollaborationTab({ agent }: { agent: InternalAgent }) {
  const { data: peers } = useQuery({
    queryKey: ["agent_peers", agent.project_id, agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents")
        .select("id, name, avatar_emoji, avatar_url, role, skills")
        .eq("project_id", agent.project_id)
        .eq("is_archived", false)
        .eq("collaboration_enabled", true)
        .neq("id", agent.id);
      return (data ?? []) as Array<{ id: string; name: string; avatar_emoji: string | null; avatar_url: string | null; role: string | null; skills: string[] }>;
    },
  });

  const { data: messages } = useQuery({
    queryKey: ["agent_a2a", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_a2a_messages")
        .select("id, thread_id, from_agent, to_agent, content, status, reply_to, created_at")
        .or(`from_agent.eq.${agent.id},to_agent.eq.${agent.id}`)
        .order("created_at", { ascending: false })
        .limit(50);
      return (data ?? []) as A2AMessage[];
    },
    refetchInterval: 5000,
  });

  // Directory of everyone who can appear in the feed (this agent + peers), so a
  // message can resolve a sender/recipient's name + avatar by id.
  const meta = (id: string) => {
    if (id === agent.id)
      return { name: agent.name, avatar_url: agent.avatar_url, avatar_emoji: agent.avatar_emoji };
    const p = (peers ?? []).find((x) => x.id === id);
    return { name: p?.name ?? id.slice(0, 6), avatar_url: p?.avatar_url ?? null, avatar_emoji: p?.avatar_emoji ?? null };
  };

  if (!agent.collaboration_enabled) {
    return (
      <EmptyState
        icon={Network}
        title="Collaboration is disabled"
        description="Enable collaboration in Settings so this agent can message, delegate to and learn from teammate agents."
      />
    );
  }

  // Oldest → newest for a natural chat feed (query returns newest-first).
  const msgs = messages ?? [];
  const feed = [...msgs].reverse();
  const channelName = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";

  // Aggregates for the right rail.
  const statusCounts = msgs.reduce<Record<string, number>>((acc, m) => {
    acc[m.status] = (acc[m.status] ?? 0) + 1;
    return acc;
  }, {});
  const pendingCount = (statusCounts.pending ?? 0) + (statusCounts.processing ?? 0);
  const threadCount = new Set(msgs.map((m) => m.thread_id)).size;

  // Agents that actually appear in the feed, with sent/received tallies —
  // "les agents concernés" by this agent's collaboration.
  const partMap = new Map<string, { sent: number; received: number }>();
  for (const m of msgs) {
    const s = partMap.get(m.from_agent) ?? { sent: 0, received: 0 }; s.sent++; partMap.set(m.from_agent, s);
    const r = partMap.get(m.to_agent) ?? { sent: 0, received: 0 }; r.received++; partMap.set(m.to_agent, r);
  }
  const participants = [...partMap.entries()]
    .map(([id, c]) => ({ id, ...c, total: c.sent + c.received, ...meta(id) }))
    .sort((a, b) => b.total - a.total);

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 overflow-y-auto lg:flex-row lg:overflow-hidden">
      {/* LEFT — channel-style A2A feed, fills width + height. Styled after the
          ChatPreview component, wired to real agent-to-agent messages. */}
      <div className="relative flex h-[60vh] flex-col lg:h-auto lg:min-h-0 lg:min-w-0 lg:flex-1">
        <div className="pointer-events-none absolute -inset-1 rounded-2xl bg-gradient-to-r from-orange-500/15 via-pink-500/15 to-purple-500/15 opacity-70 blur-2xl" />
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-foreground/10 bg-background/50 shadow-2xl backdrop-blur-xl">
          <div className="border-b px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <MessagesSquare className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">#{channelName}-collab</span>
              <span className="text-muted-foreground">|</span>
              <span className="flex-1 truncate text-muted-foreground">Messages &amp; délégations entre agents</span>
            </div>
          </div>

          <div className="relative min-h-0 flex-1 overflow-y-auto p-4">
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-background/60 to-transparent" />
            {feed.length === 0 ? (
              <p className="py-10 text-center text-xs text-muted-foreground">
                Aucun message pour l'instant. Cet agent contactera ou déléguera à ses pairs de façon autonome lorsqu'une tâche correspond à leurs compétences.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {feed.map((m, i) => {
                  const from = meta(m.from_agent);
                  const to = meta(m.to_agent);
                  const c = a2aColor(m.from_agent);
                  const outgoing = m.from_agent === agent.id;
                  return (
                    <div
                      key={m.id}
                      className={cn("flex items-start gap-3", i === feed.length - 1 && "animate-message-appear")}
                    >
                      <AgentAvatar
                        url={from.avatar_url}
                        seed={from.name}
                        className="h-8 w-8 shrink-0 overflow-hidden rounded-full"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={cn("text-sm font-medium", c.text)}>{from.name}</span>
                          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="truncate text-xs text-muted-foreground">{to.name}</span>
                          {outgoing && <Badge variant="outline" className="shrink-0 text-[9px]">envoyé</Badge>}
                          <Badge variant="outline" className="shrink-0 text-[9px] capitalize">{m.status}</Badge>
                          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{relativeDate(m.created_at)}</span>
                        </div>
                        <A2AMessageBody content={m.content} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* RIGHT — info rail: overview stats, status breakdown, involved agents,
          and the full teammate roster. Scrolls independently. */}
      <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-80 lg:min-h-0 lg:overflow-y-auto xl:w-96 scrollbar-slim">
        {/* Overview */}
        <div className="rounded-xl border border-border bg-card/40 p-4">
          <div className="flex items-center gap-2">
            <AgentAvatar
              url={agent.avatar_url}
              seed={agent.name}
              className="h-9 w-9 shrink-0 overflow-hidden rounded-lg"
            />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">#{channelName}-collab</div>
              <div className="truncate text-[11px] text-muted-foreground">{agent.role ?? "Collaboration inter-agents"}</div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <StatTile label="Messages" value={msgs.length} />
            <StatTile label="Coéquipiers" value={peers?.length ?? 0} />
            <StatTile label="En cours" value={pendingCount} accent={pendingCount > 0 ? "text-amber-500" : undefined} />
            <StatTile label="Fils" value={threadCount} />
          </div>
        </div>

        {/* Status breakdown */}
        {msgs.length > 0 && (
          <div className="rounded-xl border border-border bg-card/40 p-4">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Statuts</div>
            <div className="space-y-1.5">
              {(Object.keys(A2A_STATUS_META) as Array<A2AMessage["status"]>)
                .filter((k) => (statusCounts[k] ?? 0) > 0)
                .map((k) => {
                  const sm = A2A_STATUS_META[k];
                  const n = statusCounts[k] ?? 0;
                  const pct = Math.round((n / msgs.length) * 100);
                  return (
                    <div key={k} className="flex items-center gap-2 text-xs">
                      <span className={cn("h-2 w-2 shrink-0 rounded-full", sm.dot)} />
                      <span className="flex-1 truncate">{sm.label}</span>
                      <span className="tabular-nums text-muted-foreground">{n} · {pct}%</span>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* Agents concernés — participants in this agent's feed */}
        {participants.length > 0 && (
          <div className="rounded-xl border border-border bg-card/40 p-4">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Agents concernés</div>
            <div className="space-y-2">
              {participants.map((p) => {
                const c = a2aColor(p.id);
                const isSelf = p.id === agent.id;
                return (
                  <div key={p.id} className="flex items-center gap-2">
                    <AgentAvatar url={p.avatar_url} seed={p.name} className="h-7 w-7 shrink-0 overflow-hidden rounded-md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("truncate text-sm font-medium", c.text)}>{p.name}</span>
                        {isSelf && <Badge variant="outline" className="shrink-0 text-[9px]">cet agent</Badge>}
                      </div>
                      <div className="text-[10px] text-muted-foreground">{p.sent} envoyé{p.sent > 1 ? "s" : ""} · {p.received} reçu{p.received > 1 ? "s" : ""}</div>
                    </div>
                    <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">{p.total}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Full teammate roster */}
        <div className="rounded-xl border border-border bg-card/40 p-4">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Coéquipiers</div>
          {!peers || peers.length === 0 ? (
            <p className="py-2 text-center text-xs text-muted-foreground">Aucun autre agent collaboratif sur ce projet.</p>
          ) : (
            <div className="space-y-2">
              {peers.map((p) => (
                <div key={p.id} className="rounded-lg border border-border/70 p-2.5">
                  <div className="flex items-center gap-2">
                    <AgentAvatar url={p.avatar_url} seed={p.name} className="h-7 w-7 shrink-0 overflow-hidden rounded-md" />
                    <div className="min-w-0">
                      <div className={cn("truncate text-sm font-medium", a2aColor(p.id).text)}>{p.name}</div>
                      {p.role && <div className="truncate text-[10px] text-muted-foreground">{p.role}</div>}
                    </div>
                  </div>
                  {p.skills?.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {p.skills.slice(0, 5).map((s) => <Badge key={s} variant="outline" className="text-[9px]">{s}</Badge>)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// Small labelled metric tile for the collaboration info rail.
function StatTile({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-background/40 px-2.5 py-2">
      <div className={cn("font-stat-number text-lg font-semibold leading-none tabular-nums", accent)}>{value}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

// ── Skills tab: toggle skills on/off per agent ──────────────────────────────
type SkillRow = { id: string; name: string; slug: string; description: string | null; category: string | null; icon: string; required_tools: string[]; config: any; is_system: boolean; system_prompt_extension: string | null };

const SKILL_FILTERS: { key: "all" | "mine" | "examples"; label: string }[] = [
  { key: "all", label: "Tous" },
  { key: "mine", label: "Mes Skills" },
  { key: "examples", label: "Exemples de Skills" },
];

// Lightweight lexical-semantic search for skills. Beyond substring matching we
// expand each query term with a small FR/EN domain synonym map and score hits
// per field, so a query like "marketing" still surfaces a "content-creation"
// skill even without the exact word. Results are ranked by score.
const SKILL_SYNONYMS: Record<string, string[]> = {
  marketing: ["content", "copywriting", "seo", "social", "communication", "growth", "campaign"],
  content: ["marketing", "writing", "copywriting", "editorial", "blog", "redaction"],
  writing: ["content", "copywriting", "editorial", "redaction"],
  security: ["cybersecurity", "securite", "audit", "vulnerability", "compliance", "pentest"],
  securite: ["security", "cybersecurity", "audit", "vulnerabilite"],
  data: ["donnees", "analytics", "analysis", "sql", "dataset", "bi", "metrics"],
  donnees: ["data", "analytics", "analyse", "metrics"],
  analytics: ["data", "analysis", "metrics", "bi", "dashboard"],
  dataviz: ["visualization", "chart", "graph", "dashboard", "design"],
  research: ["recherche", "search", "web", "investigation", "sourcing"],
  recherche: ["research", "search", "web"],
  code: ["programming", "developpement", "software", "engineering", "dev"],
  hr: ["recruiting", "recruitment", "talent", "candidate", "rh", "sourcing"],
  rh: ["hr", "recruiting", "talent", "recrutement"],
  sales: ["ventes", "crm", "prospect", "account", "outreach", "commercial"],
  ventes: ["sales", "crm", "commercial", "prospect"],
  support: ["helpdesk", "customer", "ticket", "service", "sav"],
  podcast: ["audio", "episode", "recording", "voice"],
};

function expandSkillTerms(terms: string[]): string[] {
  const out = new Set(terms);
  for (const t of terms) for (const syn of SKILL_SYNONYMS[t] ?? []) out.add(syn);
  return [...out];
}

/** Relevance score of a skill for a set of query terms (0 = no match). */
function scoreSkill(s: SkillRow, terms: string[]): number {
  if (terms.length === 0) return 1;
  const name = s.name.toLowerCase();
  const slug = s.slug.toLowerCase();
  const domain = (s.category ?? "").toLowerCase();
  const tagStr = (Array.isArray(s.config?.tags) ? (s.config.tags as string[]) : []).join(" ").toLowerCase();
  const toolStr = (s.required_tools ?? []).join(" ").toLowerCase();
  const desc = (s.description ?? "").toLowerCase();
  const hay = [name, slug, domain, tagStr, toolStr, desc].join(" ");
  let score = 0;
  for (const t of terms) {
    if (name.includes(t)) score += 10;
    else if (slug.includes(t)) score += 8;
    else if (domain.includes(t)) score += 6;
    else if (tagStr.includes(t)) score += 5;
    else if (toolStr.includes(t)) score += 4;
    else if (desc.includes(t)) score += 3;
  }
  // Synonym (semantic) hits — only the expanded extras, at a lower weight.
  const extras = expandSkillTerms(terms).filter((t) => !terms.includes(t));
  for (const t of extras) if (hay.includes(t)) score += 2;
  return score;
}

function SkillsTab({ agentId }: { agentId: string }) {
  const { workspaceId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<"all" | "mine" | "examples">("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<SkillRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [focused, setFocused] = useState(false);

  const { data: allSkills } = useQuery({
    queryKey: ["agent_skills_all"],
    queryFn: async () => {
      const { data } = await supabase.from("agent_skills").select("*")
        .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`).order("category, name");
      return (data ?? []) as SkillRow[];
    },
  });

  const { data: activations } = useQuery({
    queryKey: ["agent_skill_activations", agentId],
    queryFn: async () => {
      const { data } = await supabase.from("agent_skill_activations").select("skill_id").eq("agent_id", agentId);
      return new Set((data ?? []).map((a: any) => a.skill_id));
    },
  });

  const activeSet = activations ?? new Set<string>();

  async function toggle(skillId: string) {
    if (activeSet.has(skillId)) {
      await supabase.from("agent_skill_activations").delete().eq("agent_id", agentId).eq("skill_id", skillId);
    } else {
      await supabase.from("agent_skill_activations").insert({ agent_id: agentId, skill_id: skillId });
    }
    queryClient.invalidateQueries({ queryKey: ["agent_skill_activations", agentId] });
  }

  async function removeSkill(s: SkillRow) {
    if (!confirm(`Supprimer le skill « ${s.name} » ? Cette action est irréversible.`)) return;
    await supabase.from("agent_skills").delete().eq("id", s.id);
    if (selected?.id === s.id) setSelected(null);
    queryClient.invalidateQueries({ queryKey: ["agent_skills_all"] });
  }

  const skillsList = allSkills ?? [];
  const base = filter === "mine" ? skillsList.filter((s) => !s.is_system)
    : filter === "examples" ? skillsList.filter((s) => s.is_system)
    : skillsList;

  // Semantic-ish search: score each skill across name, slug, domain, tags,
  // tools and description (with synonym expansion) and rank by relevance, so
  // related skills surface even without an exact word match.
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = terms.length === 0
    ? base
    : base
        .map((s) => ({ s, score: scoreSkill(s, terms) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.s);

  // Autocomplete: the top ranked skills + the domains/tags matching the query.
  const suggestions = (() => {
    if (terms.length === 0) return { skills: [] as SkillRow[], facets: [] as string[] };
    const facetSet = new Set<string>();
    for (const s of base) {
      const cat = s.category ?? "";
      if (cat && terms.some((t) => cat.toLowerCase().includes(t))) facetSet.add(cat);
      for (const tag of Array.isArray(s.config?.tags) ? (s.config.tags as string[]) : []) {
        if (terms.some((t) => tag.toLowerCase().includes(t))) facetSet.add(tag);
      }
    }
    return { skills: filtered.slice(0, 6), facets: [...facetSet].slice(0, 8) };
  })();
  const showSuggestions = focused && terms.length > 0
    && (suggestions.skills.length > 0 || suggestions.facets.length > 0);

  const tags = (s: SkillRow) => Array.isArray(s.config?.tags) ? s.config.tags as string[] : [];

  const CAT_LABELS: Record<string, string> = {
    cybersecurity: "Cybersecurity", "data-analytics": "Data Analytics", general: "General",
    research: "Research", browser: "Browser", code: "Code", data: "Data",
    communication: "Communication", security: "Security", hr: "HR", other: "Other",
  };

  const CAT_COLORS: Record<string, string> = {
    cybersecurity: "#ef4444", "data-analytics": "#3b82f6", general: "#8b5cf6",
    research: "#10b981", browser: "#f59e0b", code: "#6366f1", data: "#0ea5e9",
    communication: "#ec4899", security: "#dc2626", hr: "#14b8a6", other: "#6b7280",
  };

  return (
    <div className="mx-auto max-w-5xl">
      {/* Header — title + description on the left, search on the right. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Skills</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Étendez les capacités de vos agents grâce à des compétences réutilisables.{" "}
            <span className="cursor-pointer text-primary hover:underline">En savoir plus</span>
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 120)}
            onKeyDown={(e) => { if (e.key === "Escape") setFocused(false); }}
            placeholder="Rechercher par nom, domaine, tag…"
            className="h-10 rounded-lg pl-9"
          />

          {/* Autocomplete dropdown */}
          {showSuggestions && (
            <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 overflow-hidden rounded-lg border border-border bg-card shadow-lg">
              {suggestions.skills.length > 0 && (
                <div className="py-1">
                  <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Skills</div>
                  {suggestions.skills.map((s) => (
                    <button
                      key={s.id}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setSelected(s); setFocused(false); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-secondary"
                    >
                      <Zap className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{s.name}</span>
                      {s.category && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{s.category}</span>}
                    </button>
                  ))}
                </div>
              )}
              {suggestions.facets.length > 0 && (
                <div className="border-t border-border px-3 py-2">
                  <div className="pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Domaines / tags</div>
                  <div className="flex flex-wrap gap-1">
                    {suggestions.facets.map((f) => (
                      <button
                        key={f}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setSearch(f); setFocused(false); }}
                        className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Filter pills + create. */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {SKILL_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => { setFilter(f.key); setSelected(null); }}
              className={cn(
                "rounded-full border px-4 py-1.5 text-sm transition-colors",
                filter === f.key
                  ? "border-border bg-secondary text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" className="rounded-full" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> Créer un Skill
        </Button>
      </div>

      {/* Card grid — 2 columns, title + description + ⋮ menu. */}
      {filtered.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          Aucun skill trouvé{search ? ` pour « ${search} »` : ""}.
        </p>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {filtered.map((s) => {
            const isActive = activeSet.has(s.id);
            return (
              <div
                key={s.id}
                onClick={() => setSelected(s)}
                className="group relative cursor-pointer rounded-xl border border-border bg-card/40 p-4 transition-colors hover:bg-card"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="truncate text-sm font-medium text-foreground">{s.name}</h3>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-muted-foreground opacity-70 transition-colors hover:bg-secondary hover:text-foreground group-hover:opacity-100"
                        aria-label="Actions"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setSelected(s)}>Voir les détails</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => toggle(s.id)}>
                        {isActive ? "Désactiver" : "Activer"}
                      </DropdownMenuItem>
                      {!s.is_system && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => removeSkill(s)}>
                            Supprimer
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {s.description && (
                  <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{s.description}</p>
                )}
                {isActive && (
                  <span className="mt-2.5 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    <Check className="h-3 w-3" /> Activé
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Right sidebar overlay: skill detail ── */}
      {selected && (
        <>
        <div className="fixed inset-0 z-50 bg-black/30" onClick={() => setSelected(null)} />
        <aside className="fixed inset-y-0 right-0 z-50 flex w-96 flex-col border-l border-border bg-card shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold truncate">{selected.name}</h3>
            <button onClick={() => setSelected(null)} className="rounded p-1 text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 px-4 py-4 space-y-4">
            {/* Toggle */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">{activeSet.has(selected.id) ? "Active" : "Inactive"}</span>
              <button onClick={() => toggle(selected.id)}
                className={cn("flex h-6 w-11 items-center rounded-full p-0.5 transition-colors", activeSet.has(selected.id) ? "bg-primary" : "bg-secondary")}>
                <span className={cn("block h-5 w-5 rounded-full bg-white transition-transform", activeSet.has(selected.id) && "translate-x-5")} />
              </button>
            </div>

            {/* Description */}
            {selected.description && (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Description</div>
                <p className="text-xs text-foreground/80 leading-relaxed">{selected.description}</p>
              </div>
            )}

            {/* Tags */}
            {tags(selected).length > 0 && (
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tags</div>
                <div className="flex flex-wrap gap-1">
                  {tags(selected).map((t) => (
                    <span key={t} className="rounded-md bg-secondary px-2 py-0.5 text-[10px] text-foreground/70">{t}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Required tools */}
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Required Tools</div>
              <div className="space-y-1">
                {(selected.required_tools ?? []).map((t) => (
                  <div key={t} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
                    <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs font-mono">{t}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Scripts */}
            {Array.isArray(selected.config?.scripts) && selected.config.scripts.length > 0 && (
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Scripts ({selected.config.scripts.length})</div>
                <div className="space-y-1.5">
                  {selected.config.scripts.map((sc: any, i: number) => (
                    <details key={i} className="rounded-md border border-border">
                      <summary className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-secondary/30">
                        <FileCode className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="font-mono">{sc.name}</span>
                      </summary>
                      <pre className="bg-zinc-950 px-3 py-2 text-[10px] text-zinc-300 font-mono overflow-x-auto max-h-48 overflow-y-auto">{sc.content}</pre>
                    </details>
                  ))}
                </div>
              </div>
            )}

            {/* References */}
            {Array.isArray(selected.config?.references) && selected.config.references.length > 0 && (
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">References ({selected.config.references.length})</div>
                <div className="space-y-1.5">
                  {selected.config.references.map((ref: any, i: number) => (
                    <details key={i} className="rounded-md border border-border">
                      <summary className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-secondary/30">
                        <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span>{ref.name}</span>
                      </summary>
                      <div className="px-3 py-2 text-[10px] text-muted-foreground whitespace-pre-wrap max-h-48 overflow-y-auto">{ref.content}</div>
                    </details>
                  ))}
                </div>
              </div>
            )}

            {/* System prompt extension */}
            {selected.system_prompt_extension && (
              <details className="rounded-md border border-border">
                <summary className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-secondary/30">
                  <Brain className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Prompt Extension</span>
                </summary>
                <div className="px-3 py-2 text-[10px] text-muted-foreground whitespace-pre-wrap max-h-64 overflow-y-auto">{selected.system_prompt_extension}</div>
              </details>
            )}

            {/* Metadata */}
            <div className="border-t border-border pt-3 space-y-1 text-[10px] text-muted-foreground">
              <div>Slug: <span className="font-mono text-foreground/70">{selected.slug}</span></div>
              <div>Category: <span className="text-foreground/70">{CAT_LABELS[selected.category || "other"] ?? selected.category}</span></div>
              {selected.is_system && <div className="text-primary font-medium">System skill</div>}
            </div>
          </div>
        </aside>
        </>
      )}

      <CreateSkillDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        workspaceId={workspaceId}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["agent_skills_all"] })}
      />
    </div>
  );
}

// Minimal "create a skill" form — inserts a workspace-owned (non-system) skill.
function CreateSkillDialog({
  open, onOpenChange, workspaceId, onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string | null;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);

  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  function reset() {
    setName(""); setDescription(""); setCategory(""); setPrompt("");
  }

  async function create() {
    if (!name.trim() || !workspaceId) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("agent_skills").insert({
        workspace_id: workspaceId,
        name: name.trim(),
        slug: slug || `skill-${Date.now()}`,
        description: description.trim() || null,
        category: category.trim() || null,
        system_prompt_extension: prompt.trim() || null,
        is_system: false,
      });
      if (error) { alert(error.message); return; }
      onCreated();
      onOpenChange(false);
      reset();
    } finally {
      setSaving(false);
    }
  }

  const textareaClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Créer un Skill</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Nom</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Rédacteur SEO" />
            {slug && <p className="mt-1 text-[10px] text-muted-foreground">slug : <span className="font-mono">{slug}</span></p>}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Quand charger ce skill…"
              className={textareaClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Catégorie (optionnel)</label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="ex. communication" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Instructions / prompt (optionnel)</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Le playbook injecté dans le prompt quand ce skill est chargé…"
              className={textareaClass}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => { onOpenChange(false); reset(); }}>Annuler</Button>
            <Button size="sm" onClick={create} disabled={saving || !name.trim()}>
              {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Plus className="mr-1 h-3 w-3" />} Créer
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Agent Artifacts tab: live run activity + deliverables ────────────────────
// Human-readable label for a run event, derived from its payload (the events
// table has no `summary` column — it stores a jsonb `payload`).
function artifactEventLabel(ev: any): string {
  const p = ev.payload ?? {};
  switch (ev.kind) {
    case "tool_call": return toolSummary(p.tool ?? p.name ?? "tool", p.args ?? p.arguments ?? {});
    case "tool_result": return String(p.preview ?? "").slice(0, 120) || "Tool result";
    case "llm_call": return `LLM ${p.model ?? ""}`.trim();
    case "plan": return `Reasoned & planned · ${p.plan?.tasks?.length ?? 0} tasks`;
    case "plan_step": return `${p.step_id ?? "step"} → ${p.status ?? ""}`.trim();
    case "status": return String(p.message ?? "Status update");
    case "log": return String(p.message ?? "Log");
    case "error": return String(p.error ?? "Error");
    case "tool_error": return String(p.message ?? "Incomplete tool call");
    case "question": return `Asked: ${String(p.question ?? "").slice(0, 100)}`;
    default: return ev.kind;
  }
}

function AgentArtifactsTab({ agentId }: { agentId: string }) {
  const { projectId } = useCurrentContext();

  const { data } = useQuery({
    queryKey: ["agent_artifacts_runs", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data: runs } = await supabase.from("internal_agent_runs")
        .select("id, mission_id, status, created_at, finished_at")
        .eq("agent_id", agentId).order("created_at", { ascending: false }).limit(10);
      const runIds = (runs ?? []).map((r: any) => r.id);
      const { data: events } = runIds.length
        ? await supabase.from("internal_agent_run_events")
            .select("id, run_id, kind, payload, created_at")
            .in("run_id", runIds).order("created_at", { ascending: true }).limit(100)
        : { data: [] };
      const { data: deliverables } = await supabase.from("internal_agent_deliverables")
        .select("id, run_id, kind, name, content, created_at")
        .eq("agent_id", agentId).order("created_at", { ascending: false }).limit(20);
      return { runs: runs ?? [], events: events ?? [], deliverables: deliverables ?? [] };
    },
    refetchInterval: 5000,
  });

  const runs = data?.runs ?? [];
  const events = data?.events ?? [];
  const deliverables = data?.deliverables ?? [];

  const planningCards = runs.slice(0, 5).map((run: any) => {
    const runEvents = events.filter((e: any) => e.run_id === run.id);
    const steps: PlanStep[] = runEvents.map((ev: any, i: number): PlanStep => ({
      id: ev.id,
      title: artifactEventLabel(ev),
      status: i === runEvents.length - 1 && run.status === "running" ? "active" :
              ev.kind === "error" || ev.kind === "tool_error" ? "error" : "success",
      duration: new Date(ev.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    }));
    if (run.status === "running" && steps.length === 0) {
      steps.push({ id: "init", title: "Initializing…", status: "active" });
    }
    return { runId: run.id, status: run.status, steps };
  });

  return (
    <div className="space-y-6 px-6 py-6 lg:px-10">
      <h3 className="text-sm font-semibold">Agent Activity & Artifacts</h3>

      {/* Live runs */}
      {planningCards.filter((r) => r.status === "running").map((r) => (
        <AgentPlanning key={r.runId} title="Agent is working" steps={r.steps} />
      ))}

      {/* Recent completed runs */}
      {planningCards.filter((r) => r.status !== "running").slice(0, 3).map((r) => (
        <AgentPlanning key={r.runId} title={`Run ${r.status}`} steps={r.steps} />
      ))}

      {/* Deliverables */}
      {deliverables.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Deliverables</h4>
          <div className="space-y-1.5">
            {deliverables.map((d: any) => (
              <div key={d.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{d.name}</span>
                  <Badge variant="outline" className="text-[9px]">{d.kind}</Badge>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {new Date(d.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                {d.content && <p className="mt-1.5 text-xs text-muted-foreground line-clamp-3">{d.content}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {runs.length === 0 && deliverables.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">No activity yet. Assign a mission to this agent to see its work here.</p>
      )}
    </div>
  );
}

// Re-export tab metadata so the sidebar can show the same labels/icons.
export const INTERNAL_AGENT_TABS: { slug: InternalAgentTab; label: string; icon: any }[] = [
  { slug: "chat", label: "Chat", icon: ChatCircleIcon },
  // Missions · Deliverables · Artifacts are now sub-tabs of the Missions hub.
  { slug: "mission", label: "Missions", icon: TargetIcon },
  // Instructions · Skills · Memory · Connectors are now sub-tabs of Personnaliser.
  { slug: "customize", label: "Personnaliser", icon: SlidersHorizontalIcon },
  { slug: "collaboration", label: "Collaboration", icon: ShareNetworkIcon },
  { slug: "channels", label: "Channels", icon: SlackLogoIcon },
  { slug: "analytics", label: "Analytics", icon: ChartBarIcon },
  { slug: "settings", label: "Settings", icon: GearSixIcon },
];
