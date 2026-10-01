import { useMemo, useState } from "react";
import {
  HandPalmIcon as HandPalm,
  KeyIcon as Key,
  MagnifyingGlassIcon as Search,
  PlugsConnectedIcon as Plugs,
  StackIcon as Stack,
} from "@phosphor-icons/react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { LandingClose } from "./LandingClose";
import { Reveal } from "./LandingKit";
import { PaperHero } from "./PaperHero";
import { MonoLabel, SectionTitle } from "./PaperKit";
import { ToneCanvas, ToneSection } from "./LandingTone";
import { Btn, IconOrb, useAtlasSkin } from "./atlas/AtlasKit";
import { PROVIDERS, type ProviderCategory } from "@/lib/providers";

/* ═══ Intégrations ═══════════════════════════════════════════════════════════
   Sortie d'OtherPages et refaite sur le système actuel.

   Le discours a été repris, pas seulement la forme. L'ancienne version titrait
   « tous vos outils, un seul coffre » et promettait « chiffrement, propagation
   et révocation » pour chaque intégration — le vocabulaire du coffre à
   identifiants maison, qui n'est plus le chemin par lequel un agent se
   connecte. Décrire un mécanisme qu'on n'utilise plus, c'est vendre une garantie
   qu'on ne peut pas tenir.

   Ce qui reste vrai, et ce que la page dit maintenant : voici les outils
   auxquels un agent sait se connecter, la connexion est autorisée par vous, son
   périmètre est explicite, et ce qui écrit passe par votre accord.

   La liste vient de `src/lib/providers.ts`. Le catalogue complet, lui, est
   derrière l'authentification — on ne peut pas l'interroger depuis une page
   publique, et on préfère une liste honnêtement partielle à un nombre gonflé.
   Traduite en anglais le 01/10/2026 : le site ne parle plus qu'une langue. */

const CATEGORY_LABEL: Record<ProviderCategory, string> = {
  repo: "Code",
  payments: "Payments",
  backend: "Back-end",
  hosting: "Hosting",
  ai: "AI & models",
  analytics: "Analytics",
  email: "Email",
  monitoring: "Monitoring",
  messaging: "Messaging",
  storage: "Storage",
  automation: "Automation",
  security: "Security",
  crm: "CRM & sales",
  marketing: "Marketing",
  hr: "HR",
  design: "Design",
  data: "Data",
  tooling: "Tooling",
};

const label = (c: string) => CATEGORY_LABEL[c as ProviderCategory] ?? c;

const PRINCIPLES = [
  {
    icon: Key,
    t: "You authorise",
    b: "The connection uses your own account, through OAuth when the tool offers it. You revoke it from the same place.",
  },
  {
    icon: Stack,
    t: "The agent gets a scope",
    b: "An agent only sees the tools it has been granted. Outside that scope, the call stops dead.",
  },
  {
    icon: HandPalm,
    t: "Writing waits for you",
    b: "Searching and reading run directly. Writing, sending and deleting ask for your approval in the conversation.",
  },
];

