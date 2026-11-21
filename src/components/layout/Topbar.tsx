import {
  MagnifyingGlassIcon as Search,
  BellIcon as Bell,
  SidebarSimpleIcon as PanelLeft,
  SignOutIcon as LogOut,
  ArrowLeftIcon,
  ArrowRightIcon,
} from "@phosphor-icons/react";
import { ChatCircleDotsIcon } from "@phosphor-icons/react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Logo } from "@/components/Logo";
import { DashboardSwitcher } from "./DashboardSwitcher";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { ThemeMenu } from "@/components/ThemeMenu";
import { useAuth } from "@/lib/auth-context";
import { useShellNav } from "./AppShell";
import { useAssistant } from "@/lib/assistant-context";
import { useTopbarBreadcrumb } from "./TopbarBreadcrumb";
import { findModule } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { groundIconButton, PRIMARY_WIDTH } from "./navStyles";

// La barre du haut de l'AI Workforce, dessinée comme celle d'un tableau de
// service (DashboardNavbar) : posée sur le fond, sans bandeau, trois zones
// alignées sur ce qu'il y a dessous —
//   · à gauche, au-dessus de la barre latérale : la marque, puis le tableau ;
//   · au centre, au-dessus du contenu : l'historique, puis où l'on est ;
//   · à droite : la recherche, le thème, les alertes, l'assistant, le compte.
export function Topbar() {
  const { workspace, project } = useCurrentContext();
  const { setMobileOpen, primaryExpanded, setPrimaryExpanded } = useShellNav();
  const { user, signOut } = useAuth();
  const assistant = useAssistant();
  const location = useLocation();
  const navigate = useNavigate();
  // Extra breadcrumb segments a page can publish (e.g. the CRM record view
  // surfaces "Autonomous collaborateurs / Support Concierge" here).
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

  // React Router range sa position dans `history.state.idx` : à 0, il n'y a
  // pas de page précédente DANS l'app (même règle que DashboardNavbar).
  const histIdx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
  const leftWidth = primaryExpanded ? PRIMARY_WIDTH.expanded : PRIMARY_WIDTH.collapsed;
  const sep = <span className="shrink-0 text-[15px] font-light text-muted-foreground/50">/</span>;

  return (
    <header className="flex h-12 shrink-0 select-none items-center pr-2">
      {/* ── Gauche : la marque, puis le tableau ── */}
      <div
        className={cn(
          "group hidden h-full shrink-0 items-center transition-[width] duration-200 md:flex",
          primaryExpanded ? "gap-1.5 pl-4 pr-2" : "justify-center",
        )}
        style={{ width: leftWidth }}
      >
        {primaryExpanded ? (
          <>
            <button
              type="button"
              onClick={() => setPrimaryExpanded(false)}
              title="Réduire la barre latérale"
              aria-label="Réduire la barre latérale"
              className="relative flex h-8 w-7 shrink-0 items-center justify-center rounded-lg text-foreground"
            >
              <Logo size={18} color="currentColor" className="transition-opacity group-hover:opacity-0" />
              <PanelLeft className="absolute h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
            {sep}
            <div className="min-w-0"><DashboardSwitcher /></div>
          </>
        ) : (
          // Repliée : la marque se change en bouton de dépliage au survol.
          <button
            type="button"
            onClick={() => setPrimaryExpanded(true)}
            title="Agrandir la barre latérale"
            aria-label="Agrandir la barre latérale"
            className="relative flex h-9 w-9 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-muted/50"
          >
            <Logo size={20} color="currentColor" className="transition-opacity group-hover:opacity-0" />
            <PanelLeft className="absolute h-4 w-4 -scale-x-100 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )}
      </div>

      {/* ── Centre : l'historique, puis où l'on est ── */}
      <div className="flex h-full min-w-0 flex-1 items-center gap-1 pl-2 md:pl-0">
        {/* Mobile drawer opener */}
        <button
          type="button"
          className={cn(groundIconButton, "md:hidden")}
          onClick={() => setMobileOpen(true)}
          aria-label="Ouvrir le menu"
        >
          <PanelLeft className="h-4 w-4" />
        </button>

        <div className="hidden shrink-0 items-center sm:flex">
          <button type="button" title="Précédent" aria-label="Précédent" disabled={histIdx <= 0} onClick={() => navigate(-1)} className={groundIconButton}>
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <button type="button" title="Suivant" aria-label="Suivant" onClick={() => navigate(1)} className={groundIconButton}>
            <ArrowRightIcon className="h-4 w-4" />
          </button>
        </div>
        <span className="mx-0.5 hidden h-4 w-px shrink-0 bg-border/80 sm:block" />

        <nav className="flex min-w-0 items-center gap-1 text-[13px]">
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
                  {sep}
                  {c.to && !last ? (
                    <NavLink to={c.to} className="flex min-w-0 items-center gap-1 truncate rounded-lg px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
                      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
                      <span className="truncate">{c.label}</span>
                    </NavLink>
                  ) : (
                    <span className="flex min-w-0 items-center gap-1 truncate px-1.5 py-1 font-medium text-foreground">
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
                  {sep}
                  <NavLink
                    to={moduleTo}
                    className={cn(
                      "truncate rounded-lg px-1.5 py-1 transition-colors hover:bg-muted/50 hover:text-foreground",
                      currentSub ? "text-muted-foreground" : "font-medium text-foreground",
                    )}
                  >
                    {module.label}
                  </NavLink>
                </span>
              )}
              {module && currentSub && (
                <span className="hidden min-w-0 items-center gap-1 md:flex">
                  {sep}
                  <NavLink to={subTo} className="truncate rounded-lg px-1.5 py-1 font-medium text-foreground transition-colors hover:bg-muted/50">
                    {currentSub.label}
                  </NavLink>
                </span>
              )}
            </>
          )}
        </nav>
      </div>

      {/* ── Droite : recherche · thème · alertes · assistant · compte ── */}
      <div className="flex shrink-0 items-center gap-1">
        <div className="relative mr-1 hidden lg:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Rechercher"
            className="h-8 w-64 rounded-lg border border-border/60 bg-sidebar-accent/40 pl-8 pr-14 text-[13px] text-foreground transition-colors placeholder:text-muted-foreground/70 focus:border-primary/40 focus:outline-none"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border/60 bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            Ctrl K
          </kbd>
        </div>
        <button type="button" className={cn(groundIconButton, "lg:hidden")} aria-label="Rechercher">
          <Search className="h-4 w-4" />
        </button>

        {/* One control: the list already carries Light and Dark, so a
            separate toggle was a second door to the same room. */}
        <ThemeMenu className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground" />
        <button type="button" className={groundIconButton} aria-label="Notifications" title="Notifications">
          <Bell className="h-4 w-4" />
        </button>

        {/* Global AI assistant — opens a right-side panel with the current page as context. */}
        <button
          type="button"
          className={cn(
            groundIconButton,
            assistant.open && "bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary",
          )}
          onClick={assistant.toggle}
          title="Assistant IA"
          aria-label="Assistant IA"
        >
          <ChatCircleDotsIcon weight="duotone" className="h-[18px] w-[18px]" />
        </button>

        {/* Account menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="ml-1 flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-primary text-[11px] font-semibold text-primary-foreground ring-1 ring-border/60 transition-transform hover:scale-105"
              aria-label="Compte"
              title={userLabel}
            >
              {avatarUrl ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" /> : userInitial}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 rounded-xl">
            <DropdownMenuLabel className="truncate">{userLabel}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => signOut()}>
              <LogOut className="mr-2 h-4 w-4" /> Se déconnecter
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
