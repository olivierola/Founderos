import { Search, Bell, Sun, Moon, PanelLeft, PanelLeftOpen, LogOut } from "lucide-react";
import { ChatCircleDotsIcon } from "@phosphor-icons/react";
import { NavLink, useLocation } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Logo } from "@/components/Logo";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useTheme } from "@/lib/theme-context";
import { useAuth } from "@/lib/auth-context";
import { useShellNav } from "./AppShell";
import { useAssistant } from "@/lib/assistant-context";
import { useTopbarBreadcrumb } from "./TopbarBreadcrumb";
import { findModule } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export function Topbar() {
  const { workspace, project } = useCurrentContext();
  const { theme, toggleTheme } = useTheme();
  const { setMobileOpen, primaryExpanded, setPrimaryExpanded } = useShellNav();
  const { user, signOut } = useAuth();
  const assistant = useAssistant();
  const location = useLocation();
  // Extra breadcrumb segments a page can publish (e.g. the CRM record view
  // surfaces "Autonomous agents / Support Concierge" here).
  const crumbs = useTopbarBreadcrumb();

  const segments = location.pathname.split("/").filter(Boolean);
  const appIdx = segments.indexOf("app");
  const moduleSlug = appIdx >= 0 ? segments[appIdx + 3] : undefined;
  const module = moduleSlug ? findModule(moduleSlug) : null;
  const subSlug = appIdx >= 0 ? segments[appIdx + 4] : undefined;
  const currentSub = module?.subItems.find((item) => item.slug === subSlug);

  const wsSlug = workspace?.slug ?? "";
  const projSlug = project?.slug ?? "";
  const moduleTo = module ? `/app/${wsSlug}/${projSlug}/${module.slug}` : "/orgs";
  const subTo = module && currentSub ? `${moduleTo}/${currentSub.slug}` : moduleTo;

  const userLabel = (user?.user_metadata?.name as string | undefined) ?? user?.email ?? "Compte";
  const userInitial = userLabel.trim()[0]?.toUpperCase() ?? "?";
  const avatarUrl = user?.user_metadata?.avatar_url as string | undefined;

  return (
    <header className="flex flex-col bg-[#101013]">
      <div className="flex items-stretch">
        {/* Left segment — matches the primary sidebar width so the sidebar's
            column visually continues up into the navbar, and widens with it. */}
        <div
          className={cn(
            "group flex shrink-0 items-center border-r border-white/10 transition-[width] duration-200",
            primaryExpanded ? "w-64 justify-between px-3" : "w-16 justify-center px-2",
          )}
        >
          {primaryExpanded ? (
            <>
              <Logo size={28} />
              {/* Collapse — revealed on hover over the logo area. */}
              <Button
                variant="ghost"
                size="icon"
                className="hidden h-8 w-8 text-white/60 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100 md:inline-flex"
                onClick={() => setPrimaryExpanded(false)}
                aria-label="Réduire la barre latérale"
                title="Réduire la barre latérale"
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
            </>
          ) : (
            // Collapsed: the logo morphs into the expand toggle on hover.
            <div className="relative flex h-8 w-8 items-center justify-center">
              <Logo size={28} className="transition-opacity group-hover:opacity-0" />
              <button
                onClick={() => setPrimaryExpanded(true)}
                className="absolute inset-0 flex items-center justify-center rounded-md text-white/70 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100"
                aria-label="Agrandir la barre latérale"
                title="Agrandir la barre latérale"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        {/* Right — breadcrumb + search + actions */}
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3 py-2.5 pl-3 pr-3 sm:pr-4">
          <div className="flex min-w-0 items-center gap-1.5">
            {/* Mobile drawer opener */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-white/60 hover:bg-white/10 hover:text-white md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Ouvrir le menu"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>

            <nav className="flex min-w-0 items-center gap-1 text-sm">
              {/* Workspace/project chips — click to open the two-column switcher. */}
              <WorkspaceSwitcher />

              {/* Depth: either the page-published crumbs (CRM record, …) or the
                  module / sub-tab derived from the route. */}
              {crumbs && crumbs.length > 0 ? (
                crumbs.map((c, i) => {
                  const Icon = c.icon;
                  const last = i === crumbs.length - 1;
                  return (
                    <span key={`${c.label}-${i}`} className="hidden min-w-0 items-center gap-1 sm:flex">
                      <span className="text-white/30">/</span>
                      {c.to && !last ? (
                        <NavLink to={c.to} className="flex min-w-0 items-center gap-1 truncate text-sm text-white/70 transition-colors hover:text-white">
                          {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
                          <span className="truncate">{c.label}</span>
                        </NavLink>
                      ) : (
                        <span className="flex min-w-0 items-center gap-1 truncate text-sm font-medium text-white">
                          {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
                          <span className="truncate">{c.label}</span>
                        </span>
                      )}
                    </span>
                  );
                })
              ) : (
                <>
                  {module && (
                    <span className="hidden min-w-0 items-center gap-1 sm:flex">
                      <span className="text-white/30">/</span>
                      <NavLink to={moduleTo} className="truncate text-sm text-white/70 transition-colors hover:text-white">
                        {module.label}
                      </NavLink>
                    </span>
                  )}
                  {module && currentSub && (
                    <span className="hidden min-w-0 items-center gap-1 md:flex">
                      <span className="text-white/30">/</span>
                      <NavLink to={subTo} className="truncate text-sm text-white/70 transition-colors hover:text-white">
                        {currentSub.label}
                      </NavLink>
                    </span>
                  )}
                </>
              )}
            </nav>
          </div>

          {/* Right cluster: search · theme · alerts · assistant · account */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            <div className="relative hidden lg:block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/50" />
              <Input
                placeholder="Rechercher"
                className="h-9 w-72 rounded-full border border-white/10 bg-white/5 pl-10 pr-16 text-sm text-white placeholder:text-white/40 focus-visible:border-white/20 focus-visible:ring-white/10"
              />
              <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-white/50">
                Ctrl K
              </kbd>
            </div>
            <Button variant="ghost" size="icon" className="h-9 w-9 text-white/80 hover:bg-white/10 hover:text-white lg:hidden" aria-label="Rechercher">
              <Search className="h-4 w-4" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-white/80 hover:bg-white/10 hover:text-white"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Passer en mode clair" : "Passer en mode sombre"}
              title={theme === "dark" ? "Passer en mode clair" : "Passer en mode sombre"}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 text-white/80 hover:bg-white/10 hover:text-white" aria-label="Notifications">
              <Bell className="h-4 w-4" />
            </Button>

            {/* Global AI assistant — opens a right-side panel with the current page as context. */}
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "h-9 w-9 rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white",
                assistant.open && "bg-primary/20 text-primary hover:text-primary",
              )}
              onClick={assistant.toggle}
              title="Assistant IA"
              aria-label="Assistant IA"
            >
              <ChatCircleDotsIcon weight="duotone" className="h-[18px] w-[18px]" />
            </Button>

            {/* Account menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-primary/80 to-primary text-xs font-semibold text-white ring-1 ring-white/15 transition-transform hover:scale-105"
                  aria-label="Compte"
                  title={userLabel}
                >
                  {avatarUrl ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" /> : userInitial}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="truncate">{userLabel}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => signOut()}>
                  <LogOut className="mr-2 h-4 w-4" /> Se déconnecter
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </header>
  );
}
