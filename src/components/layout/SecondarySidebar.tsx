import { NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Plus, FolderKanban, Loader2 } from "lucide-react";
import { ChatCircleIcon, BookOpenIcon, PuzzlePieceIcon, PlugsConnectedIcon, ChartBarIcon, GearSixIcon } from "@phosphor-icons/react";
import { findModule, itemsInGroup, moduleGroups, type SubNavItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { ChatConversationsItem } from "./ChatConversationsItem";
import { InboxChannelsItem } from "./InboxChannelsItem";
import { CrmObjectsItem } from "./CrmObjectsItem";
import { AccordionNavItem } from "./AccordionNavItem";
import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { INTERNAL_AGENT_TABS } from "@/features/internal-agents/InternalAgentDetail";
import { AgentAvatar } from "@/features/internal-agents/AvatarPicker";
import { MODULE_PROJECT_CONFIGS, type ModuleProjectConfig } from "@/lib/module-project-config";
import { fetchModuleProjects, type ModuleProject } from "@/features/module-projects/moduleProjectModel";
import { useCurrentContext } from "@/hooks/useCurrentContext";

// Agent builder sub-tabs, shown in the secondary sidebar once an agent is opened.
const AGENT_TABS = [
  { slug: "playground", label: "Playground", icon: ChatCircleIcon },
  { slug: "knowledge", label: "Knowledge", icon: BookOpenIcon },
  { slug: "widget", label: "Widget", icon: PuzzlePieceIcon },
  { slug: "analytics", label: "Analytics", icon: ChartBarIcon },
  { slug: "settings", label: "Settings", icon: GearSixIcon },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
    isActive
      ? "bg-sidebar-accent text-foreground shadow-[inset_2px_0_0_0_hsl(var(--accent-coral))]"
      : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
  );

export function SecondarySidebar() {
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const location = useLocation();

  // Match the module from the exact path segment: /app/:ws/:proj/<module>/<sub>
  const segments = location.pathname.split("/").filter(Boolean);
  const appIdx = segments.indexOf("app");
  const moduleSlug = appIdx >= 0 ? segments[appIdx + 3] : undefined;
  const base = `/app/${workspaceSlug}/${projectSlug}`;

  // CRM full record view (crm/workspace/<obj>/<recordId>) brings its own fields
  // sidebar → eclipse the objects sidebar entirely.
  if (moduleSlug === "crm" && segments[appIdx + 4] === "workspace" && segments[appIdx + 6]) {
    return null;
  }

  // Module project detail view — has its own sidebar, like CRM records.
  if (segments[appIdx + 4] === "project" && segments[appIdx + 5]) {
    return null;
  }

  // Module with project-based navigation → show project list in sidebar.
  const moduleProjectConfig = moduleSlug ? MODULE_PROJECT_CONFIGS[moduleSlug] : undefined;
  if (moduleProjectConfig) {
    return <ProjectsSidebar config={moduleProjectConfig} base={base} moduleSlug={moduleSlug!} />;
  }

  // AI Workforce module → show hired agents in sidebar.
  if (moduleSlug === "agent" && segments[appIdx + 4] !== "builder" && segments[appIdx + 4] !== "internal") {
    return <AgentWorkforceSidebar base={base} />;
  }

  // Special case: agent builder → show the agent's own tabs in this sidebar.
  // Path: /app/:ws/:proj/agent/builder/:agentId/:tab?
  if (moduleSlug === "agent" && segments[appIdx + 4] === "builder") {
    const agentId = segments[appIdx + 5];
    return (
      <aside className="flex h-full w-52 flex-col border-r border-border bg-sidebar">
        <div className="flex h-14 items-center border-b border-border px-4">
          <NavLink to={`${base}/agent/public-agents`} className="flex items-center gap-2 text-sm font-medium text-sidebar-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Agents publics
          </NavLink>
        </div>
        <nav className="scrollbar-slim flex-1 overflow-y-auto p-2">
          {AGENT_TABS.map((t) => (
            <NavLink key={t.slug} end to={`${base}/agent/builder/${agentId}/${t.slug}`} className={linkClass}>
              <t.icon weight="duotone" className="h-4 w-4 shrink-0" />
              <span className="truncate">{t.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
    );
  }

  // Internal agent detail → show the agent's own tabs.
  // Path: /app/:ws/:proj/agent/internal/:agentId/:tab?
  if (moduleSlug === "agent" && segments[appIdx + 4] === "internal") {
    const agentId = segments[appIdx + 5];
    return (
      <aside className="flex h-full w-52 flex-col border-r border-border bg-sidebar">
        <div className="flex h-14 items-center border-b border-border px-4">
          <NavLink to={`${base}/agent/internal-agents`} className="flex items-center gap-2 text-sm font-medium text-sidebar-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Internal agents
          </NavLink>
        </div>
        <nav className="scrollbar-slim flex-1 overflow-y-auto p-2">
          {INTERNAL_AGENT_TABS.map((t) => (
            <NavLink key={t.slug} end to={`${base}/agent/internal/${agentId}/${t.slug}`} className={linkClass}>
              <t.icon weight="duotone" className="h-4 w-4 shrink-0" />
              <span className="truncate">{t.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
    );
  }

  // Vibe Code → onglets + persisted chat sessions.
  if (moduleSlug === "vibe-code") {
    return <VibeCodeSidebar base={base} pathname={location.pathname} search={location.search} />;
  }

  const module = findModule(moduleSlug ?? "crm");

  // Group children by parent slug. Top-level items = those without a parent.
  const childrenByParent = useMemo(() => {
    const m = new Map<string, SubNavItem[]>();
    if (!module) return m;
    module.subItems.forEach((s) => {
      if (s.parent) {
        const arr = m.get(s.parent) ?? [];
        arr.push(s);
        m.set(s.parent, arr);
      }
    });
    return m;
  }, [module]);

  if (!module) return null;

  // ── Groups-as-tabs mode (SaaS Analytics): the sidebar lists groups; each
  // group links to its first item, and a horizontal SubTabBar (rendered by the
  // page chrome) shows the items within the active group. ──
  if (module.groupsAsTabs) {
    const groups = moduleGroups(module);
    // Single-group module (the split AI-control modules): the tabs live in the
    // Topbar (SubTabBar), so a left rail listing one group is redundant — hide it.
    if (groups.length <= 1) return null;
    const activeSlug = segments[appIdx + 4];
    const activeGroup = groups.find((g) =>
      itemsInGroup(module, g).some((it) => it.slug === activeSlug),
    );
    return (
      <aside className="flex h-full w-52 flex-col border-r border-border bg-sidebar">
        <div className="flex h-14 items-center border-b border-border px-4">
          <div className="text-base font-semibold text-foreground">{module.label}</div>
        </div>
        <nav className="scrollbar-slim flex-1 overflow-y-auto p-2">
          {groups.map((g) => {
            const items = itemsInGroup(module, g);
            const first = items[0];
            if (!first) return null;
            const isActive = g === activeGroup;
            return (
              <NavLink
                key={g}
                to={`${base}/${module.slug}/${first.slug}`}
                className={cn(
                  "flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-sidebar-accent font-medium text-foreground"
                    : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )}
              >
                <span>{g}</span>
                {items.length > 1 && (
                  <span className="ml-2 rounded-full bg-sidebar-foreground/10 px-1.5 text-[10px] tabular-nums text-muted-foreground">
                    {items.length}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>
      </aside>
    );
  }

  const topLevel = module.subItems.filter((s) => !s.parent);

  return (
    <aside className="flex h-full w-52 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center border-b border-border px-4">
        <div className="text-base font-semibold text-foreground">{module.label}</div>
      </div>
      <nav className="scrollbar-slim flex-1 overflow-y-auto p-2">
        {topLevel.map((sub, i) => {
          const to = `${base}/${module.slug}/${sub.slug}`;
          const prevGroup = i > 0 ? topLevel[i - 1].group : undefined;
          const showDivider = sub.group && sub.group !== prevGroup;
          const kids = childrenByParent.get(sub.slug);

          const node = (() => {
            if ((module.slug === "ai" || module.slug === "agent") && sub.slug === "chat") {
              return <ChatConversationsItem key={sub.slug} to={to} label={sub.label} />;
            }
            if (module.slug === "pm" && sub.slug === "inbox") {
              return <InboxChannelsItem key={sub.slug} to={to} label={sub.label} />;
            }
            if (module.slug === "crm" && sub.slug === "workspace") {
              return <CrmObjectsItem key={sub.slug} />;
            }
            if (kids && kids.length > 0) {
              return (
                <AccordionNavItem
                  key={sub.slug}
                  parentTo={to}
                  parentLabel={sub.label}
                  items={kids}
                  childBase={`${base}/${module.slug}/`}
                />
              );
            }
            return (
              <NavLink key={sub.slug} to={to} className={linkClass}>
                {sub.icon && <sub.icon weight="duotone" className="h-[18px] w-[18px] shrink-0" />}
                <span className="truncate">{sub.label}</span>
              </NavLink>
            );
          })();

          if (!showDivider) return node;
          return (
            <div key={sub.slug + "-grouped"}>
              <div
                className={cn(
                  "px-3 pb-2 pt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground",
                  i > 0 && "mt-4 border-t border-border/60 pt-5",
                )}
              >
                {sub.group}
              </div>
              {node}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

// ── Projects sidebar for project-based modules ──────────────────────────────

function ProjectsSidebar({ config, base, moduleSlug }: { config: ModuleProjectConfig; base: string; moduleSlug: string }) {
  const { projectId } = useCurrentContext();
  const navigate = useNavigate();
  const location = useLocation();

  const { data: projects, isLoading } = useQuery({
    queryKey: ["module_projects", projectId, moduleSlug],
    enabled: !!projectId,
    queryFn: () => fetchModuleProjects(projectId!, moduleSlug),
    refetchInterval: 10000,
  });

  const currentProjectId = (() => {
    const segments = location.pathname.split("/").filter(Boolean);
    const projIdx = segments.indexOf("project");
    return projIdx >= 0 ? segments[projIdx + 1] : undefined;
  })();

  return (
    <aside className="flex h-full w-52 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center justify-between border-b border-border px-4">
        <div className="text-base font-semibold text-foreground">{config.label}</div>
      </div>

      <div className="scrollbar-slim flex-1 overflow-y-auto p-2">
        {/* New project button */}
        <button
          onClick={() => navigate(`${base}/${moduleSlug}`)}
          className="mb-2 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-primary hover:bg-sidebar-accent/60"
        >
          <Plus className="h-3.5 w-3.5" /> New project
        </button>

        {isLoading && (
          <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        )}

        {/* Project list */}
        {(projects ?? []).map((mp) => {
          const typeDef = config.projectTypes.find((t) => t.key === mp.project_type);
          const isActive = mp.id === currentProjectId;
          return (
            <button
              key={mp.id}
              onClick={() => navigate(`${base}/${moduleSlug}/project/${mp.id}`)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                isActive
                  ? "bg-sidebar-accent font-medium text-foreground"
                  : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-white text-[10px]" style={{ backgroundColor: mp.color }}>
                {(typeDef?.label ?? mp.project_type).charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate">{mp.name}</span>
            </button>
          );
        })}

        {!isLoading && (projects ?? []).length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">No projects yet.</p>
        )}
      </div>
    </aside>
  );
}

// ── Agent workforce sidebar ─────────────────────────────────────────────────
// The AI Workforce module splits into two parts: internal agents (private team
// workers) and public agents (customer-facing — SAV, e-commerce, onboarding).
// Both parts live in this one sidebar as labelled sections.

interface HiredAgent { id: string; name: string; description: string | null; avatar_emoji: string | null; avatar_url: string | null; accent_color: string | null }
interface PublicAgent { id: string; name: string; accent_color: string | null; enabled: boolean }

function AgentWorkforceSidebar({ base }: { base: string }) {
  const { projectId } = useCurrentContext();
  const navigate = useNavigate();
  const location = useLocation();

  const { data: internalAgents, isLoading: loadingInternal } = useQuery({
    queryKey: ["sidebar_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await (await import("@/lib/supabase")).supabase
        .from("internal_agents").select("id, name, description, avatar_emoji, avatar_url, accent_color")
        .eq("project_id", projectId!).eq("is_archived", false).order("created_at", { ascending: false });
      return (data ?? []) as HiredAgent[];
    },
    refetchInterval: 10000,
  });

  const { data: publicAgents, isLoading: loadingPublic } = useQuery({
    queryKey: ["sidebar_public_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await (await import("@/lib/supabase")).supabase
        .from("rag_agents").select("id, name, accent_color, enabled")
        .eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as PublicAgent[];
    },
    refetchInterval: 10000,
  });

  const segs = location.pathname.split("/").filter(Boolean);
  const currentInternalId = (() => {
    const idx = segs.indexOf("internal");
    return idx >= 0 ? segs[idx + 1] : undefined;
  })();
  const currentPublicId = (() => {
    const idx = segs.indexOf("builder");
    return idx >= 0 ? segs[idx + 1] : undefined;
  })();
  const agentSeg = (() => {
    const idx = segs.indexOf("agent");
    return idx >= 0 ? segs[idx + 1] : undefined;
  })();
  const onInternalList = agentSeg === "internal-agents";
  const onPublicList = agentSeg === "public-agents";
  const onCollections = agentSeg === "collections";
  const onSkills = agentSeg === "skills";
  const onMcp = agentSeg === "mcp";

  return (
    <aside className="flex h-full w-52 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center justify-between border-b border-border px-4">
        <div className="text-base font-semibold text-foreground">AI Workforce</div>
      </div>

      <div className="scrollbar-slim flex-1 overflow-y-auto p-2">
        {/* ── Internal agents ── */}
        <SectionLabel>Agents internes</SectionLabel>
        <button
          onClick={() => navigate(`${base}/agent/internal-agents`)}
          className={cn(
            "mb-1 flex w-full items-center gap-2 rounded-2xl bg-neutral-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800",
            onInternalList && "ring-1 ring-white/20",
          )}
        >
          <Plus className="h-3.5 w-3.5" /> Recruter un agent
        </button>
        {loadingInternal && <SidebarSpinner />}
        {(internalAgents ?? []).map((a) => {
          const isActive = a.id === currentInternalId;
          return (
            <button
              key={a.id}
              onClick={() => navigate(`${base}/agent/internal/${a.id}/chat`)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                isActive
                  ? "bg-sidebar-accent font-medium text-foreground"
                  : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <AgentAvatar url={a.avatar_url} seed={a.name}
                className="h-6 w-6 shrink-0 overflow-hidden rounded-md" />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
            </button>
          );
        })}
        {!loadingInternal && (internalAgents ?? []).length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">Aucun agent interne.</p>
        )}

        {/* ── Public agents ── */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <SectionLabel>Agents publics</SectionLabel>
        </div>
        <button
          onClick={() => navigate(`${base}/agent/public-agents`)}
          className={cn(
            "mb-1 flex w-full items-center gap-2 rounded-2xl bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-200",
            onPublicList && "ring-1 ring-black/10",
          )}
        >
          <Plus className="h-3.5 w-3.5" /> Nouvel agent
        </button>
        {loadingPublic && <SidebarSpinner />}
        {(publicAgents ?? []).map((a) => {
          const isActive = a.id === currentPublicId;
          const accent = a.accent_color || "#001BB7";
          return (
            <button
              key={a.id}
              onClick={() => navigate(`${base}/agent/builder/${a.id}/playground`)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                isActive
                  ? "bg-sidebar-accent font-medium text-foreground"
                  : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ background: `${accent}26` }}>
                <span className="h-2 w-2 rounded-full" style={{ background: accent }} />
              </span>
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
            </button>
          );
        })}
        {!loadingPublic && (publicAgents ?? []).length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">Aucun agent public.</p>
        )}

        {/* ── Knowledge base ── */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <SectionLabel>Base de connaissances</SectionLabel>
        </div>
        <button
          onClick={() => navigate(`${base}/agent/collections`)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
            onCollections
              ? "bg-sidebar-accent font-medium text-foreground"
              : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
          )}
        >
          <BookOpenIcon weight="duotone" className="h-[18px] w-[18px] shrink-0" />
          <span className="min-w-0 flex-1 truncate">Collections</span>
        </button>

        {/* ── Custom Skills ── */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <SectionLabel>Compétences</SectionLabel>
        </div>
        <button
          onClick={() => navigate(`${base}/agent/skills`)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
            onSkills
              ? "bg-sidebar-accent font-medium text-foreground"
              : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
          )}
        >
          <PuzzlePieceIcon weight="duotone" className="h-[18px] w-[18px] shrink-0" />
          <span className="min-w-0 flex-1 truncate">Custom Skills</span>
        </button>
        <button
          onClick={() => navigate(`${base}/agent/mcp`)}
          className={cn(
            "mt-1 flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
            onMcp
              ? "bg-sidebar-accent font-medium text-foreground"
              : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
          )}
        >
          <PlugsConnectedIcon weight="duotone" className="h-[18px] w-[18px] shrink-0" />
          <span className="min-w-0 flex-1 truncate">MCP Servers</span>
        </button>
      </div>
    </aside>
  );
}

// ── Vibe Code sidebar — module onglets + persisted chat sessions ─────────────
interface VibeSession { id: string; title: string; updated_at: string }
interface VibeProject { id: string; name: string; repository_id: string }

function VibeCodeSidebar({ base, pathname, search }: { base: string; pathname: string; search: string }) {
  const { workspaceId, projectId } = useCurrentContext();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const mod = findModule("vibe-code");
  const segs = pathname.split("/").filter(Boolean);
  const activeSub = segs[segs.indexOf("vibe-code") + 1];
  const params = new URLSearchParams(search);
  const activeSession = params.get("session");
  const activeProject = params.get("project");
  const [creating, setCreating] = useState(false);

  const { data: vibeProjects } = useQuery({
    queryKey: ["vibe_projects", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { supabase } = await import("@/lib/supabase");
      const { data } = await supabase.from("vibe_projects").select("id, name, repository_id")
        .eq("project_id", projectId!).order("updated_at", { ascending: false });
      return (data ?? []) as VibeProject[];
    },
  });

  // Inside a project → only its sessions; otherwise the project-less ones.
  const { data: sessions } = useQuery({
    queryKey: ["vibe_sessions", projectId, activeProject],
    enabled: !!projectId,
    refetchInterval: 8000,
    queryFn: async () => {
      const { supabase } = await import("@/lib/supabase");
      let q = supabase.from("vibe_sessions").select("id, title, updated_at").eq("project_id", projectId!);
      q = activeProject ? q.eq("vibe_project_id", activeProject) : q.is("vibe_project_id", null);
      const { data } = await q.order("updated_at", { ascending: false }).limit(50);
      return (data ?? []) as VibeSession[];
    },
  });

  const chatHref = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (activeProject) p.set("project", activeProject);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    const qs = p.toString();
    return `${base}/vibe-code/chat${qs ? `?${qs}` : ""}`;
  };

  return (
    <aside className="flex h-full w-52 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center border-b border-border px-4"><div className="text-base font-semibold text-foreground">Vibe Code</div></div>
      <nav className="scrollbar-slim flex-1 overflow-y-auto p-2">
        {(mod?.subItems ?? []).map((s) => (
          <NavLink key={s.slug} to={`${base}/vibe-code/${s.slug}`} className={linkClass}>
            {s.icon && <s.icon weight="duotone" className="h-[18px] w-[18px] shrink-0" />}
            <span className="truncate">{s.label}</span>
          </NavLink>
        ))}

        {/* Projects — each is bound to one repo; its sessions inherit that repo. */}
        <div className="mt-4 border-t border-border/60 pt-3">
          <div className="flex items-center justify-between px-3 pb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Projets</span>
            <button onClick={() => setCreating(true)} title="Nouveau projet" className="text-muted-foreground hover:text-foreground">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            onClick={() => navigate(`${base}/vibe-code/chat`)}
            className={cn("flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
              !activeProject ? "bg-sidebar-accent font-medium text-foreground" : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}
          >
            <span className="min-w-0 flex-1 truncate">Sans projet</span>
          </button>
          {(vibeProjects ?? []).map((p) => (
            <button
              key={p.id}
              onClick={() => navigate(`${base}/vibe-code/chat?project=${p.id}`)}
              className={cn("flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                activeProject === p.id ? "bg-sidebar-accent font-medium text-foreground" : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}
            >
              <FolderKanban className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
            </button>
          ))}
        </div>

        <div className="mt-4 border-t border-border/60 pt-3">
          <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Sessions</div>
          <button
            onClick={() => navigate(chatHref({}))}
            className={cn("mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-sidebar-accent/60",
              activeSub === "chat" && !activeSession ? "bg-sidebar-accent font-medium text-foreground" : "font-medium text-primary")}
          >
            <Plus className="h-3.5 w-3.5" /> Nouvelle session
          </button>
          {(sessions ?? []).length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Aucune session.</p>
          ) : (sessions ?? []).map((s) => (
            <button
              key={s.id}
              onClick={() => navigate(chatHref({ session: s.id }))}
              className={cn("flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                activeSession === s.id && activeSub === "chat" ? "bg-sidebar-accent font-medium text-foreground" : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}
            >
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
            </button>
          ))}
        </div>
      </nav>

      {creating && (
        <NewVibeProjectDialog
          workspaceId={workspaceId}
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ["vibe_projects", projectId] });
            navigate(`${base}/vibe-code/chat?project=${id}`);
          }}
        />
      )}
    </aside>
  );
}

/** Create a Vibe project: a name + the single repo it works on. */
function NewVibeProjectDialog({
  workspaceId, projectId, onClose, onCreated,
}: {
  workspaceId?: string | null; projectId?: string | null;
  onClose: () => void; onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [repoId, setRepoId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: repos } = useQuery({
    queryKey: ["repositories", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { supabase } = await import("@/lib/supabase");
      const { data } = await supabase.from("repositories").select("id, full_name")
        .eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as { id: string; full_name: string }[];
    },
  });
  const list = repos ?? [];
  const chosen = repoId || list[0]?.id || "";

  async function create() {
    if (!workspaceId || !projectId || !name.trim() || !chosen) return;
    setSaving(true); setError(null);
    try {
      const { supabase } = await import("@/lib/supabase");
      const { data, error } = await supabase.from("vibe_projects")
        .insert({ workspace_id: workspaceId, project_id: projectId, name: name.trim(), repository_id: chosen })
        .select("id").single();
      if (error) throw error;
      onCreated(data.id as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Nouveau projet Vibe Code</DialogTitle>
          <DialogDescription>Un projet est lié à un seul dépôt — toutes ses discussions auront ce dépôt pour contexte.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Nom</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Refonte du checkout" />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-foreground">Dépôt</span>
            {list.length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucun dépôt connecté — connectez-en un dans le module Dépôts.</p>
            ) : (
              <select value={chosen} onChange={(e) => setRepoId(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm">
                {list.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
              </select>
            )}
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={create} disabled={saving || !name.trim() || !chosen}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

function SidebarSpinner() {
  return <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
}
