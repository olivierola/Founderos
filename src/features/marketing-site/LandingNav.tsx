import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowUpRight, ChevronDown, Menu, X } from "lucide-react";
import { Logo } from "@/components/Logo";
import { BRAND_FONT } from "./LandingKit";
import { HERO_BG } from "./LandingHero";
import { SOLUTIONS } from "./solutions";

/* The tab is one flat ink so the shoulders match it exactly; the depth comes
   from the inset highlights, not from a gradient. */
const NOTCH_BG = "#232326";
const SHOULDER = 14;

/* A square of tab ink with the page colour laid over it, rounded on the corner
   that faces the tab — what shows through is a concave fillet running from the
   top edge into the tab's side. */
function NotchShoulder({ side }: { side: "left" | "right" }) {
  return (
    <span
      aria-hidden
      className="block shrink-0"
      style={{ width: SHOULDER, height: SHOULDER, background: NOTCH_BG }}
    >
      <span
        className="block h-full w-full"
        style={{
          background: HERO_BG,
          borderTopRightRadius: side === "left" ? SHOULDER : 0,
          borderTopLeftRadius: side === "right" ? SHOULDER : 0,
        }}
      />
    </span>
  );
}

const NAV = [
  { label: "Solutions", to: "/solutions", menu: true },
  { label: "Pricing", to: "/pricing" },
  { label: "Blog", to: "/blog" },
  { label: "FAQ", to: "/faq" },
];

/* Each entry goes to its own page under /solutions/:slug. They used to be
   anchors on one long page, which meant six distinct promises in this menu all
   landed on the same scroll.

   The set comes from solutions.ts rather than being written out again here, so
   the menu keeps the 01–06 order the pages themselves number, and a label can
   no longer disagree with the page it opens. */
const MENU = SOLUTIONS.map((s) => ({
  ...s.menu,
  hue: s.key,
  to: `/solutions/${s.slug}`,
}));

