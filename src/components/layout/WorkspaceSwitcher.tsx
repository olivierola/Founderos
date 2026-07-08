import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Search, Plus, Settings, Check, ChevronsUpDown } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useWorkspaces, useProjects } from "@/hooks/useWorkspace";
import { cn } from "@/lib/utils";

// Small square avatar with the entity's initial.
function Tile({ name, size = "md", selected }: { name: string; size?: "sm" | "md"; selected?: boolean }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg font-semibold",
        size === "sm" ? "h-5 w-5 rounded-[6px] text-[10px]" : "h-9 w-9 text-sm",
        selected ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
      )}
    >
      {initial}
    </span>
  );
}

function roleLabel(role: string): string {
  if (role === "owner" || role === "admin") return "Admin org";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * The workspace/project breadcrumb chips in the navbar. Clicking either chip
 * opens a two-column switcher (organisations = workspaces · espaces de travail =
 * projects) so you can jump between them directly, without leaving the page.
 */
export function WorkspaceSwitcher() {
  const { workspace, project } = useCurrentContext();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: memberships } = useWorkspaces();

  const [open, setOpen] = useState(false);
  const [selectedWsId, setSelectedWsId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const currentWsId = workspace?.id ?? null;
  const activeWsId = selectedWsId ?? currentWsId;
  const activeWs = (memberships ?? []).find((m) => m.workspace_id === activeWsId);
  const activeWsSlug = activeWs?.workspaces.slug ?? workspace?.slug ?? "";
  const { data: projects } = useProjects(activeWsId);

  // Reopen always starts on the current org, cleared search.
  useEffect(() => {
    if (open) {
      setSelectedWsId(currentWsId);
      setSearch("");
    }
  }, [open, currentWsId]);

  const q = search.trim().toLowerCase();
  const orgs = (memberships ?? []).filter((m) => !q || m.workspaces.name.toLowerCase().includes(q));
  const projs = (projects ?? []).filter((p) => !q || String(p.name).toLowerCase().includes(q));

  // Switch project: keep the same module sub-path in the new workspace/project.
  function switchToProject(wsSlug: string, projSlug: string) {
    const parts = location.pathname.split("/");
    if (parts[1] === "app" && parts.length > 3) {
      parts[2] = wsSlug;
      parts[3] = projSlug;
      navigate(parts.join("/"));
    } else {
      navigate(`/app/${wsSlug}/${projSlug}`);
    }
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="flex min-w-0 items-center gap-1">
          {/* Workspace (organisation) chip */}
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-white transition-colors hover:bg-white/5"
          >
            <Tile name={workspace?.name ?? "Workspace"} size="sm" />
            <span className="truncate text-sm font-medium">{workspace?.name ?? "Workspace"}</span>
          </button>

          {/* Project chip (with switcher affordance) */}
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-white transition-colors hover:bg-white/5"
          >
            <Tile name={project?.name ?? "Project"} size="sm" selected />
            <span className="truncate text-sm font-medium">{project?.name ?? "Project"}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-white/40" />
          </button>
        </div>
      </PopoverAnchor>

      <PopoverContent align="start" sideOffset={10} className="w-[620px] overflow-hidden p-0">
        {/* Search */}
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher"
            autoFocus
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="grid grid-cols-2">
          {/* Organisations = workspaces */}
          <div className="min-w-0 border-r border-border p-2">
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-sm font-semibold">Vos organisations</span>
              <button
                onClick={() => { navigate("/orgs"); setOpen(false); }}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" /> Ajouter
              </button>
            </div>
            <div className="max-h-80 space-y-0.5 overflow-y-auto">
              {orgs.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">Aucune organisation.</p>
              ) : (
                orgs.map((m) => {
                  const isActive = m.workspace_id === activeWsId;
                  return (
                    <button
                      key={m.workspace_id}
                      onClick={() => setSelectedWsId(m.workspace_id)}
                      className={cn(
                        "group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
                        isActive ? "bg-primary/10" : "hover:bg-accent",
                      )}
                    >
                      <Tile name={m.workspaces.name} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{m.workspaces.name}</div>
                        <span className="mt-0.5 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {roleLabel(m.role)}
                        </span>
                      </div>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); navigate("/orgs"); setOpen(false); }}
                        className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
                        aria-label="Paramètres de l'organisation"
                      >
                        <Settings className="h-4 w-4" />
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Espaces de travail = projects of the selected org */}
          <div className="min-w-0 p-2">
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-sm font-semibold">Espaces de travail</span>
              <button
                onClick={() => { if (activeWsSlug) { navigate(`/orgs/${activeWsSlug}/projects`); setOpen(false); } }}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" /> Ajouter
              </button>
            </div>
            <div className="max-h-80 space-y-0.5 overflow-y-auto">
              {projs.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">Aucun espace de travail.</p>
              ) : (
                projs.map((p) => {
                  const isCurrent = p.id === project?.id && activeWsId === currentWsId;
                  return (
                    <button
                      key={p.id}
                      onClick={() => switchToProject(activeWsSlug, p.slug)}
                      className={cn(
                        "group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
                        isCurrent ? "bg-primary/10" : "hover:bg-accent",
                      )}
                    >
                      <Tile name={p.name} selected={isCurrent} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                      {isCurrent && <Check className="h-4 w-4 shrink-0 text-primary" />}
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); navigate(`/app/${activeWsSlug}/${p.slug}/settings`); setOpen(false); }}
                        className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
                        aria-label="Paramètres de l'espace de travail"
                      >
                        <Settings className="h-4 w-4" />
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
