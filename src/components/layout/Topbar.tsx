import { Link, useParams, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search, Bell, Sun, Moon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useTheme } from "@/lib/theme-context";

export function Topbar() {
  const { workspaceSlug } = useParams();
  const { workspace, project } = useCurrentContext();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();

  // Detect /app/:ws/:proj/agent/builder/:agentId(/:tab) to show the agent name.
  const segs = location.pathname.split("/").filter(Boolean);
  const appIdx = segs.indexOf("app");
  const moduleSlug = appIdx >= 0 ? segs[appIdx + 3] : undefined;
  const isAgentBuilder = moduleSlug === "agent" && segs[appIdx + 4] === "builder";
  const agentId = isAgentBuilder ? segs[appIdx + 5] : undefined;

  const { data: agent } = useQuery({
    queryKey: ["topbar_agent", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data } = await supabase.from("rag_agents").select("name").eq("id", agentId!).maybeSingle();
      return data as { name: string } | null;
    },
  });

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-background/60 px-6 backdrop-blur">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/orgs" className="hover:text-foreground">
          {workspace?.name ?? workspaceSlug ?? "workspace"}
        </Link>
        <span>/</span>
        <Link to={`/orgs/${workspaceSlug}/projects`} className="hover:text-foreground">
          projects
        </Link>
        <span>/</span>
        {isAgentBuilder ? (
          <>
            <Link to={`/app/${workspaceSlug}/${project?.slug ?? ""}/agent/agents`} className="hover:text-foreground">
              {project?.name ?? "project"}
            </Link>
            <span>/</span>
            <Link to={`/app/${workspaceSlug}/${project?.slug ?? ""}/agent/agents`} className="hover:text-foreground">
              Agents
            </Link>
            <span>/</span>
            <span className="font-medium text-foreground">{agent?.name ?? "agent"}</span>
          </>
        ) : (
          <span className="font-medium text-foreground">{project?.name ?? "project"}</span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search or jump to… (Cmd+K)" className="h-9 w-80 pl-8" />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-9 w-9">
          <Bell className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
