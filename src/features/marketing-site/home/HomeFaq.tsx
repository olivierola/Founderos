import { Link } from "react-router-dom";
import { PlusIcon as Plus, QuestionIcon as Question } from "@phosphor-icons/react";
import { Reveal } from "../LandingKit";
import { Container, Eyebrow, Heading, Section } from "../atlas/AtlasKit";

/* ══ FAQ ═════════════════════════════════════════════════════════════════════
   Left-aligned head, then a full-width list of questions ruled by hairlines,
   a plus that turns into a cross when the answer opens. */

const FAQ = [
  {
    q: "What does Anduran actually do?",
    a: "We help companies adopt AI safely. In practice, three things: we assess where your processes and data stand today, we build the secured foundation so AI has something solid to work on, and we guide adoption across the organisation with governance and change enablement.",
  },
  {
    q: "We are not sure we are ready for AI. Where do we start?",
    a: "With the readiness assessment. It rates every process from L1 to L5 and tells you which work is ready for an agent today, which needs a foundation first, and which should wait.",
  },
  {
    q: "How do you handle data security?",
    a: "Credentials are encrypted at rest with AES-GCM and never returned in plaintext to the browser. Every agent runs against scoped tool grants, write actions are approval-gated, and every call is recorded in an exportable audit log. We connect to your systems; we do not copy your data.",
  },
  {
    q: "Do agents run on our own infrastructure?",
    a: "They can. Agents run inside your tenant with your identity controls, and you can route inference to a model you host yourself — an OpenAI-compatible endpoint on your network.",
  },
  {
    q: "Do we need to be technical?",
    a: "No. Agents are configured through the assistant in the product, in plain language, and connectors sign in with the accounts you already have. A self-hosted model or a custom connector is where our team comes in.",
  },
  {
    q: "How much does it cost?",
    a: "Plans are billed monthly or yearly (two months free on yearly), with AI credits that cover what your agents actually spend at the model providers. Enterprise is priced on committed volume. There is no free trial.",
  },
  {
    q: "What industries and company sizes do you work with?",
    a: "From twenty-person teams to enterprises with several thousand seats. The framework is the same; the depth of governance scales with your regulatory surface.",
  },
];

export function HomeFaq() {
  return (
    <Section id="faq">
      <Container>
        <Reveal>
          <Eyebrow icon={Question} accent="FAQ" />
          <Heading className="mt-8" lead="Questions?" serif="We've got answers…" size="section" />
        </Reveal>

        <Reveal delay={100} className="mt-12">
          {FAQ.map((f) => (
            <details key={f.q} className="group border-b border-[#e6e6e6] first:border-t-0">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-6 text-[16px] font-medium tracking-[-0.01em] text-[#111011] [&::-webkit-details-marker]:hidden">
                {f.q}
                <Plus className="h-6 w-6 shrink-0 transition-transform duration-300 group-open:rotate-45" />
              </summary>
              <p className="max-w-[72ch] pb-7 pr-10 text-[15px] font-light leading-[1.6] text-[#3d3c3d]">{f.a}</p>
            </details>
          ))}
          <p className="mt-8 text-[14.5px] text-[#666666]">
            More on its own page —{" "}
            <Link to="/faq" className="font-semibold text-[#111011] underline decoration-[#d22eff]/50 underline-offset-4 hover:decoration-[#d22eff]">
              read all the questions
            </Link>
            .
          </p>
        </Reveal>
      </Container>
    </Section>
  );
}
