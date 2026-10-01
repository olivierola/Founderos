import { SparkleIcon as Sparkle } from "@phosphor-icons/react";
import { Reveal } from "./LandingKit";
import { Btn, Container, Eyebrow, Heading, Lead, Section } from "./atlas/AtlasKit";

/* The last thing before the footer, on every page: an eyebrow, one line in
   the two voices, and the two ways in. Deliberately plain — the violet slab
   of the footer arrives right under it and is loud enough for both. */
export function LandingClose() {
  return (
    <Section className="pb-16 sm:pb-20">
      <Container>
        <Reveal className="flex flex-col items-center text-center">
          <Eyebrow icon={Sparkle} accent="Get started" />
          <Heading className="mt-8" inline lead="Get started" serif="exploring Anduran" />
          <Lead className="mt-5 max-w-[34ch]">
            Or book a consultation and we will show you an agent working on your own systems.
          </Lead>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
            <Btn to="/signup" variant="dark" size="lg" className="min-w-[190px]">
              Get started
            </Btn>
            <Btn to="/contact" variant="light" size="lg" className="min-w-[190px]">
              Book a consultation
            </Btn>
          </div>
        </Reveal>
      </Container>
    </Section>
  );
}
