import { Link, useParams, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search, Bell, Sun, Moon, Menu, Bot } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useTheme } from "@/lib/theme-context";
import { useShellNav } from "./AppShell";
import { useAssistant } from "@/lib/assistant-context";
import { cn } from "@/lib/utils";

export function Topbar() {
  const { workspaceSlug } = useParams();
  const { workspace, project } = useCurrentContext();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const { setMobileOpen } = useShellNav();
  const assistant = useAssistant();

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
    <header className="flex h-14 items-center justify-between border-b border-border bg-background/60 px-4 backdrop-blur sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 md:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="h-4 w-4" />
        </Button>
        <div className="flex min-w-0 items-center gap-2 truncate text-sm text-muted-foreground">
          <Link to="/orgs" className="hidden truncate hover:text-foreground sm:inline">
            {workspace?.name ?? workspaceSlug ?? "workspace"}
          </Link>
          <span className="hidden sm:inline">/</span>
          <Link to={`/orgs/${workspaceSlug}/projects`} className="hidden hover:text-foreground sm:inline">
            projects
          </Link>
          <span className="hidden sm:inline">/</span>
          {isAgentBuilder ? (
            <>
              <Link to={`/app/${workspaceSlug}/${project?.slug ?? ""}/agent/agents`} className="hidden hover:text-foreground md:inline">
                {project?.name ?? "project"}
              </Link>
              <span className="hidden md:inline">/</span>
              <Link to={`/app/${workspaceSlug}/${project?.slug ?? ""}/agent/agents`} className="hidden hover:text-foreground md:inline">
                Agents
              </Link>
              <span className="hidden md:inline">/</span>
              <span className="truncate font-medium text-foreground">{agent?.name ?? "agent"}</span>
            </>
          ) : (
            <span className="truncate font-medium text-foreground">{project?.name ?? "project"}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 sm:gap-3">
        <div className="relative hidden lg:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search or jump to… (Cmd+K)" className="h-9 w-80 pl-8" />
        </div>
        <Button variant="ghost" size="icon" className="h-9 w-9 lg:hidden" aria-label="Search">
          <Search className="h-4 w-4" />
        </Button>
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
        {/* Global AI assistant — opens a right-side panel with the current page as context. */}
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-9 w-9", assistant.open ? "bg-primary/15 text-primary" : "text-primary hover:bg-primary/10 hover:text-primary")}
          onClick={assistant.toggle}
          title="AI Assistant"
          aria-label="AI Assistant"
        >
          <Bot className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
