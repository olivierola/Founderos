import { Link } from "react-router-dom";
import { siClaude, siGithub, siGooglegemini, siPerplexity, siX } from "simple-icons";
import { LinkedinLogoIcon as Linkedin, OpenAiLogoIcon as OpenAi } from "@phosphor-icons/react";
import { SOLUTIONS } from "../solutions";
import { BrandLockup, TileField } from "./AtlasKit";

/* ── The closing slab ───────────────────────────────────────────────────────
   A violet panel inset from the viewport, a white card floating at its head
   with the links, and the name set enormous and translucent underneath — the
   last thing on every page, so it is the one place the brand is allowed to be
   loud. */

const COLUMNS: { title: string; links: { label: string; to: string }[] }[] = [
  {
    title: "Solutions",
    links: SOLUTIONS.map((s) => ({ label: s.nav, to: `/solutions/${s.slug}` })),
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

function SimpleIcon({ path, className }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d={path} />
    </svg>
  );
}

/* "Ask an AI about us": each link opens the assistant with the question
   already typed. The question is ours; the answer is theirs. */
const SUMMARY_PROMPT =
  "Summarise what Anduran does: an AI workforce that runs inside a company's own tenant, with approval-gated write actions and an exportable audit log. Who is it for and how does it compare?";
const q = encodeURIComponent(SUMMARY_PROMPT);
const ASSISTANTS = [
  { label: "ChatGPT", href: `https://chatgpt.com/?hints=search&q=${q}`, icon: <OpenAi className="h-[22px] w-[22px]" /> },
  { label: "Perplexity", href: `https://www.perplexity.ai/search?q=${q}`, icon: <SimpleIcon path={siPerplexity.path} className="h-5 w-5" /> },
  { label: "Claude", href: `https://claude.ai/new?q=${q}`, icon: <SimpleIcon path={siClaude.path} className="h-5 w-5" /> },
  { label: "Gemini", href: `https://www.google.com/search?udm=50&q=${q}`, icon: <SimpleIcon path={siGooglegemini.path} className="h-5 w-5" /> },
  { label: "Grok", href: `https://x.com/i/grok?text=${q}`, icon: <SimpleIcon path={siX.path} className="h-[18px] w-[18px]" /> },
];

const SOCIALS = [
  { label: "LinkedIn", href: "https://linkedin.com", icon: <Linkedin weight="fill" className="h-[18px] w-[18px]" /> },
  { label: "X", href: "https://x.com", icon: <SimpleIcon path={siX.path} className="h-4 w-4" /> },
  { label: "GitHub", href: "https://github.com/olivierola/Founderos", icon: <SimpleIcon path={siGithub.path} className="h-[18px] w-[18px]" /> },
];

export function AtlasFooter() {
  return (
    <footer className="bg-white px-[10px] pb-[10px] pt-6">
      <div className="at-grad-footer relative overflow-hidden rounded-[28px] sm:rounded-[40px]">
        <TileField
          lit={[[12, 12], [13, 13], [14, 12], [15, 13], [11, 13], [0, 6], [1, 7], [15, 5]]}
          mask="linear-gradient(180deg, transparent 0%, #000 40%, #000 80%, transparent 100%)"
        />

        <div className="relative mx-auto max-w-[1220px] px-2 pt-2 sm:px-6 sm:pt-1">
          <div className="rounded-[24px] bg-[linear-gradient(180deg,#ffffff_45%,rgba(255,255,255,0.8))] px-6 pb-8 pt-8 shadow-[0_30px_80px_-40px_rgba(30,0,45,0.8)] sm:rounded-[40px] sm:px-10 sm:pt-10">
            <div className="grid gap-10 md:grid-cols-[1.1fr_2fr_auto]">
              <div>
                <Link to="/" aria-label="Anduran — home" className="inline-block">
                  <BrandLockup size="lg" />
                </Link>
                <p className="mt-5 max-w-[30ch] text-[13.5px] font-light leading-[1.5] text-[#666666]">
                  The AI workforce that runs inside your own tenant — governed, auditable, and on the
                  stack you already have.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
                {COLUMNS.map((col) => (
                  <div key={col.title}>
                    <div className="text-[15px] font-semibold tracking-[-0.01em] text-[#111011]">{col.title}</div>
                    <ul className="mt-3 space-y-2">
                      {col.links.map((l) => (
                        <li key={l.label}>
                          <Link
                            to={l.to}
                            className="text-[13.5px] text-[#111011]/75 transition-colors hover:text-[#8b16c4]"
                          >
                            {l.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              <div className="flex items-start gap-2.5">
                {SOCIALS.map((s) => (
                  <a
                    key={s.label}
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={s.label}
                    className="grid h-10 w-10 place-items-center rounded-full bg-[#f3f3f3] text-[#111011] transition-colors hover:bg-[#ececec]"
                  >
                    {s.icon}
                  </a>
                ))}
              </div>
            </div>

            <div className="mt-12 flex flex-col items-center text-center">
              <div className="text-[16px] font-medium tracking-[-0.01em] text-[#111011]">
                Ask an AI to summarise Anduran
              </div>
              <div className="mt-4 flex items-center gap-5">
                {ASSISTANTS.map((a) => (
                  <a
                    key={a.label}
                    href={a.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Ask ${a.label} about Anduran`}
                    title={a.label}
                    className="text-[#111011] transition-transform hover:-translate-y-0.5"
                  >
                    {a.icon}
                  </a>
                ))}
              </div>
              <div className="mt-8 flex flex-col items-center gap-2 text-[13.5px] text-[#111011]/75 sm:flex-row sm:gap-6">
                <span>© {new Date().getFullYear()} Anduran. All rights reserved.</span>
                <span className="hidden sm:inline" aria-hidden>
                  ·
                </span>
                <Link to="/docs" className="hover:text-[#8b16c4]">
                  Privacy Policy
                </Link>
                <Link to="/docs" className="hover:text-[#8b16c4]">
                  Terms &amp; Conditions
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* The name, enormous and barely there. Cropped by the panel's foot. */}
        <div
          aria-hidden
          className="pointer-events-none relative select-none overflow-hidden text-center font-semibold leading-[0.8] tracking-[-0.06em] text-white/[0.22] mix-blend-overlay"
          style={{ fontSize: "clamp(96px, 22vw, 330px)" }}
        >
          <div className="translate-y-[12%]">Anduran</div>
        </div>
      </div>
    </footer>
  );
}
