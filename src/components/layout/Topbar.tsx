import { Link, useParams } from "react-router-dom";
import { Search, Bell } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useCurrentContext } from "@/hooks/useCurrentContext";

export function Topbar() {
  const { workspaceSlug } = useParams();
  const { workspace, project } = useCurrentContext();
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
        <span className="font-medium text-foreground">{project?.name ?? "project"}</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search or jump to… (Cmd+K)" className="h-9 w-80 pl-8" />
        </div>
        <Button variant="ghost" size="icon" className="h-9 w-9">
          <Bell className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
