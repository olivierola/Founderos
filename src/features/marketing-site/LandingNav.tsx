import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ArrowRightIcon as ArrowRight,
  ArrowUpRightIcon as ArrowUpRight,
  CaretDownIcon as ChevronDown,
  ListIcon as Menu,
  XIcon as X,
} from "@phosphor-icons/react";
import { BRAND_MARK, BRAND_MARK_BRIGHT, Logo } from "@/components/Logo";
import { BRAND_FONT } from "./LandingKit";
import { SOLUTIONS } from "./solutions";
import { TONES, TONE_IS_DARK, useCurrentTone } from "./LandingTone";

/* ── The bar ────────────────────────────────────────────────────────────────
   A full-width rule across the top of the page, fixed, edge to edge. It
   replaced a floating dark pill: the pill belonged to a page that was dark from
   the nav to the footer, and on a site that now opens on paper it read as a
   black slab dropped onto a white sheet.

   It paints the tone the canvas is currently on and flips its ink with it (see
   LandingTone). That is what lets it be a solid bar rather than a floating
   object: matched to the ground and eased on the canvas' own 900ms clock, it
   never announces itself as a separate surface, and it never has to survive
   white type over a white section. On the interior pages, which mount no
   canvas, the store's default keeps it on paper.

   One level, always. The announcement row that used to sit underneath made the
   bar change height on scroll, which moved the page's only fixed landmark.    */

const NAV = [
  { label: "Solutions", to: "/solutions", menu: true },
  { label: "Pricing", to: "/pricing" },
  { label: "Blog", to: "/blog" },
  { label: "FAQ", to: "/faq" },
];

const MENU = SOLUTIONS.map((s) => ({
  ...s.menu,
  hue: s.key,
  to: `/solutions/${s.slug}`,
}));

/** The bar's height. Exported because every hero has to start below it. */
export const NAV_H = 62;

