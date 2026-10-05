import { useRef } from "react";
import { Link } from "react-router-dom";
import { ArtPanel, Btn, CarouselButtons, Chip, Container, Head, ProductShot } from "../HnKit";
import { TaskCard } from "../Mocks";
import { PRODUCTS } from "../site";
import { USE_CASES } from "../useCases";

/* ══ Products ════════════════════════════════════════════════════════════════
   Two products side by side in one ruled frame, a real capture of each
   bleeding off the foot of its half — the reference's "Products" block, with
   its hover: the half floods with the blue artwork, the text turns white, and
   the capture tilts up. */
export function HomeProductsHn() {
  return (
    <section className="border-t border-[#e6e9ef] bg-white py-20 lg:py-28">
      <Container>
        <Head
          eyebrow="Products"
          title="One platform to deploy, run and govern Cloud collaborators."
          lead="Build Cloud collaborators for every team, then keep them accountable with approvals, policies and a complete audit trail."
        />
        <div className="mt-16 grid overflow-hidden rounded-[24px] border border-[#e6e9ef] bg-[#f7f8fb] md:grid-cols-2">
          {PRODUCTS.map((p, i) => (
            <div
              key={p.slug}
              className={`group hn-hover hn-hover-flat overflow-hidden ${i === 0 ? "border-b border-[#e6e9ef] md:border-b-0 md:border-r" : ""}`}
            >
              <div className="px-8 pt-10">
                <h3 className="text-[24px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728]">{p.name}</h3>
                <p className="mt-2 max-w-[500px] text-[18px] leading-[1.3] text-[#4b5567]">{p.blurb}</p>
                <Btn to={`/product/${p.slug}`} variant="link" className="mt-5">
                  Learn about {p.slug === "agents" ? "agents" : "govern"}
                </Btn>
              </div>
              <div className="mt-12 h-[380px] pl-8 lg:h-[440px]">
                <ProductShot src={p.shot} alt={p.shotAlt} tilt className="h-[480px] w-[760px] rounded-br-none" />
              </div>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}

/* ══ Use cases ═══════════════════════════════════════════════════════════════
   The reference's customer-story carousel: a wide card with a category chip,
   a headline, two big lines and a picture. Ours are workflows, not customers —
   said in the lead, and the two lines are mechanisms, not results. */
export function UseCaseCarousel({ className }: { className?: string }) {
  const track = useRef<HTMLDivElement>(null);
  const scroll = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.min(1024, el.clientWidth * 0.8), behavior: "smooth" });
  };
  return (
    <div className={className}>
      <div ref={track} className="flex snap-x snap-mandatory gap-6 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {USE_CASES.map((u) => (
          <article
            key={u.slug}
            className="grid w-[86vw] max-w-[1000px] shrink-0 snap-start gap-6 rounded-[24px] border border-[#e6e9ef] bg-[#f7f8fb] p-6 hn-shadow sm:w-[80vw] md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]"
          >
            <div className="flex flex-col">
              <Chip className="self-start">{u.team}</Chip>
              <h3 className="mt-6 text-[28px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728] sm:text-[32px]">{u.title}</h3>
              <div className="mt-8 divide-y divide-[#e6e9ef]">
                {u.facts.map((f) => (
                  <div key={f.head} className="py-4 first:pt-0">
                    <div className="text-[32px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728]">{f.head}</div>
                    <div className="mt-1 text-[18px] leading-[1.3] text-[#4b5567]">{f.label}</div>
                  </div>
                ))}
              </div>
              <Btn to={u.to} variant="secondary" className="mt-auto self-start">
                Read how it works
              </Btn>
            </div>
            <ArtPanel art={u.art} className="flex min-h-[320px] items-center justify-center rounded-[24px] p-6">
              <TaskCard agent={u.agent} title={u.title} steps={u.steps} waiting={u.waiting} />
            </ArtPanel>
          </article>
        ))}
      </div>
      <CarouselButtons className="mt-6" onPrev={() => scroll(-1)} onNext={() => scroll(1)} />
    </div>
  );
}

export function HomeUseCasesHn() {
  return (
    <section className="border-t border-[#e6e9ef] bg-white py-20 lg:py-24">
      <Container>
        <Head
          eyebrow="Use cases"
          title={
            <>
              Built for the work your
              <br />
              teams do every day.
            </>
          }
          lead="See how Cloud collaborators handle finance, hiring, reporting, operations and governance, step by step."
        />
      </Container>
      <div className="mt-14 pl-5 sm:pl-8 lg:pl-[max(48px,calc((100vw-1344px)/2))]">
        <UseCaseCarousel />
      </div>
      <Container className="mt-4 flex flex-col items-center gap-3 text-center">
        <Link to="/use-cases" className="text-[16px] font-medium text-[#006edd] hover:text-[#0057c2]">
          See all use cases
        </Link>
        <span className="text-[13px] text-[#8a94a6]">Illustrative workflows with sample data, not customer results.</span>
      </Container>
    </section>
  );
}
