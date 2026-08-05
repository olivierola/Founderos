import { Link } from "react-router-dom";
import { Github, Linkedin, MessageCircle, Twitter } from "lucide-react";
import { Logo } from "@/components/Logo";
import { NeatBackground, FOOTER_NEAT_CONFIG } from "./NeatBackground";

const FOOTER_LINKS = [
  { label: "Docs", to: "/docs" },
  { label: "Contact us", to: "/contact" },
  { label: "Blog", to: "/changelog" },
  { label: "Academy", to: "/features" },
  { label: "Careers", to: "/about" },
  { label: "Terms & Conditions", to: "/legal" },
  { label: "Privacy Policy", to: "/privacy" },
];

const SOCIALS: { label: string; href: string; icon: typeof Github }[] = [
  { label: "X", href: "https://x.com", icon: Twitter },
  { label: "Discord", href: "https://discord.com", icon: MessageCircle },
  { label: "LinkedIn", href: "https://linkedin.com", icon: Linkedin },
  { label: "GitHub", href: "https://github.com/olivierola/Founderos", icon: Github },
];

// Airweave-style marketing footer: a rounded-top black panel with the same
// drifting warm/cool colour blobs + grain as the hero, a big wordmark, a right
// nav column, social buttons and a copyright line.
export function MarketingFooter() {
  return (
    <footer className="relative isolate overflow-hidden rounded-t-[2.5rem] bg-black text-foreground md:rounded-t-[3.5rem]">
      {/* ── Animated WebGL gradient background (firecms/neat) ────────────────── */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 bg-black" />
        <NeatBackground config={FOOTER_NEAT_CONFIG} className="absolute inset-0" />
      </div>
      {/* Film grain over the gradient — two layers (fine + coarse) for texture */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1] opacity-[0.22] mix-blend-soft-light"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='nf'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.95' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23nf)'/%3E%3C/svg%3E\")",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1] opacity-[0.10] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='cf'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.4' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23cf)'/%3E%3C/svg%3E\")",
        }}
      />

      {/* ── Content ──────────────────────────────────────────────────────────── */}
      <div className="relative z-10 mx-auto flex min-h-[440px] w-full max-w-[1600px] flex-col justify-between px-8 py-14 md:px-12">
        {/* Top: wordmark + nav column */}
        <div className="flex flex-col gap-12 sm:flex-row sm:items-start sm:justify-between">
          <Link to="/" className="flex items-center gap-3">
            <Logo size={44} />
            <span className="text-3xl font-semibold tracking-tight md:text-4xl">AchiCorp</span>
          </Link>

          <nav className="flex flex-col gap-4 border-l border-white/15 pl-8">
            {FOOTER_LINKS.map((l) => (
              <Link
                key={l.label}
                to={l.to}
                className="text-[13px] font-medium uppercase tracking-[0.1em] text-foreground/70 transition-colors hover:text-foreground"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>

        {/* Bottom: socials + copyright */}
        <div className="mt-16 flex flex-col-reverse items-start justify-between gap-6 sm:flex-row sm:items-end">
          <div className="flex items-center gap-2.5">
            {SOCIALS.map((s) => {
              const Icon = s.icon;
              return (
                <a
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={s.label}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-foreground/75 transition-colors hover:bg-white/10 hover:text-foreground"
                >
                  <Icon className="h-4 w-4" />
                </a>
              );
            })}
          </div>
          <span className="font-mono text-[12px] tracking-wide text-foreground/50">
            © {new Date().getFullYear()} AchiCorp. All rights reserved.
          </span>
        </div>
      </div>
    </footer>
  );
}
