import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Menu, X, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";
import { MarketingFooter } from "./MarketingFooter";

const NAV_LINKS = [
  { to: "/features", label: "Features" },
  { to: "/integrations", label: "Integrations" },
  { to: "/pricing", label: "Pricing" },
  { to: "/changelog", label: "Changelog" },
  { to: "/docs", label: "Docs" },
];

export function MarketingShell({ children, hideHeader = false }: { children: ReactNode; hideHeader?: boolean }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname } = useLocation();

  // Hide the window scrollbar for the whole marketing/landing site; restore it
  // when navigating back into the app (dashboard) where the scrollbar is useful.
  useEffect(() => {
    document.documentElement.classList.add("mkt-no-scrollbar");
    return () => document.documentElement.classList.remove("mkt-no-scrollbar");
  }, []);

  return (
    <div className="dark marketing min-h-screen bg-background text-foreground">
      {/* Top nav — hidden when the page provides its own (e.g. the video hero). */}
      {!hideHeader && (
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2">
            <Logo size={28} />
            <span className="text-sm font-semibold tracking-tight">AchiCorp</span>
            <span className="hidden text-[10px] uppercase text-muted-foreground sm:inline">for agencies</span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {NAV_LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    isActive
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>

          <div className="hidden items-center gap-2 md:flex">
            <Link
              to="/login"
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              Sign in
            </Link>
            <Link
              to="/signup"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Start free <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <button
            type="button"
            className="md:hidden"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {mobileOpen && (
          <div className="border-t border-border/60 bg-background md:hidden">
            <div className="space-y-1 px-4 py-3">
              {NAV_LINKS.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      "block rounded-md px-3 py-2 text-sm",
                      isActive
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:bg-secondary",
                    )
                  }
                >
                  {l.label}
                </NavLink>
              ))}
              <Link
                to="/login"
                className="block rounded-md px-3 py-2 text-sm text-muted-foreground"
                onClick={() => setMobileOpen(false)}
              >
                Sign in
              </Link>
              <Link
                to="/signup"
                className="block rounded-md bg-primary px-3 py-2 text-center text-sm font-medium text-primary-foreground"
                onClick={() => setMobileOpen(false)}
              >
                Start free
              </Link>
            </div>
          </div>
        )}
      </header>
      )}

      <main key={pathname}>{children}</main>

      {/* Footer */}
      <MarketingFooter />
    </div>
  );
}

/* Reusable dotted-grid hero background (Linear/Vercel style). */
export function DotGrid({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 [background-image:radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:18px_18px] [mask-image:radial-gradient(ellipse_at_top,rgba(0,0,0,0.6),transparent_70%)]",
        className,
      )}
    />
  );
}
