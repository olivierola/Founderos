import { NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Plus, FolderKanban, Loader2 } from "lucide-react";
import { findModule, itemsInGroup, moduleGroups, type SubNavItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { ChatConversationsItem } from "./ChatConversationsItem";
import { InboxChannelsItem } from "./InboxChannelsItem";
import { CrmObjectsItem } from "./CrmObjectsItem";
import { AccordionNavItem } from "./AccordionNavItem";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { INTERNAL_AGENT_TABS } from "@/features/internal-agents/InternalAgentDetail";
import { MODULE_PROJECT_CONFIGS, type ModuleProjectConfig } from "@/lib/module-project-config";
import { fetchModuleProjects, type ModuleProject } from "@/features/module-projects/moduleProjectModel";
import { useCurrentContext } from "@/hooks/useCurrentContext";

// Agent builder sub-tabs, shown in the secondary sidebar once an agent is opened.
const AGENT_TABS = [
  { slug: "playground", label: "Playground" },
  { slug: "knowledge", label: "Knowledge" },
  { slug: "widget", label: "Widget" },
  { slug: "analytics", label: "Analytics" },
  { slug: "settings", label: "Settings" },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
    isActive
      ? "bg-sidebar-accent text-foreground"
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
      <aside className="flex h-full w-56 flex-col border-r border-border bg-sidebar">
        <div className="flex h-14 items-center border-b border-border px-4">
          <NavLink to={`${base}/agent/agents`} className="flex items-center gap-2 text-sm font-medium text-sidebar-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> All agents
          </NavLink>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {AGENT_TABS.map((t) => (
            <NavLink key={t.slug} end to={`${base}/agent/builder/${agentId}/${t.slug}`} className={linkClass}>
              {t.label}
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
      <aside className="flex h-full w-56 flex-col border-r border-border bg-sidebar">
        <div className="flex h-14 items-center border-b border-border px-4">
          <NavLink to={`${base}/agent/internal-agents`} className="flex items-center gap-2 text-sm font-medium text-sidebar-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Internal agents
          </NavLink>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {INTERNAL_AGENT_TABS.map((t) => (
            <NavLink key={t.slug} end to={`${base}/agent/internal/${agentId}/${t.slug}`} className={linkClass}>
              {t.label}
            </NavLink>
          ))}
        </nav>
      </aside>
    );
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
    const activeSlug = segments[appIdx + 4];
    const activeGroup = groups.find((g) =>
      itemsInGroup(module, g).some((it) => it.slug === activeSlug),
    );
    return (
      <aside className="flex h-full w-56 flex-col border-r border-border bg-sidebar">
        <div className="flex h-14 items-center border-b border-border px-4">
          <div className="text-base font-semibold text-foreground">{module.label}</div>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
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
    <aside className="flex h-full w-56 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center border-b border-border px-4">
        <div className="text-base font-semibold text-foreground">{module.label}</div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
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
                {sub.label}
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
    <aside className="flex h-full w-56 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center justify-between border-b border-border px-4">
        <div className="text-base font-semibold text-foreground">{config.label}</div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
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

interface HiredAgent { id: string; name: string; description: string | null; avatar_emoji: string | null; accent_color: string | null }

function AgentWorkforceSidebar({ base }: { base: string }) {
  const { projectId } = useCurrentContext();
  const navigate = useNavigate();
  const location = useLocation();

  const { data: agents, isLoading } = useQuery({
    queryKey: ["sidebar_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await (await import("@/lib/supabase")).supabase
        .from("internal_agents").select("id, name, description, avatar_emoji, accent_color")
        .eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as HiredAgent[];
    },
    refetchInterval: 10000,
  });

  const currentAgentId = (() => {
    const segs = location.pathname.split("/").filter(Boolean);
    const idx = segs.indexOf("internal");
    return idx >= 0 ? segs[idx + 1] : undefined;
  })();

  return (
    <aside className="flex h-full w-56 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center justify-between border-b border-border px-4">
        <div className="text-base font-semibold text-foreground">AI Workforce</div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        <button
          onClick={() => navigate(`${base}/agent/internal-agents`)}
          className="mb-2 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-primary hover:bg-sidebar-accent/60"
        >
          <Plus className="h-3.5 w-3.5" /> Hire agent
        </button>

        {isLoading && (
          <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        )}

        {(agents ?? []).map((a) => {
          const isActive = a.id === currentAgentId;
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
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sm"
                style={{ backgroundColor: (a.accent_color ?? "#6366f1") + "20" }}>
                {a.avatar_emoji ?? "🤖"}
              </span>
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
            </button>
          );
        })}

        {!isLoading && (agents ?? []).length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">No agents hired yet.</p>
        )}
      </div>
    </aside>
  );
}