// Flat top bar over the black canvas — wordmark left, links centred, a single
// bordered CTA right. It only gains a background once the page scrolls.
export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // An article is still "Blog", so the match is on the section, not the path.
  const isCurrent = (to: string) => {
    const root = "/" + to.split("#")[0].split("/")[1];
    return pathname === root || pathname.startsWith(root + "/");
  };

  return (
    <>
      <header
        className={`fixed inset-x-0 top-0 z-50 transition-[padding] duration-500 ${scrolled ? "px-3" : ""}`}
      >
        {/* The notch: a dark tab stamped into the top edge of the page. The two
            shoulders are what sell it — the light canvas curves into the tab
            instead of meeting it at a hard 90°. It retracts on scroll so the
            bar collapses back to its 74px row. */}
        <div
          className={`absolute left-1/2 top-0 flex -translate-x-1/2 items-start transition-all duration-500 ${
            scrolled ? "pointer-events-none -translate-y-full opacity-0" : "opacity-100"
          }`}
        >
          <NotchShoulder side="left" />
          <Link
            to="/contact"
            className="group relative flex items-center gap-2.5 overflow-hidden rounded-b-[16px] px-5 pb-2.5 pt-2 text-[12.5px] font-medium tracking-[0.005em] text-white/85 transition-colors hover:text-white"
            style={{
              background: NOTCH_BG,
              // Bottom highlight only — a side inset would seam against the
              // shoulders, which butt straight onto the tab's edges.
              boxShadow: "0 12px 26px -14px rgba(0,0,7,0.65), inset 0 -1px 0 rgba(255,255,255,0.09)",
            }}
          >
            <span className="relative flex h-[7px] w-[7px] shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#4ade80] opacity-70 motion-reduce:animate-none" />
              <span
                className="relative inline-flex h-[7px] w-[7px] rounded-full bg-[#4ade80]"
                style={{ boxShadow: "0 0 8px rgba(74,222,128,0.75)" }}
              />
            </span>
            Available for new engagements
            {/* The arrow only takes its width on hover, so the tab keeps its
                resting size and the label never shifts. */}
            <ArrowUpRight className="h-3.5 w-0 shrink-0 opacity-0 transition-all duration-300 group-hover:w-3.5 group-hover:opacity-100" />
          </Link>
          <NotchShoulder side="right" />
        </div>

        {/* At rest the bar is a flat row across the page; on scroll it detaches
            into a floating island — narrower, rounded, blurred, lifted. */}
        <div
          className={`relative mx-auto flex w-full items-center justify-between border transition-all duration-500 ${
            scrolled
              ? "mt-3 h-[62px] max-w-[1060px] rounded-full border-black/[0.07] bg-white/80 pl-6 pr-3 shadow-[0_14px_34px_-14px_rgba(0,0,7,0.30)] backdrop-blur-xl"
              : "mt-[30px] h-[74px] max-w-[1440px] border-transparent px-6 sm:px-10"
          }`}
        >
          <Link to="/" className="flex shrink-0 items-center gap-2.5">
            <Logo size={26} />
            {/* Fascinate is a wide display cut, so it runs a touch smaller than
                the sans it replaces and keeps a normal line box. */}
            <span className="text-[19px] leading-tight text-black/65" style={{ fontFamily: BRAND_FONT }}>
              Anduran
            </span>
          </Link>

          <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-8 md:flex">
            {NAV.map((l) =>
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
                    className={`flex items-center gap-1.5 py-2 text-[15px] transition-colors hover:text-black ${
                      isCurrent(l.to) ? "font-medium text-black" : "text-black/75"
                    }`}
                  >
                    {l.label}
                    <ChevronDown className={`h-4 w-4 transition-transform ${menu ? "rotate-180" : ""}`} />
                  </Link>
                  {menu && (
                    <div className="absolute left-1/2 top-full w-[540px] -translate-x-1/2 pt-3">
                      <div className="grid grid-cols-2 gap-1 rounded-2xl border border-black/10 bg-white p-2 shadow-xl">
                        {MENU.map((s) => {
                          const here = pathname === s.to;
                          return (
                            <Link
                              key={s.to}
                              to={s.to}
                              aria-current={here ? "page" : undefined}
                              /* Closed on click as well as on mouseleave: a
                                 same-nav navigation scrolls the page under a
                                 pointer that never leaves the panel, so the
                                 hover state alone would keep it open. */
                              onClick={() => setMenu(false)}
                              className={`rounded-xl p-3 transition-colors ${
                                here ? "bg-black/[0.05]" : "hover:bg-black/[0.04]"
                              }`}
                            >
                              <div className="flex items-center gap-2.5">
                                {/* Same hue dot the pages use for each other, so
                                    a solution keeps one colour everywhere. */}
                                <span
                                  aria-hidden
                                  className="h-[7px] w-[7px] shrink-0 rounded-full"
                                  style={{ background: s.hue }}
                                />
                                <span className="text-[13px] font-medium text-black">{s.label}</span>
                              </div>
                              <div className="mt-0.5 pl-[17px] text-[11.5px] leading-snug text-black/50">
                                {s.blurb}
                              </div>
                            </Link>
                          );
                        })}
                        {/* The parent label already goes to the index, but a
                            hovered label does not look clickable, so the panel
                            carries the way in explicitly. */}
                        <Link
                          to="/solutions"
                          onClick={() => setMenu(false)}
                          className="col-span-2 mt-1 flex items-center justify-between gap-2 border-t border-black/[0.07] px-3 pb-1 pt-3 text-[12.5px] text-black/55 transition-colors hover:text-black"
                        >
                          All six, and the order they happen in
                          <ArrowUpRight className="h-3.5 w-3.5" />
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
                  className={`py-2 text-[15px] transition-colors hover:text-black ${
                    isCurrent(l.to) ? "font-medium text-black" : "text-black/75"
                  }`}
                >
                  {l.label}
                </Link>
              ),
            )}
          </nav>

          <div className="hidden shrink-0 items-center gap-3 md:flex">
            <Link to="/login" className="text-[14px] text-black/55 transition-colors hover:text-black">
              Sign in
            </Link>
            <Link
              to="/contact"
              className="rounded-full bg-[#2b2b2b] px-6 py-3 text-[14.5px] font-medium text-white transition-colors hover:bg-[#0d0d0d]"
            >
              Contact Us
            </Link>
          </div>

          <button className="p-2 text-black md:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </header>

      {open && (
        /* The drawer is always the dark panel, whatever the page under it is —
            so its rules and inks are written literally rather than read from the
            amp tokens, which flip to their light values on the interior pages. */
        <div className="fixed inset-0 z-[60] overflow-y-auto bg-[#000007] p-6 text-white md:hidden">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2.5">
              <Logo size={24} />
              <span className="text-[17px] leading-tight" style={{ fontFamily: BRAND_FONT }}>
                Anduran
              </span>
            </span>
            <button onClick={() => setOpen(false)} aria-label="Close menu" className="p-2">
              <X className="h-5 w-5" />
            </button>
          </div>
          <nav className="mt-10 flex flex-col">
            {NAV.map((l) => (
              <Link
                key={l.label}
                to={l.to}
                onClick={() => setOpen(false)}
                aria-current={isCurrent(l.to) ? "page" : undefined}
                className={`border-b border-white/10 py-4 text-lg ${
                  isCurrent(l.to) ? "text-white" : "text-white/70"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>

          {/* The solutions sit one level down rather than behind a nested
              accordion — six links is shorter than the gesture to reveal them. */}
          <div className="mt-8">
            <div className="text-[11px] uppercase tracking-[0.14em] text-white/35">Solutions</div>
            <div className="mt-4 flex flex-col">
              {MENU.map((s) => (
                <Link
                  key={s.to}
                  to={s.to}
                  onClick={() => setOpen(false)}
                  aria-current={pathname === s.to ? "page" : undefined}
                  className={`flex items-center gap-3 border-b border-white/[0.06] py-3 text-[15px] ${
                    pathname === s.to ? "text-white" : "text-white/60"
                  }`}
                >
                  <span
                    aria-hidden
                    className="h-[7px] w-[7px] shrink-0 rounded-full"
                    style={{ background: s.hue }}
                  />
                  {s.label}
                </Link>
              ))}
            </div>
          </div>

          <div className="mt-8 flex flex-col gap-3 pb-6">
            <Link
              to="/contact"
              onClick={() => setOpen(false)}
              className="rounded-xl px-6 py-3.5 text-center text-[15px] font-medium"
              style={{ background: "#ff4d00", color: "#fff" }}
            >
              Book a Consultation
            </Link>
            <Link
              to="/login"
              onClick={() => setOpen(false)}
              className="rounded-xl border border-white/[0.12] bg-white/[0.04] px-6 py-3.5 text-center text-[15px]"
            >
              Sign in
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
