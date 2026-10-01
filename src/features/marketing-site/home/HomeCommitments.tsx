import { HandshakeIcon as Handshake } from "@phosphor-icons/react";
import { Reveal } from "../LandingKit";
import { Container, Panel, SectionHead } from "../atlas/AtlasKit";

/* ══ What you can hold us to ═════════════════════════════════════════════════
   The reference's testimonial stack — a quote card beside a photograph, the
   cards dealt over one another as you scroll. We have no customer who has
   agreed to be quoted yet, so the cards carry the three mechanisms we accept
   being held to, each described as it is written in the product, limit
   included. When real quotes exist they take this exact structure.         */

const COMMITMENTS = [
  {
    name: "Approval",
    img: "/landing/secure.jpg",
    pos: "58% 42%",
    claim: "A write action does not leave without you.",
    detail:
      "Reads run directly — searching, listing, looking something up never disturbs you. Anything that writes, sends, deletes or pays stops and waits for your approval, in the conversation. The second check can only add an approval, never remove one.",
    limit: "Unless you switch an agent to autonomous mode yourself — then it is your decision, taken knowingly.",
  },
  {
    name: "Traceability",
    img: "/landing/scale.jpg",
    pos: "50% 40%",
    claim: "Not just which tool — what went in, and what came back.",
    detail:
      "Every call records the arguments passed, the start of what came back, whether it succeeded, how long it took, and the run it belongs to — which you open to replay the whole sequence. Exportable.",
    limit: "Long values are truncated in storage: you read enough to judge, not a full copy of your data.",
  },
  {
    name: "Your keys",
    img: "/landing/adopt.jpg",
    pos: "50% 45%",
    claim: "Encrypted at rest — and your own model, if you want it.",
    detail:
      "Connector credentials are encrypted at rest with AES-256-GCM and decrypted only server-side, at call time. Inference can leave our infrastructure too: point an OpenAI-compatible endpoint you host, and your prompts stay on your network.",
    limit: "An endpoint you host stays your responsibility: its availability and hardening are yours.",
  },
];

export function HomeCommitments() {
  return (
    <section className="relative py-20 sm:py-24">
      <Container>
        <Reveal>
          <SectionHead
            icon={Handshake}
            eyebrow="What you can"
            accent="hold us to"
            lead="Three commitments,"
            serif="limits included."
            description="We show no testimonials until customers agree to be quoted. These are the mechanisms we accept being held to — described exactly as the product runs them."
          />
        </Reveal>
      </Container>

      <Panel variant="soft" className="mt-14" tiles={false}>
        <Container className="py-3 sm:py-3">
          <div className="pt-2">
            {COMMITMENTS.map((c, i) => (
              <div key={c.name} className="sticky pb-3" style={{ top: `${86 + i * 14}px` }}>
                <div className="grid overflow-hidden rounded-[32px] border border-[#ececec] bg-white p-2.5 shadow-[0_-20px_60px_-40px_rgba(17,16,17,0.45)] lg:grid-cols-[320px_1fr]">
                  <div className="flex flex-col rounded-[24px] border border-[#f0f0f0] bg-[linear-gradient(180deg,#ffffff,#fafafa)] p-6">
                    <span className="text-[44px] font-bold leading-[0.6] text-[#111011]" aria-hidden>
                      ”
                    </span>
                    <p className="mt-6 text-[19px] font-semibold leading-[1.2] tracking-[-0.03em] text-[#111011]">
                      {c.claim}
                    </p>
                    <p className="mt-4 text-[14px] font-light italic leading-[1.45] text-[#3d3c3d]">{c.detail}</p>
                    <div className="mt-auto pt-8">
                      <p className="border-t border-[#f0f0f0] pt-4 text-[13px] leading-[1.45] text-[#666666]">
                        <span className="font-semibold text-[#111011]">— {c.name}. The limit:</span> {c.limit}
                      </p>
                    </div>
                  </div>
                  <div className="relative hidden min-h-[380px] overflow-hidden rounded-[24px] lg:ml-2.5 lg:block">
                    <img
                      src={c.img}
                      alt=""
                      aria-hidden
                      className="absolute inset-0 h-full w-full object-cover"
                      style={{ objectPosition: c.pos }}
                    />
                  </div>
                </div>
              </div>
            ))}
            {/* A real child, so the last card keeps travel to stick against. */}
            <div aria-hidden className="h-[6vh]" />
          </div>
        </Container>
      </Panel>
    </section>
  );
}
