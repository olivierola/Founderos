import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ArrowUpRightIcon as ArrowUpRight,
  CaretDownIcon as CaretDown,
  ListIcon as Menu,
  XIcon as X,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { SOLUTIONS } from "../solutions";
import { BrandLockup, Btn } from "./AtlasKit";

/* ── The bar ────────────────────────────────────────────────────────────────
   A white pill floating 10px under the top of the viewport, centred, carrying
   the lockup, the links and the three ways in. It never changes colour: every
   page opens on a panel with a white margin around it, so a white bar always
   has something to sit on. The shadow only deepens once the page has moved. */

const LINKS = [
  { label: "Solutions", to: "/solutions", menu: true },
  { label: "Pricing", to: "/pricing" },
  { label: "Integrations", to: "/integrations" },
  { label: "Blog", to: "/blog" },
  { label: "FAQ", to: "/faq" },
];

/** Height of the bar plus its top offset — every hero starts below it. */
export const ATLAS_NAV_H = 72;

export function AtlasNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close everything on navigation.
  useEffect(() => {
    setOpen(false);
    setMenu(false);
  }, [pathname]);

  const isCurrent = (to: string) => {
    const root = "/" + to.split("/")[1];
    return pathname === root || pathname.startsWith(root + "/");
  };

  return (
    <>
      <header className="pointer-events-none fixed inset-x-0 top-2.5 z-50 flex justify-center px-2.5">
        <div
          className={cn(
            "pointer-events-auto flex h-[52px] w-full max-w-[1000px] items-center gap-2 rounded-full bg-white/95 py-1 pl-3 pr-1 backdrop-blur-xl transition-shadow duration-500",
            scrolled
              ? "shadow-[0_18px_50px_-20px_rgba(17,16,17,0.45)]"
              : "shadow-[0_12px_40px_-24px_rgba(17,16,17,0.35)]",
          )}
        >
          <Link to="/" className="mr-3 shrink-0" aria-label="Anduran — home">
            <BrandLockup />
          </Link>

          <nav className="hidden items-center gap-5 lg:flex">
            {LINKS.map((l) =>
              l.menu ? (
                <div
                  key={l.label}
                  className="relative"
                  onMouseEnter={() => setMenu(true)}
                  onMouseLeave={() => setMenu(false)}
                >
                  <Link
                    to={l.to}
                    aria-current={isCurrent(l.to) ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-1 py-2 text-[13.5px] transition-colors",
                      isCurrent(l.to) ? "font-semibold text-[#111011]" : "text-[#111011]/80 hover:text-[#111011]",
                    )}
                  >
                    {l.label}
                    <CaretDown className={cn("h-3 w-3 opacity-60 transition-transform", menu && "rotate-180")} />
                  </Link>
                  {menu && (
                    <div className="absolute left-1/2 top-full w-[620px] -translate-x-1/2 pt-4">
                      <div className="overflow-hidden rounded-[26px] border border-[#f0f0f0] bg-white p-2 shadow-[0_40px_80px_-40px_rgba(17,16,17,0.5)]">
                        <div className="grid grid-cols-2 gap-1">
                          {SOLUTIONS.map((s) => {
                            const to = `/solutions/${s.slug}`;
                            const here = pathname === to;
                            return (
                              <Link
                                key={s.slug}
                                to={to}
                                onClick={() => setMenu(false)}
                                aria-current={here ? "page" : undefined}
                                className={cn(
                                  "flex gap-3 rounded-[18px] p-3.5 transition-colors",
                                  here ? "bg-[#f7ecfc]" : "hover:bg-[#f7f7f7]",
                                )}
                              >
                                <span className="at-orb mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white tabular-nums">
                                  {s.num}
                                </span>
                                <span className="min-w-0">
                                  <span className="block text-[13.5px] font-semibold tracking-[-0.01em] text-[#111011]">
                                    {s.menu.label}
                                  </span>
                                  <span className="mt-1 block text-[12.5px] leading-snug text-[#666666]">
                                    {s.menu.blurb}
                                  </span>
                                </span>
                              </Link>
                            );
                          })}
                        </div>
                        <Link
                          to="/solutions"
                          onClick={() => setMenu(false)}
                          className="group mt-1 flex items-center justify-between rounded-[18px] bg-[#f7f7f7] px-4 py-3 text-[13px] font-medium text-[#111011] transition-colors hover:bg-[#f0f0f0]"
                        >
                          <span>
                            All six solutions, <span className="at-grad-text">in the order they happen</span>
                          </span>
                          <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <Link
                  key={l.label}
                  to={l.to}
                  aria-current={isCurrent(l.to) ? "page" : undefined}
                  className={cn(
                    "py-2 text-[13.5px] transition-colors",
                    isCurrent(l.to) ? "font-semibold text-[#111011]" : "text-[#111011]/80 hover:text-[#111011]",
                  )}
                >
                  {l.label}
                </Link>
              ),
            )}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Btn to="/contact" variant="light" size="md" className="hidden h-[44px] px-5 text-[14.5px] shadow-none sm:inline-flex">
              Talk to us
            </Btn>
            <Btn to="/signup" variant="dark" size="md" className="hidden h-[44px] px-5 text-[14.5px] md:inline-flex">
              Get started
            </Btn>
            <Btn to="/login" variant="dark" size="md" className="h-[44px] px-5 text-[14.5px]">
              Sign in
            </Btn>
            <button
              className="grid h-[44px] w-[44px] place-items-center rounded-full text-[#111011] transition-colors hover:bg-[#f5f5f5] lg:hidden"
              onClick={() => setOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      {open && (
        <div className="fixed inset-0 z-[60] overflow-y-auto bg-white px-5 pb-8 pt-5 text-[#111011] lg:hidden">
          <div className="flex items-center justify-between">
            <BrandLockup />
            <button
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="grid h-11 w-11 place-items-center rounded-full bg-[#f5f5f5]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <nav className="mt-8 flex flex-col">
            {LINKS.map((l) => (
              <Link
                key={l.label}
                to={l.to}
                onClick={() => setOpen(false)}
                aria-current={isCurrent(l.to) ? "page" : undefined}
                className="border-b border-[#f0f0f0] py-4 text-[20px] font-semibold tracking-[-0.03em]"
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="mt-8">
            <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#969696]">Solutions</div>
            <div className="mt-3 flex flex-col gap-1">
              {SOLUTIONS.map((s) => (
                <Link
                  key={s.slug}
                  to={`/solutions/${s.slug}`}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 rounded-2xl px-2 py-2.5 text-[15px] hover:bg-[#f7f7f7]"
                >
                  <span className="at-orb grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white">
                    {s.num}
                  </span>
                  {s.menu.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="mt-8 flex flex-col gap-2.5">
            <Btn to="/signup" variant="dark" size="lg" onClick={() => setOpen(false)}>
              Get started
            </Btn>
            <Btn to="/contact" variant="light" size="lg" onClick={() => setOpen(false)}>
              Talk to us
            </Btn>
          </div>
        </div>
      )}
    </>
  );
}
