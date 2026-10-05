import { Link } from "react-router-dom";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react";
import { SOLUTIONS } from "./solutions";
import { HnHero, HnPage } from "./hn/HnPage";
import { ArtPanel, Btn, Card, Container, Fact, Head } from "./hn/HnKit";
import { SOLUTION_ART } from "./hn/site";
import { UseCaseCarousel } from "./hn/home/HomeProductsHn";

/* ═══ Solutions ══════════════════════════════════════════════════════════════
   The overview of the six blocks. hunar.ai has no such page — its solutions
   only live in the nav — so this one is assembled from its own patterns: the
   centred product-page hero, the solution cards of its home page, the dark
   "how it works" band with three labelled stages, and the stories carousel.

   The list comes from solutions.ts: the nav, the footer and the detail pages
   read the same array. */

const METHOD = [
  { tag: "Assess", title: "Score the ground", body: "Two to three weeks on processes, data and exposure. A scored roadmap before anyone writes code." },
  { tag: "Build", title: "Foundation, then agents", body: "Approvals that follow rules, then the first agents, inside your tenant, against scoped grants." },
  { tag: "Govern", title: "Switched on with agent one", body: "Registry, policies and audit trail from the first agent, never retrofitted." },
  { tag: "Run", title: "Measured and maintained", body: "Adoption measured per team, and a retainer that keeps the platform current." },
];

const FACTS = [
  { value: "6", label: "building blocks, in the order they happen" },
  { value: "4", label: "phases, stop after any of them" },
  { value: "AES-256", label: "encryption of connector credentials at rest" },
  { value: "0", label: "writes without your approval, unless you enable autonomy" },
];

export function SolutionsPage() {
  return (
    <HnPage>
      <HnHero
        variant="center"
        eyebrow="Solutions"
        title="Six building blocks for adopting AI safely"
        lead="In the order they actually need to happen. Most companies need three of them, and almost nobody needs all six at once."
      >
        <div className="flex flex-wrap items-center justify-center gap-5">
          <Btn to="/contact">Book a demo</Btn>
          <Btn to="/solutions/readiness" variant="link">Start with the assessment</Btn>
        </div>
      </HnHero>

      {/* ══ The six ═════════════════════════════════════════════════════════ */}
      <section className="bg-[#f7f8fb] pb-16 lg:pb-24">
        <Container>
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {SOLUTIONS.map((s) => (
              <Card key={s.slug} hover className="flex flex-col overflow-hidden">
                <ArtPanel art={SOLUTION_ART[s.slug] ?? "blue"} className="flex h-[220px] items-end p-4 sm:h-[260px]">
                  <span className="rounded-[14px] bg-white/90 px-2.5 py-1.5 text-[14px] font-medium text-[#0f1728]">{s.num}</span>
                </ArtPanel>
                <div className="flex flex-1 flex-col p-4 pb-6">
                  <h2 className="text-[20px] font-medium leading-[1.3] text-[#0f1728]">{s.menu.label}</h2>
                  <p className="mt-1 text-[18px] leading-[1.3] text-[#4b5567]">{s.lead}</p>
                  <ul className="mt-5 space-y-2">
                    {s.meta.map((m) => (
                      <li key={m.label} className="flex items-start gap-2 text-[15px] leading-[1.4] text-[#0f1728]">
                        <CheckCircle weight="fill" className="mt-0.5 h-4 w-4 shrink-0 text-[#006edd]" />
                        <span>
                          <span className="text-[#4b5567]">{m.label}:</span> {m.value}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <Btn to={`/solutions/${s.slug}`} variant="link" className="mt-auto self-start pt-6">
                    Learn about {s.nav.toLowerCase()}
                  </Btn>
                </div>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      {/* ══ Facts strip ════════════════════════════════════════════════════ */}
      <section className="border-y border-[#e6e9ef] bg-[#f7f8fb]">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4">
          {FACTS.map((f, i) => (
            <div key={f.label} className={`px-8 py-10 lg:px-12 ${i ? "border-t border-[#e6e9ef] sm:border-l sm:border-t-0" : ""}`}>
              <Fact value={f.value} label={f.label} />
            </div>
          ))}
        </div>
      </section>

      {/* ══ How an engagement runs ════════════════════════════════════════ */}
      <section className="hn-dark text-white">
        <div className="hn-rails mx-auto max-w-[1200px] px-6 py-20 sm:px-12 lg:py-24">
          <Head
            tone="dark"
            eyebrow="How it works"
            title="Four phases, and you can stop after any of them"
            lead="No twelve-month programme signed on day one. Each phase ends with something you own and a decision you are free to make either way."
          />
          <div className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {METHOD.map((m) => (
              <div key={m.tag} className="flex flex-col items-center text-center">
                <span className="rounded-full bg-[#006edd] px-4 py-2 text-[16px] font-medium leading-none">{m.tag}</span>
                <div className="mt-4 w-full rounded-[14px] border border-white/10 bg-white/[0.05] px-4 py-3 text-[18px] font-medium">
                  {m.title}
                </div>
                <p className="mt-4 text-[18px] leading-[1.3] text-white/75">{m.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ Use cases ══════════════════════════════════════════════════════ */}
      <section className="bg-white py-16 lg:py-24">
        <Container>
          <Head
            eyebrow="Use cases"
            title="Real work. Real systems."
            lead="Illustrative workflows, what an agent does in each, described as the product runs it. Not customer results."
          />
        </Container>
        <div className="mt-12 pl-5 sm:pl-8 lg:pl-12">
          <UseCaseCarousel />
        </div>
        <Container className="mt-6 text-center">
          <Link to="/use-cases" className="text-[16px] font-medium text-[#006edd] hover:text-[#0057c2]">
            See all use cases
          </Link>
        </Container>
      </section>
    </HnPage>
  );
}
