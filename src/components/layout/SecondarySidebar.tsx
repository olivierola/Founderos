import { NavLink, useLocation, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { findModule } from "@/lib/navigation";
import { cn } from "@/lib/utils";

// Agent builder sub-tabs, shown in the secondary sidebar once an agent is opened.
const AGENT_TABS = [
  { slug: "knowledge", label: "Knowledge" },
  { slug: "playground", label: "Playground" },
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
  if (!module) return null;

  return (
    <aside className="flex h-full w-56 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center border-b border-border px-4">
        <div className="text-base font-semibold text-foreground">{module.label}</div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        {module.subItems.map((sub) => (
          <NavLink key={sub.slug} to={`${base}/${module.slug}/${sub.slug}`} className={linkClass}>
            {sub.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
