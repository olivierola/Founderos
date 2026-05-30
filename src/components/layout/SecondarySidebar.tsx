import { NavLink, useLocation, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { findModule, type SubNavItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { ChatConversationsItem } from "./ChatConversationsItem";
import { AccordionNavItem } from "./AccordionNavItem";
import { useMemo } from "react";

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

  const module = findModule(moduleSlug ?? "overview");

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
            if (module.slug === "ai" && sub.slug === "chat") {
              return <ChatConversationsItem key={sub.slug} to={to} label={sub.label} />;
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
                  "px-3 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground",
                  i > 0 && "mt-1 border-t border-border/60 pt-3",
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
