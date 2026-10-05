import { ALL_TOOLS, ToolMark } from "./tools";
import { HnHero, HnPage } from "./hn/HnPage";
import { ArtPanel, Btn, Card, Container } from "./hn/HnKit";
import { AgentBadge } from "./hn/AgentBadge";
import { TaskCard } from "./hn/Mocks";
import { USE_CASES } from "./hn/useCases";

/* ═══ Use cases ══════════════════════════════════════════════════════════════
   hunar.ai's "Customer Stories" page: a big title, a row of marks, a featured
   card straddling a blue band, then a grid of story cards.

   We have no customer who has agreed to be named, so the page carries
   workflows instead of stories, and says so under the title. The marks are
   connectors, not customers. Each card leads to the solution page that
   describes the mechanism. */

const MARKS = ALL_TOOLS.slice(0, 10);

export function UseCasesPage() {
  const [featured, ...rest] = USE_CASES;
  return (
    <HnPage>
      <HnHero
        variant="center"
        tone="white"
        title="Use cases"
        lead="What a Cloud collaborator takes on in each team, step by step, described exactly as the product runs it."
        note="Illustrative workflows with sample data, not customer results."
      >
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-[#7a8496]">
          {MARKS.map((t) => (
            <span key={t.name} className="flex items-center gap-1.5">
              {(t.path || t.logo) && <span style={{ color: `#${t.hex}` }} className="flex"><ToolMark tool={t} size={18} /></span>}
              <span className="text-[16px] font-semibold tracking-[-0.02em]">{t.name}</span>
            </span>
          ))}
        </div>
      </HnHero>

      {/* ══ The featured workflow, straddling the blue band ════════════════ */}
      <section className="relative bg-white pb-16">
        <div aria-hidden className="hn-sky absolute inset-x-0 bottom-0 top-[18%]" />
        <Container narrow className="relative">
          <Card className="grid gap-8 p-6 sm:p-8 lg:grid-cols-2">
            <div className="flex flex-col">
              <div className="text-[16px] font-medium text-[#4b5567]">Featured workflow · {featured.team}</div>
              <h2 className="mt-6 text-[28px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728] sm:text-[32px]">{featured.title}</h2>
              <div className="mt-8 divide-y divide-[#e6e9ef]">
                {featured.facts.map((f) => (
                  <div key={f.head} className="py-4 first:pt-0">
                    <div className="text-[32px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728]">{f.head}</div>
                    <div className="mt-1 text-[18px] leading-[1.3] text-[#4b5567]">{f.label}</div>
                  </div>
                ))}
              </div>
              <Btn to={featured.to} variant="secondary" className="mt-auto self-start">
                Read how it works
              </Btn>
            </div>
            <ArtPanel art={featured.art} className="flex min-h-[340px] items-center justify-center rounded-[24px] p-6">
              <TaskCard agent={featured.agent} title={featured.title} steps={featured.steps} waiting={featured.waiting} />
            </ArtPanel>
          </Card>
        </Container>
      </section>

      {/* ══ The grid ═══════════════════════════════════════════════════════ */}
      <section className="bg-[#f7f8fb] py-16 lg:py-20">
        <Container>
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
            {rest.map((u) => (
              <Card key={u.slug} hover className="flex flex-col p-2">
                <ArtPanel art={u.art} className="flex h-[220px] items-center justify-center rounded-[14px] p-4">
                  <AgentBadge name={u.agent} size={56} tone="glass" />
                </ArtPanel>
                <div className="flex flex-1 flex-col p-3 pt-5">
                  <div className="text-[14px] text-[#4b5567]">{u.team}</div>
                  <h3 className="mt-1 text-[20px] font-medium leading-[1.3] text-[#0f1728]">{u.title}</h3>
                  <Btn to={u.to} variant="link" className="mt-auto self-start pt-6">
                    Read how it works
                  </Btn>
                </div>
              </Card>
            ))}
          </div>
        </Container>
      </section>
    </HnPage>
  );
}
