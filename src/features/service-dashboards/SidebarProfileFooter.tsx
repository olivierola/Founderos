import { useNavigate, useParams } from "react-router-dom";
import { ChevronsUpDown, Settings, Plug, Users, LogOut, Check, ShieldCheck, Palette } from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuPortal,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useWorkspaces } from "@/hooks/useWorkspace";
import { useTheme } from "@/lib/theme-context";
import { cn } from "@/lib/utils";
import { THEMES } from "@/lib/themes";

function Avatar({ name, url, size, rounded = "rounded-full" }: { name: string; url?: string; size: number; rounded?: string }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center overflow-hidden bg-gradient-to-br from-primary/80 to-primary font-semibold text-white", rounded)}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : initial}
    </span>
  );
}

function Tile({ name }: { name: string }) {
  return (
    <span className="mr-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-[10px] font-semibold text-primary">
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/**
 * Profile + org switcher, pinned to the foot of a per-service sidebar
 * (ServiceDashboardShell has no top navbar, so account access lives here).
 * `compact` renders just the avatar tile — the icon rail's bottom slot.
 */
export function SidebarProfileFooter({ compact }: { compact?: boolean } = {}) {
  const { user, signOut } = useAuth();
  const { workspace, workspaceId, project } = useCurrentContext();
  const { data: memberships } = useWorkspaces();
  const { theme: appTheme, setTheme } = useTheme();
  const navigate = useNavigate();
  // The footer only renders inside a service dashboard, so the id is in the URL.
  const { dashboardId } = useParams();

  const name = (user?.user_metadata?.name as string | undefined) ?? user?.email ?? "Compte";
  const email = user?.email ?? "";
  const avatarUrl = user?.user_metadata?.avatar_url as string | undefined;
  const base = workspace && project ? `/app/${workspace.slug}/${project.slug}` : "/orgs";

  return (
    <div className={cn(compact ? "p-0" : "border-t border-border/60 p-2")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {compact ? (
            // Rail slot: the avatar alone, with the "online" dot from the mockup.
            <button className="relative rounded-xl p-0.5 transition-colors hover:bg-sidebar-accent/60" title={name}>
              <Avatar name={name} url={avatarUrl} size={32} rounded="rounded-lg" />
              <span className="absolute -bottom-0 -right-0 h-2.5 w-2.5 rounded-full border-2 border-sidebar bg-emerald-500" />
            </button>
          ) : (
            <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/60">
              <Avatar name={name} url={avatarUrl} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{name}</span>
                <span className="block truncate text-xs text-muted-foreground">{workspace?.name ?? "Organisation"}</span>
              </span>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" side={compact ? "right" : "top"} sideOffset={8} className="w-64 rounded-2xl p-1.5">
          <div className="flex items-center gap-3 px-2 py-2">
            <Avatar name={name} url={avatarUrl} size={36} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{name}</div>
              <div className="truncate text-xs text-muted-foreground">{email}</div>
            </div>
          </div>
          <DropdownMenuSeparator />

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="rounded-xl">
              <Tile name={workspace?.name ?? "?"} />
              <span className="min-w-0 flex-1 truncate">{workspace?.name ?? "Organisation"}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="w-56 rounded-2xl p-1.5">
                {(memberships ?? []).map((m) => (
                  <DropdownMenuItem
                    key={m.workspace_id}
                    className={cn("rounded-xl", m.workspace_id === workspaceId && "bg-accent")}
                    onSelect={() => navigate(`/orgs/${m.workspaces.slug}/projects`)}
                  >
                    <Tile name={m.workspaces.name} />
                    <span className="min-w-0 flex-1 truncate">{m.workspaces.name}</span>
                    {m.workspace_id === workspaceId && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="rounded-xl" onSelect={() => navigate("/orgs")}>
                  Toutes les organisations
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          {/* Settings = THIS service's own panel. The org-wide surfaces below are
              labelled as such so nothing silently bounces you to the Admin area. */}
          {dashboardId && (
            <DropdownMenuItem className="rounded-xl" onSelect={() => navigate(`${base}/service/${dashboardId}/settings`)}>
              <Settings className="mr-2 h-4 w-4" /> Paramètres du service
            </DropdownMenuItem>
          )}
          {/* One theme, one place. It repaints every dashboard at once, so
              there is nothing service-specific to choose here any more. */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="rounded-xl">
              <Palette className="mr-2 h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">Thème</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="w-52 rounded-2xl p-1.5">
                {THEMES.map((t) => (
                  <DropdownMenuItem key={t.key} className="rounded-xl" onSelect={() => setTheme(t.key)}>
                    <span className="mr-2 h-4 w-4 shrink-0 rounded-full border border-border" style={{ background: t.swatch }} />
                    <span className="min-w-0 flex-1 truncate">{t.label}</span>
                    {appTheme === t.key && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="px-2 text-[10px] uppercase tracking-wide text-muted-foreground">Organisation</DropdownMenuLabel>
          {/* Connections belong to THIS dashboard now (0177) — its own tab,
              not an org-wide page. */}
          <DropdownMenuItem className="rounded-xl" onSelect={() => navigate(`${base}/service/${dashboardId}/connectors`)}>
            <Plug className="mr-2 h-4 w-4" /> Connecteurs
          </DropdownMenuItem>
          <DropdownMenuItem className="rounded-xl" onSelect={() => navigate(`${base}/admin/members`)}>
            <Users className="mr-2 h-4 w-4" /> Membres
          </DropdownMenuItem>
          <DropdownMenuItem className="rounded-xl" onSelect={() => navigate(`${base}/admin/organisation`)}>
            <ShieldCheck className="mr-2 h-4 w-4" /> Administration
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuItem className="rounded-xl text-destructive focus:text-destructive" onSelect={() => signOut()}>
            <LogOut className="mr-2 h-4 w-4" /> Se déconnecter
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
