import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, ChevronDown, Menu, X } from "lucide-react";
import { Logo } from "@/components/Logo";
import { BRAND_FONT } from "./LandingKit";
import { HERO_BG } from "./LandingHero";

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
  { label: "Solutions", to: "/features", menu: true },
  { label: "Pricing", to: "/pricing" },
  { label: "Blog", to: "/changelog" },
  { label: "FAQ", to: "/#faq" },
];

const SOLUTIONS = [
  { label: "Workforce Readiness", body: "Map which processes are ready for agents today.", to: "/features" },
  { label: "Secured AI Agents", body: "Agents that run inside your tenant, behind your identity.", to: "/features" },
  { label: "Foundation & Automation", body: "Structured data and workflows agents can stand on.", to: "/features" },
  { label: "AI Governance", body: "Policies, approvals and an audit trail on every action.", to: "/features" },
  { label: "Adoption & Enablement", body: "Champions, use cases, and usage you can measure.", to: "/features" },
  { label: "Managed Run", body: "An architect and a developer who know your environment.", to: "/features" },
];

// Flat top bar over the black canvas — wordmark left, links centred, a single
// bordered CTA right. It only gains a background once the page scrolls.
export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

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
              AchiCorp
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
                  <Link to={l.to} className="flex items-center gap-1.5 py-2 text-[15px] text-black/75 hover:text-black">
                    {l.label}
                    <ChevronDown className={`h-4 w-4 transition-transform ${menu ? "rotate-180" : ""}`} />
                  </Link>
                  {menu && (
                    <div className="absolute left-1/2 top-full w-[540px] -translate-x-1/2 pt-3">
                      <div className="grid grid-cols-2 gap-1 rounded-2xl border border-black/10 bg-white p-2 shadow-xl">
                        {SOLUTIONS.map((s) => (
                          <Link key={s.label} to={s.to} className="rounded-xl p-3 transition-colors hover:bg-black/[0.04]">
                            <div className="text-[13px] font-medium text-black">{s.label}</div>
                            <div className="mt-0.5 text-[11.5px] leading-snug text-black/50">{s.body}</div>
                          </Link>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <Link key={l.label} to={l.to} className="py-2 text-[15px] text-black/75 hover:text-black">
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
        <div className="fixed inset-0 z-[60] bg-[#000007] p-6 md:hidden">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2.5">
              <Logo size={24} />
              <span className="text-[17px] leading-tight" style={{ fontFamily: BRAND_FONT }}>
                AchiCorp
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
                className="border-b border-[var(--amp-line-soft)] py-4 text-lg"
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="mt-8 flex flex-col gap-3">
            <Link
              to="/contact"
              onClick={() => setOpen(false)}
              className="rounded-xl px-6 py-3.5 text-center text-[15px] font-medium"
              style={{ background: "var(--amp-accent)", color: "var(--amp-on-accent)" }}
            >
              Book a Consultation
            </Link>
            <Link
              to="/login"
              onClick={() => setOpen(false)}
              className="amp-panel rounded-xl px-6 py-3.5 text-center text-[15px]"
            >
              Sign in
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