export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const { pathname } = useLocation();

  const tone = useCurrentTone();
  const dark = TONE_IS_DARK[tone];

  /* One palette, resolved once. Written as values rather than as two branches
     of class names so the whole bar can be read at a glance — and so the
     transition below animates every one of them on the same clock. */
  const ink = dark ? "#FFFFFF" : "#0E0E0E";
  const dim = dark ? "rgba(255,255,255,0.68)" : "#3A3A3A";
  const rule = dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.09)";

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
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
        /* Same 900ms curve as the tone canvas, so the bar and the ground behind
           it arrive at the new colour together. Any faster and the bar leads the
           page; any slower and it lags behind a section you are already reading.

           The hairline only appears once the page has moved: at rest the bar and
           the hero are one continuous sheet, and a rule drawn across it would be
           the first thing you saw. */
        className="fixed inset-x-0 top-0 z-50 border-b transition-colors duration-[900ms] ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none"
        style={{
          height: NAV_H,
          backgroundColor: TONES[tone],
          borderColor: scrolled ? rule : "transparent",
          color: ink,
        }}
      >
        <div className="flex h-full items-center gap-7 px-4 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2.5">
            <Logo size={21} color={dark ? BRAND_MARK_BRIGHT : BRAND_MARK} />
            <span className="text-[16.5px] leading-none" style={{ fontFamily: BRAND_FONT }}>
              Anduran
            </span>
          </Link>

          <nav className="hidden items-center gap-6 md:flex">
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
                    className="flex items-center gap-1 py-2 text-[14.5px] transition-colors"
                    style={{ color: isCurrent(l.to) ? ink : dim }}
                  >
                    {l.label}
                    <ChevronDown
                      className={`h-3.5 w-3.5 opacity-60 transition-transform ${menu ? "rotate-180" : ""}`}
                    />
                  </Link>
                  {/* ── The panel ───────────────────────────────────────
                      Rebuilt in the paper register the pages now use: square,
                      hairlines instead of gaps, the numbering carried through
                      from the solutions page, and one blue. The rounded-2xl
                      tiles it replaced belonged to the generation the rest of
                      the site has left.

                      The numbers matter more than they look: the whole claim of
                      that page is that the six happen in an order, so the menu
                      that indexes them has to say so too. */}
                  {menu && (
                    <div className="absolute left-1/2 top-full w-[600px] -translate-x-1/2 pt-3">
                      <div
                        className="border bg-white shadow-[0_30px_70px_-34px_rgba(0,0,0,0.45)]"
                        style={{ borderColor: "rgba(17,17,17,0.12)" }}
                      >
                        <div
                          className="grid grid-cols-2 gap-px"
                          style={{ background: "rgba(17,17,17,0.10)" }}
                        >
                          {MENU.map((s, i) => {
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
                                className={`group/item flex gap-3 p-4 transition-colors ${
                                  here ? "bg-[#F2F2F2]" : "bg-white hover:bg-[#F7F7F7]"
                                }`}
                              >
                                <span
                                  className="mt-[1px] flex h-[26px] w-[26px] shrink-0 items-center justify-center font-mono text-[11px] tabular-nums transition-colors"
                                  style={
                                    here
                                      ? { background: "#176995", color: "#FFFFFF" }
                                      : { color: "#777777", boxShadow: "inset 0 0 0 1px rgba(17,17,17,0.12)" }
                                  }
                                >
                                  {String(i + 1).padStart(2, "0")}
                                </span>
                                <span className="min-w-0">
                                  <span className="flex items-center gap-2">
                                    <span
                                      aria-hidden
                                      className="h-[6px] w-[6px] shrink-0"
                                      style={{ background: s.hue }}
                                    />
                                    <span className="text-[13.5px] font-medium text-[#111111]">
                                      {s.label}
                                    </span>
                                  </span>
                                  <span className="mt-1.5 block text-[12px] leading-snug text-[#777777]">
                                    {s.blurb}
                                  </span>
                                </span>
                              </Link>
                            );
                          })}
                        </div>

                        <Link
                          to="/solutions"
                          onClick={() => setMenu(false)}
                          className="group/all flex items-center justify-between gap-2 border-t px-4 py-3.5 text-[12.5px] text-[#777777] transition-colors hover:text-[#111111]"
                          style={{ borderColor: "rgba(17,17,17,0.12)" }}
                        >
                          All six, and the order they happen in
                          <ArrowUpRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover/all:translate-x-0.5 group-hover/all:-translate-y-0.5" />
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
                  className="py-2 text-[14.5px] transition-colors"
                  style={{ color: isCurrent(l.to) ? ink : dim }}
                >
                  {l.label}
                </Link>
              ),
            )}
          </nav>

          {/* Pushed to the far edge, so the links stay grouped with the
              wordmark and the two buttons read as one pair. */}
          <div className="ml-auto hidden shrink-0 items-center gap-4 md:flex">
            <Link to="/login" className="text-[14.5px] transition-colors" style={{ color: dim }}>
              Sign in
            </Link>
            {/* The filled button inverts with the ground: a black slab is the
                loud one on paper and invisible on the dark canvas, so on dark it
                becomes the white slab and the ink flips with it. */}
            <Link
              to="/contact"
              className="rounded-[7px] px-4 py-2 text-[14px] font-medium transition-opacity hover:opacity-85"
              style={{ backgroundColor: ink, color: TONES[tone] }}
            >
              Book a consultation
            </Link>
            {/* The outlined twin: same shape, hairline instead of a fill, so the
                second action is available without competing with the first. */}
            <Link
              to="/solutions"
              className="group flex items-center gap-2 rounded-[7px] border px-4 py-2 text-[14px] font-medium transition-colors"
              style={{ borderColor: dark ? "rgba(255,255,255,0.28)" : "rgba(0,0,0,0.20)", color: ink }}
            >
              See how it works
              <ArrowRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
            </Link>
          </div>

          <button
            className="ml-auto p-2 md:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            style={{ color: ink }}
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </header>

      {open && (
        <div className="fixed inset-0 z-[60] overflow-y-auto bg-white p-6 text-[#0E0E0E] md:hidden">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2.5">
              <Logo size={22} />
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
                className={`border-b border-black/[0.08] py-4 text-lg ${
                  isCurrent(l.to) ? "text-[#0E0E0E]" : "text-[#3A3A3A]"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>

          {/* The solutions sit one level down rather than behind a nested
              accordion — six links is shorter than the gesture to reveal them. */}
          <div className="mt-8">
            <div className="text-[11px] uppercase tracking-[0.14em] text-[#8A8A8A]">Solutions</div>
            <div className="mt-4 flex flex-col">
              {MENU.map((s) => (
                <Link
                  key={s.to}
                  to={s.to}
                  onClick={() => setOpen(false)}
                  aria-current={pathname === s.to ? "page" : undefined}
                  className={`flex items-center gap-3 border-b border-black/[0.06] py-3 text-[15px] ${
                    pathname === s.to ? "text-[#0E0E0E]" : "text-[#4A4A4A]"
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
              className="block rounded-[9px] bg-[#0E0E0E] py-4 text-center text-[15px] font-medium text-white"
            >
              Book a consultation
            </Link>
            <Link
              to="/login"
              onClick={() => setOpen(false)}
              className="block rounded-[9px] border border-black/20 py-4 text-center text-[15px] font-medium text-[#0E0E0E]"
            >
              Sign in
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
