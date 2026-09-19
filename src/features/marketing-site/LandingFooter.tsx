import { Link } from "react-router-dom";
import {
  ArrowUpRightIcon as ArrowUpRight,
  GithubLogoIcon as Github,
  LinkedinLogoIcon as Linkedin,
  TwitterLogoIcon as Twitter,
} from "@phosphor-icons/react";
import { Logo } from "@/components/Logo";
import { BRAND_FONT } from "./LandingKit";
import { SOLUTIONS } from "./solutions";

/* The floating footer: a dark slab inset from all four edges of the page, so
   it reads as a card the page rests on rather than as a band welded to the
   bottom of it.

   The band behind the slab is a prop because the same footer closes two very
   different pages — the light interior pages, where it needs a grey ground to
   sit on, and the landing page, whose own tone canvas is already the ground
   and where any painted band would show as a seam. */

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

export function LandingFooter({ band = "#e4e4e4" }: { band?: string }) {
  return (
    <div className="relative px-3 pb-3 sm:px-5 sm:pb-5" style={{ background: band }}>
      {/* At least 80% of the viewport, so the slab reads as a closing panel and
          not as a strip tacked on the end. */}
      <footer className="relative flex min-h-[80dvh] flex-col overflow-hidden rounded-[24px] bg-[#0D0D0D] text-white sm:rounded-[32px]">
        <div className="relative mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-7 py-14 sm:px-12 sm:py-16">
          <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
            <div>
              <Link to="/" className="flex items-center gap-2.5">
                <Logo size={26} />
                <span className="text-[18px] leading-tight" style={{ fontFamily: BRAND_FONT }}>
                  Anduran
                </span>
              </Link>
              <p className="mt-5 max-w-xs text-[13.5px] leading-relaxed text-white/55">
                An AI workforce for companies ready to operate at machine speed: governed, auditable, and
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
                <div className="text-[10.5px] uppercase tracking-[0.14em] text-white/35">{col.title}</div>
                <ul className="mt-5 space-y-3">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      <Link
                        to={l.to}
                        className="group inline-flex items-center gap-1 text-[13.5px] text-white/60 transition-colors hover:text-white"
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
            style={{ fontSize: "clamp(44px, 9.5vw, 140px)", fontFamily: BRAND_FONT }}
          >
            Anduran
          </div>

          <div className="mt-6 flex flex-col gap-3 border-t border-white/10 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[12.5px] text-white/45">
              © {new Date().getFullYear()} Anduran. All rights reserved.
            </span>
            <div className="flex items-center gap-6">
              <Link to="/docs" className="text-[12.5px] text-white/45 transition-colors hover:text-white">
                Privacy Policy
              </Link>
              <Link to="/docs" className="text-[12.5px] text-white/45 transition-colors hover:text-white">
                Terms
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
