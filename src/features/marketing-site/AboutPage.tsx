import { HnPage } from "./hn/HnPage";
import { ArtPanel, Btn, Card, Container, type Art } from "./hn/HnKit";

/* ═══ About ══════════════════════════════════════════════════════════════════
   hunar.ai's About page: a two-line statement (ink, then grey) and a button,
   a strip of framed pictures, "Who we are" in two columns, six value cards,
   a mission card over a wide picture, and the vision in three columns.

   The reference shows photographs of its team and offices. We show artwork
   instead, and we state no fact about the company we cannot back — no
   headcount, no offices, no funding. What is here is what we believe and
   what we build. */

const VALUES = [
  { title: "Proof over promises", line: "Show what the product does." },
  { title: "Safe by default", line: "The careful path is the default one." },
  { title: "Your data stays yours", line: "Connect to it, never copy it." },
  { title: "Build for real work", line: "Not for the demo." },
  { title: "Say the limit", line: "Every mechanism comes with its limit." },
  { title: "Think long term", line: "Build something that lasts." },
];

const STRIP: { art: Art; word: string; line: string }[] = [
  { art: "blue", word: "Approve", line: "Every write waits for a person." },
  { art: "violet", word: "Trace", line: "Every call can be replayed." },
  { art: "olive", word: "Own", line: "Your data, your keys, your model." },
];

export function AboutPage() {
  return (
    <HnPage>
      {/* ══ The statement ════════════════════════════════════════════════ */}
      <section className="bg-white">
        <Container className="pb-16 pt-16 lg:pb-20 lg:pt-24">
          <h1 className="max-w-[700px] text-[28px] font-medium leading-[1.2] tracking-[-0.04em] sm:text-[32px]">
            <span className="text-[#0f1728]">Super intelligence should work for you, and answer to you.</span>
            <br />
            <span className="text-[#4b5567]">
              We're building a Cloud workforce companies can put on their real systems: governed, auditable, and running
              inside their own tenant.
            </span>
          </h1>
          <Btn to="/contact" className="mt-10">Talk to us</Btn>
        </Container>

        {/* The strip of framed pictures — artwork where the reference has photos. */}
        <div className="grid gap-4 overflow-hidden pb-6 md:grid-cols-3">
          {STRIP.map((a, i) => (
            <div key={a.word} className={`bg-[#f7f8fb] p-6 ${i === 1 ? "md:self-start" : ""}`}>
              <ArtPanel art={a.art} className={`flex items-end rounded-[14px] p-5 ${i === 1 ? "h-[200px]" : "h-[340px]"}`}>
                <div className="rounded-[24px] bg-white px-4 py-3 text-[#0f1728] hn-shadow-lg">
                  <div className="text-[20px] font-medium leading-[1.2] tracking-[-0.03em]">{a.word}</div>
                  <div className="mt-0.5 text-[14px] text-[#4b5567]">{a.line}</div>
                </div>
              </ArtPanel>
            </div>
          ))}
        </div>
      </section>

      {/* ══ Who we are ═════════════════════════════════════════════════════ */}
      <section className="bg-white py-16 lg:py-20">
        <Container>
          <h2 className="text-[28px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728] sm:text-[32px]">Who we are</h2>
          <div className="mt-6 grid max-w-[700px] gap-6 text-[18px] leading-[1.3] text-[#4b5567] sm:grid-cols-2">
            <div className="space-y-4">
              <p>We're builders who think a Cloud collaborator is only useful once a company can trust it with real work.</p>
              <p>We care about the model, but we care more about what surrounds it: the approval, the trace, the key.</p>
            </div>
            <div className="space-y-4">
              <p>We work where super intelligence meets the systems companies already run, </p>
              <p>finance, hiring, support, reporting, operations, and the governance that has to come with it.</p>
            </div>
          </div>

          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {VALUES.map((v) => (
              <Card key={v.title} tone="bg" hover className="flex min-h-[240px] flex-col justify-between p-6">
                <div className="text-[20px] font-medium leading-[1.3] text-[#0f1728]">{v.title}</div>
                <div className="text-[18px] font-medium leading-[1.2] tracking-[-0.04em] text-[#4b5567]">{v.line}</div>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      {/* ══ The mission ═══════════════════════════════════════════════════ */}
      <section className="bg-white pb-16 lg:pb-24">
        <Container>
          <ArtPanel art="blue" className="relative flex min-h-[560px] items-center rounded-[14px] p-6 sm:p-12">
            <div className="max-w-[480px] bg-white p-6 text-[#0f1728] sm:p-8">
              <p className="text-[18px] font-medium leading-[1.3]">
                At Anduran, we're building one thing: a workforce of Cloud collaborators a company can actually switch on.
              </p>
              <p className="mt-5 text-[16px] leading-[1.45] text-[#4b5567]">
                That means Cloud collaborators that work on your systems rather than on copies of them; that stop and ask before they
                write; that leave a record an auditor can read; and that can run on a model you host when your data has
                to stay home.
              </p>
              <p className="mt-4 text-[16px] leading-[1.45] text-[#4b5567]">
                Everything we put on this site describes a mechanism that exists in the product, limits included. When
                we have customers who agree to be quoted, their words will appear here, not before.
              </p>
            </div>
          </ArtPanel>
        </Container>
      </section>

      {/* ══ The vision ═════════════════════════════════════════════════════ */}
      <section className="border-t border-[#e6e9ef] bg-white py-16 lg:py-24">
        <Container className="grid gap-10 lg:grid-cols-3">
          <div>
            <h2 className="text-[28px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728] sm:text-[32px]">Our vision is how we build</h2>
            <p className="mt-4 max-w-[360px] text-[18px] leading-[1.3] text-[#4b5567]">
              We believe the next generation of work software will be run by Cloud collaborators, and supervised by people.
            </p>
          </div>
          <div className="space-y-4 text-[18px] leading-[1.3] text-[#4b5567]">
            <p>
              Every company already has more work than people. Cloud collaborators can take on a large share of it, the reconciling,
              the chasing, the screening, the reporting, but only if the company can see and control what they do.
            </p>
            <p>Most AI tools ask for trust first. We think trust has to be earned one approved action at a time.</p>
          </div>
          <div className="space-y-4 text-[18px] leading-[1.3] text-[#4b5567]">
            <p>
              So we build the controls into the product rather than around it: an approval gate on every write, a second
              check that can only add caution, a log you can replay, and keys that never leave the server.
            </p>
            <p>A Cloud workforce that runs inside your own tenant, on your terms.</p>
          </div>
        </Container>
      </section>
    </HnPage>
  );
}
