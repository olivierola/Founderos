import { TagIcon as TagSimple } from "@phosphor-icons/react";
import { Reveal } from "../LandingKit";
import { PricingPlans } from "../PricingPlans";
import { Container, Section, SectionHead } from "../atlas/AtlasKit";

/* ══ Pricing ═════════════════════════════════════════════════════════════════
   The same grid /pricing opens on, read live from `billing_plans`, so the
   figures here can never disagree with what the checkout charges. */
export function HomePricing() {
  return (
    <Section id="pricing">
      <Container>
        <Reveal>
          <SectionHead icon={TagSimple} accent="Pricing" lead="Pick your plan." serif="Start this week." />
        </Reveal>
        <div className="mt-14">
          <PricingPlans compact />
        </div>
      </Container>
    </Section>
  );
}
