import { Link } from "react-router-dom";
import { siClaude, siGithub, siGooglegemini, siPerplexity, siX } from "simple-icons";
import { OpenAiLogoIcon as OpenAi } from "@phosphor-icons/react";
import { SOLUTIONS } from "../solutions";
import { Brand, Btn } from "./HnKit";
import { PRODUCTS } from "./site";

/* ── The close ──────────────────────────────────────────────────────────────
   The reference ends every page the same way: a white card floating on the
   sky band — one question, the assistants' marks, the blue button — then a
   ruled footer on the off-white ground. */

function Si({ path, className }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d={path} />
    </svg>
  );
}

/* "Ask an AI about us": each mark opens that assistant with the question
   already typed. The question is ours; the answer is theirs. */
const PROMPT = encodeURIComponent(
  "Summarise what Anduran does: enterprise superintelligence hired as always-alive Cloud collaborators that run inside a company's own tenant, with approval-gated write actions and an exportable audit log. Who is it for?",
);
const ASSISTANTS = [
  { label: "ChatGPT", href: `https://chatgpt.com/?hints=search&q=${PROMPT}`, icon: <OpenAi className="h-[22px] w-[22px]" /> },
  { label: "Perplexity", href: `https://www.perplexity.ai/search?q=${PROMPT}`, icon: <Si path={siPerplexity.path} className="h-5 w-5 text-[#1fb8cd]" /> },
  { label: "Claude", href: `https://claude.ai/new?q=${PROMPT}`, icon: <Si path={siClaude.path} className="h-5 w-5 text-[#d97757]" /> },
  { label: "Gemini", href: `https://www.google.com/search?udm=50&q=${PROMPT}`, icon: <Si path={siGooglegemini.path} className="h-5 w-5 text-[#4285f4]" /> },
  { label: "Grok", href: `https://x.com/i/grok?text=${PROMPT}`, icon: <Si path={siX.path} className="h-[18px] w-[18px]" /> },
];

const COLUMNS: { title: string; links: { label: string; to: string }[] }[] = [
  { title: "Solutions", links: SOLUTIONS.map((s) => ({ label: s.nav, to: `/solutions/${s.slug}` })) },
  {
    title: "Product",
    links: [
      ...PRODUCTS.map((p) => ({ label: p.name, to: `/product/${p.slug}` })),
      { label: "Pricing", to: "/pricing" },
      { label: "Integrations", to: "/integrations" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Blog", to: "/blog" },
      { label: "Docs", to: "/docs" },
      { label: "Changelog", to: "/changelog" },
      { label: "FAQ", to: "/faq" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", to: "/about" },
      { label: "Use cases", to: "/use-cases" },
      { label: "Get in touch", to: "/contact" },
      { label: "Sign in", to: "/login" },
    ],
  },
];

export function HnCta({
  title = "Ready to put Cloud collaborators to work on your own systems?",
  button = "Book a demo",
  to = "/contact",
}: {
  title?: string;
  button?: string;
  to?: string;
}) {
  return (
    <section className="hn-sky relative overflow-hidden px-5 py-14 sm:py-16">
      <div className="mx-auto flex min-h-[250px] max-w-[550px] flex-col justify-between rounded-[24px] bg-white p-6 shadow-[0_30px_60px_-30px_rgba(0,30,90,0.6)]">
        <h2 className="max-w-[400px] text-[28px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728] sm:text-[32px]">
          {title}
        </h2>
        <div className="mt-10 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            {ASSISTANTS.map((a) => (
              <a
                key={a.label}
                href={a.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Ask ${a.label} about Anduran`}
                title={`Ask ${a.label} about Anduran`}
                className="text-[#0f1728] transition-transform hover:-translate-y-0.5"
              >
                {a.icon}
              </a>
            ))}
          </div>
          <Btn to={to} variant="white">{button}</Btn>
        </div>
      </div>
    </section>
  );
}

export function HnFooter({ cta = true }: { cta?: boolean }) {
  return (
    <>
      {cta && <HnCta />}
      <footer className="bg-[#f7f8fb] text-[#0f1728]">
        <div>
          <div className="grid border-b border-[#e6e9ef] md:grid-cols-[312px_1fr]">
            <p className="border-b border-[#e6e9ef] px-6 py-8 text-[18px] leading-[1.3] text-[#4b5567] md:border-b-0 md:border-r lg:px-12">
              Enterprise superintelligence, running inside your own tenant.
            </p>
            <div className="flex items-center justify-start px-6 py-8 md:justify-end lg:px-12">
              <Brand size="lg" />
            </div>
          </div>

          <div className="grid md:grid-cols-[312px_1fr]">
            <div className="flex flex-col justify-between border-b border-[#e6e9ef] md:border-b-0 md:border-r">
              <div className="flex items-center gap-6 border-b border-[#e6e9ef] px-6 py-5 text-[16px] lg:px-12">
                <a href="https://linkedin.com" target="_blank" rel="noopener noreferrer" className="hover:text-[#006edd]">
                  LinkedIn
                </a>
                <a href="https://x.com" target="_blank" rel="noopener noreferrer" className="hover:text-[#006edd]">
                  X
                </a>
                <a
                  href="https://github.com/olivierola/Founderos"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 hover:text-[#006edd]"
                >
                  <Si path={siGithub.path} className="h-4 w-4" />
                  GitHub
                </a>
              </div>
              <div className="px-6 py-6 text-[14px] leading-[1.6] lg:px-12">
                <div className="text-[#0f1728]">Anduran</div>
                <a href="mailto:hello@founderos.dev" className="text-[#4b5567] hover:text-[#006edd]">
                  hello@founderos.dev
                </a>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4">
              {COLUMNS.map((col, i) => (
                <div key={col.title} className={i < COLUMNS.length - 1 ? "sm:border-r sm:border-[#e6e9ef]" : ""}>
                  <div className="border-b border-[#e6e9ef] px-6 py-5 text-[17px] text-[#4b5567] sm:px-8">{col.title}</div>
                  <ul className="space-y-3 px-6 py-6 sm:px-8">
                    {col.links.map((l) => (
                      <li key={l.label}>
                        <Link to={l.to} className="text-[16px] text-[#0f1728] transition-colors hover:text-[#006edd]">
                          {l.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-[#e6e9ef] px-6 py-10 text-[17px] text-[#4b5567] sm:flex-row sm:items-center sm:justify-between lg:px-12">
            <span>© {new Date().getFullYear()} Anduran | All rights reserved.</span>
            <span className="flex gap-6">
              <Link to="/docs" className="hover:text-[#006edd]">Privacy</Link>
              <Link to="/docs" className="hover:text-[#006edd]">Terms</Link>
            </span>
          </div>
        </div>
      </footer>
    </>
  );
}
