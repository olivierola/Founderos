import { Link } from "react-router-dom";
import { ArrowUpRight, Github, Linkedin, Twitter } from "lucide-react";
import { Logo } from "@/components/Logo";
import { BRAND_FONT } from "./LandingKit";
import { SOLUTIONS } from "./solutions";

const COLUMNS: { title: string; links: { label: string; to: string }[] }[] = [
  {
    title: "Solutions",
    // Read from the set rather than listed again, so the footer cannot end up
    // naming a solution differently from the nav or from its own page.
    links: SOLUTIONS.map((s) => ({ label: s.menu.label, to: `/solutions/${s.slug}` })),
  },
  {
    title: "Product",
    links: [
      { label: "Pricing", to: "/pricing" },
      { label: "Integrations", to: "/integrations" },
      { label: "Docs", to: "/docs" },
      { label: "Changelog", to: "/changelog" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Blog", to: "/blog" },
      { label: "FAQ", to: "/faq" },
      { label: "Contact", to: "/contact" },
      { label: "Sign in", to: "/login" },
    ],
  },
];

const SOCIALS = [
  { label: "LinkedIn", href: "https://linkedin.com", icon: Linkedin },
  { label: "X", href: "https://x.com", icon: Twitter },
  { label: "GitHub", href: "https://github.com/olivierola/Founderos", icon: Github },
];

// Footer as a dark panel inset on a light page — the page keeps a margin on all
// four sides so the panel reads as a card rather than a full-bleed band.
export function LandingFooter() {
  return (
    <div className="relative px-3 pb-3 sm:px-5 sm:pb-5" style={{ background: "#e4e4e4" }}>
      {/* At least 80% of the viewport, so the slab reads as a closing panel and
          not as a strip tacked on the end. */}
      <footer className="relative flex min-h-[80dvh] flex-col overflow-hidden rounded-[28px] bg-[#08080a] text-white sm:rounded-[36px]">
        {/* A soft accent glow so the slab is never perfectly flat. */}
        <div
          aria-hidden
          className="amp-wash-drift pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 55% 90% at 88% 0%, rgba(255,77,0,0.26), transparent 62%), radial-gradient(ellipse 45% 80% at 6% 100%, rgba(161,161,170,0.20), transparent 66%)",
          }}
        />

        <div className="relative mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-7 py-16 sm:px-12 sm:py-20">
          <div className="grid gap-12 md:grid-cols-[1.4fr_repeat(3,1fr)]">
            <div>
              <Link to="/" className="flex items-center gap-2.5">
                <Logo size={30} />
                <span className="text-[20px] leading-tight" style={{ fontFamily: BRAND_FONT }}>
                  Anduran
                </span>
              </Link>
              <p className="mt-5 max-w-xs text-[14.5px] leading-relaxed text-white/55">
                An AI workforce for companies ready to operate at machine speed — governed, auditable, and
                running inside your own stack.
              </p>
              <div className="mt-7 flex items-center gap-2">
                {SOCIALS.map((s) => {
                  const Icon = s.icon;
                  return (
                    <a
                      key={s.label}
                      href={s.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={s.label}
                      className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.04] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </a>
                  );
                })}
              </div>
            </div>

            {COLUMNS.map((col) => (
              <div key={col.title}>
                <div className="text-[11px] uppercase tracking-[0.14em] text-white/35">{col.title}</div>
                <ul className="mt-5 space-y-3">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      <Link
                        to={l.to}
                        className="group inline-flex items-center gap-1 text-[14px] text-white/65 transition-colors hover:text-white"
                      >
                        {l.label}
                        <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* Oversized wordmark, barely there */}
          <div
            aria-hidden
            // The wrapper crops overflow, so the line box keeps a little air
            // rather than the 0.8 a sans would take.
            className="pointer-events-none mt-auto select-none overflow-hidden pt-16 text-center leading-[0.95] tracking-normal text-white/[0.045]"
            style={{ fontSize: "clamp(46px, 10vw, 150px)", fontFamily: BRAND_FONT }}
          >
            Anduran
          </div>

          <div className="mt-6 flex flex-col gap-3 border-t border-white/10 pt-7 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[13px] text-white/45">
              © {new Date().getFullYear()} Anduran. All rights reserved.
            </span>
            <div className="flex items-center gap-6">
              <Link to="/docs" className="text-[13px] text-white/45 transition-colors hover:text-white">
                Privacy Policy
              </Link>
              <Link to="/docs" className="text-[13px] text-white/45 transition-colors hover:text-white">
                Terms
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
