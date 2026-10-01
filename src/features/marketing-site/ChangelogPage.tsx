import { ClockCounterClockwiseIcon as History } from "@phosphor-icons/react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { LandingClose } from "./LandingClose";
import { Reveal } from "./LandingKit";
import { PaperHero } from "./PaperHero";
import { SectionTitle } from "./PaperKit";
import { ToneCanvas, ToneSection } from "./LandingTone";
import { Btn, CheckBadge, Tag as Pill, useAtlasSkin } from "./atlas/AtlasKit";

/* ═══ Changelog ══════════════════════════════════════════════════════════════
   Sortie d'OtherPages, qui portait encore l'ancienne coque marketing, et
   refaite sur le même système que l'accueil et les tarifs.

   Le contenu a changé autant que la forme. L'ancienne version s'arrêtait au
   31 mai et racontait un AUTRE produit — synchronisation de déploiements,
   module SaaS Analytics, coffre à identifiants. Rien de la force de travail IA
   qu'on vend aujourd'hui. Un changelog figé depuis quatre mois dit au visiteur
   que le produit est à l'arrêt ; un changelog qui décrit un produit disparu lui
   dit qu'on ne relit pas nos propres pages.

   Les entrées ci-dessous correspondent à ce qui a réellement été livré. Elles
   restent écrites à la main : un changelog généré depuis les commits raconte
   des correctifs de typage, pas ce qui change pour celui qui s'en sert.
   Traduit en anglais le 01/10/2026 : le site ne parle plus qu'une langue. */

type Kind = "feature" | "fix" | "release";

interface Entry {
  date: string;
  tag: Kind;
  title: string;
  items: string[];
}

const CHANGELOG: Entry[] = [
  {
    date: "2026-09-19",
    tag: "feature",
    title: "A public stats page for an agent",
    items: [
      "Performance and audience of a public agent, switched on per agent",
      "A conversation's outcome is recorded as it happens, never estimated afterwards",
    ],
  },
  {
    date: "2026-09-19",
    tag: "feature",
    title: "Dictation in every composer, activity orbs, health loop",
    items: [
      "The composer listens everywhere: agent chat, rooms, assistant, public widget",
      "A working agent's state shows in its orb, derived from the family of tools it is using",
      "Health alert on the AI HQ dashboard and a real credit gauge, with an alert at 80%",
    ],
  },
  {
    date: "2026-08-19",
    tag: "feature",
    title: "Two-view workflow editor, complete Stripe webhook",
    items: [
      "One graph, edited either as a document with tokens or as a canvas of nodes",
      "Variables, a live log console, note / set / wait / stop blocks",
      "Renewals, failed payments, cancellations and refunds handled end to end",
      "Learning by demonstration: record a gesture, it becomes a skill",
    ],
  },
  {
    date: "2026-08-12",
    tag: "release",
    title: "Usage-based billing: credits, quotas and plans",
    items: [
      "A run consumes measured credits, not an estimated flat fee",
      "Quotas per plan — agents, services, seats, storage, concurrent runs",
      "Overage is switched on explicitly, and capped",
    ],
  },
  {
    date: "2026-08-11",
    tag: "feature",
    title: "Agent reports become editable",
    items: [
      "One deliverable format, rendered by React components",
      "The report IS the editor: opening a document can no longer lose a block",
      "A deliverable that was not written is no longer announced as published",
    ],
  },
  {
    date: "2026-08-06",
    tag: "release",
    title: "Dashboards per service",
    items: [
      "An agent-centred space — rooms, schedules, activity, artifacts",
      "Agent catalogue and invitations at organisation level",
    ],
  },
  {
    date: "2026-07-16",
    tag: "feature",
    title: "MCP servers, agent skills, Admin area",
    items: [
      "An agent can receive tools from a remote MCP server, with OAuth or a static header",
      "Multi-file skills, read on demand rather than loaded in one block",
      "Administration lives in a single area: organisation, subscriptions, AI governance",
    ],
  },
];

const KIND_LABEL: Record<Kind, string> = {
  feature: "New",
  fix: "Fix",
  release: "Release",
};

function fmtDate(iso: string) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

export function ChangelogPage() {
  useAtlasSkin();
  return (
    <div className="amplify atlas min-h-screen" style={{ backgroundColor: "transparent" }}>
      <LandingNav />
      <ToneCanvas initial="paper">
        <PaperHero
          label="Changelog"
          frame={["What changed,"]}
          claim="and when"
          lead={
            <>
              The releases that change something for the people using the product. Internal fixes and
              rewrites nobody can see are left out.
            </>
          }
          align="left"
        />

        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1200px] px-5 pb-10 pt-6 sm:px-8">
            <div className="grid gap-10 lg:grid-cols-[0.42fr_1fr] lg:gap-16">
              <div className="lg:sticky lg:top-28 lg:self-start">
                <Reveal>
                  <SectionTitle frame={`${CHANGELOG.length} entries,`} claim="newest first" />
                  <p className="mt-6 max-w-[40ch] text-[15px] font-light leading-[1.6] text-[#3d3c3d]">
                    An entry is written when the thing is in production, not when it is merged. If a feature is
                    not here, it has not shipped yet.
                  </p>
                  <div className="mt-8">
                    <Btn to="/contact" variant="light">
                      Request a feature
                    </Btn>
                  </div>
                </Reveal>
              </div>

              <ol className="space-y-2.5">
                {CHANGELOG.map((e, i) => (
                  <Reveal key={e.date + e.title} delay={Math.min(i, 4) * 70}>
                    <li className="rounded-[32px] border border-[#f0f0f0] bg-[linear-gradient(160deg,#ffffff_40%,#f8f8f8)] p-7 sm:p-9">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="flex items-center gap-2 text-[13px] font-semibold text-[#666666]">
                          <History className="h-4 w-4" />
                          {fmtDate(e.date)}
                        </span>
                        <Pill tone={e.tag === "feature" ? "accent" : "light"} className="px-3 py-1.5 text-[12.5px]">
                          {KIND_LABEL[e.tag]}
                        </Pill>
                      </div>
                      <h3 className="mt-4 text-balance text-[21px] font-semibold leading-[1.2] tracking-[-0.035em] text-[#111011] sm:text-[24px]">
                        {e.title}
                      </h3>
                      <ul className="mt-6 space-y-3 border-t border-[#f0f0f0] pt-6">
                        {e.items.map((it) => (
                          <li key={it} className="flex gap-3 text-[14.5px] leading-[1.5] text-[#111011]">
                            <span className="mt-[1px]">
                              <CheckBadge size={20} />
                            </span>
                            <span>{it}</span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  </Reveal>
                ))}
              </ol>
            </div>
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