export function IntegrationsPage() {
  useAtlasSkin();
  const [search, setSearch] = useState("");
  const [activeCat, setActiveCat] = useState<string>("all");

  const cats = useMemo(
    () => Array.from(new Set(PROVIDERS.map((p) => p.category))).sort((a, b) => label(a).localeCompare(label(b), "en")),
    [],
  );

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return PROVIDERS.filter((p) => {
      if (activeCat !== "all" && p.category !== activeCat) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.slug.includes(q);
    });
  }, [search, activeCat]);

  return (
    <div className="amplify atlas min-h-screen" style={{ backgroundColor: "transparent" }}>
      <LandingNav />
      <ToneCanvas initial="paper">
        <PaperHero
          label="Integrations"
          frame={["Your agents work"]}
          claim="where your tools are"
          lead={
            <>
              A connection you authorise, an explicit tool scope per agent, and writing that stops in front of
              you. Nothing is copied over to us.
            </>
          }
          align="left"
        />

        {/* ── What "connect" means here ──────────────────────────────────── */}
        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1200px] px-5 pb-16 pt-4 sm:px-8">
            <div className="grid gap-2.5 sm:grid-cols-3">
              {PRINCIPLES.map((c, i) => (
                <Reveal key={c.t} delay={i * 80} className="h-full">
                  <div className="h-full rounded-[32px] border border-[#f0f0f0] bg-[linear-gradient(160deg,#ffffff_40%,#f8f8f8)] p-7">
                    <IconOrb icon={c.icon} size={48} />
                    <div className="mt-5 text-[17px] font-semibold tracking-[-0.025em] text-[#111011]">{c.t}</div>
                    <p className="mt-2 text-[14.5px] font-light leading-[1.55] text-[#3d3c3d]">{c.b}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </ToneSection>

        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1200px] px-5 pb-10 sm:px-8">
            <Reveal>
              <SectionTitle frame="The tools" claim={`already wired in — ${PROVIDERS.length}`} />
            </Reveal>

            {/* ── Search + categories ──────────────────────────────────────── */}
            <Reveal delay={90}>
              <div className="mt-10 flex flex-col gap-4 rounded-[28px] bg-[#f7f7f7] p-3 sm:flex-row sm:items-start">
                <div className="relative w-full shrink-0 sm:max-w-xs">
                  <Search
                    aria-hidden
                    className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#969696]"
                  />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search a tool"
                    placeholder="Search a tool…"
                    className="h-11 w-full rounded-full border border-[#e6e6e6] bg-white pl-11 pr-4 text-[14px] text-[#111011] outline-none transition-colors placeholder:text-[#969696] focus:border-[#8b16c4]"
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[{ c: "all", n: PROVIDERS.length }, ...cats.map((c) => ({ c, n: PROVIDERS.filter((p) => p.category === c).length }))].map(
                    ({ c, n }) => {
                      const active = activeCat === c;
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setActiveCat(c)}
                          aria-pressed={active}
                          className={`rounded-full px-3.5 py-2 text-[13px] font-medium transition-colors ${
                            active ? "bg-black text-white" : "bg-white text-[#3d3c3d] hover:text-[#111011]"
                          }`}
                        >
                          {c === "all" ? "All" : label(c)}{" "}
                          <span className="tabular-nums opacity-55">{n}</span>
                        </button>
                      );
                    },
                  )}
                </div>
              </div>
            </Reveal>

            {/* ── The list ─────────────────────────────────────────────────── */}
            {list.length === 0 ? (
              <p className="mt-12 text-[15px] text-[#666666]">
                No tool matches. Tell us which one you need — we add them.
              </p>
            ) : (
              <ul className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {list.map((p) => {
                  const Icon = p.icon;
                  return (
                    <li
                      key={p.slug}
                      className="flex items-center gap-3.5 rounded-[22px] border border-[#f0f0f0] bg-white px-4 py-3.5 shadow-[0_14px_30px_-26px_rgba(17,16,17,0.4)]"
                    >
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#f3f3f3] text-[#111011]">
                        <Icon className="h-[18px] w-[18px]" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[15px] font-semibold tracking-[-0.02em] text-[#111011]">
                          {p.name}
                        </span>
                        <span className="mt-0.5 block text-[12.5px] text-[#969696]">{label(p.category)}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            <Reveal delay={120}>
              <div className="mt-10 flex flex-col gap-6 rounded-[32px] bg-[#f7f7f7] p-8 sm:flex-row sm:items-center">
                <IconOrb icon={Plugs} size={56} />
                <div className="flex-1">
                  <MonoLabel>And what is not on the list</MonoLabel>
                  <p className="mt-4 max-w-[62ch] text-[15px] leading-[1.6] text-[#111011]">
                    An agent can also receive tools from a remote MCP server — yours, or a vendor's — with OAuth or
                    an authentication header. That is the route for an internal system that will never have a
                    ready-made connector.
                  </p>
                </div>
                <Btn to="/contact" variant="dark" className="shrink-0">
                  Request an integration
                </Btn>
              </div>
            </Reveal>
          </div>
        </ToneSection>

        <LandingClose />

        <ToneSection tone="paper">
          <LandingFooter band="transparent" />
        </ToneSection>
      </ToneCanvas>
    </div>
  );
}
