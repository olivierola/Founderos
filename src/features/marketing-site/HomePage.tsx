import { AtlasPage } from "./atlas/AtlasPage";
import { LandingClose } from "./LandingClose";
import { HomeHero } from "./home/HomeHero";
import { HomePrinciple } from "./home/HomePrinciple";
import { HomeProblem } from "./home/HomeProblem";
import { HomeWorkforce } from "./home/HomeWorkforce";
import { HomeWork } from "./home/HomeWork";
import { HomeCommitments } from "./home/HomeCommitments";
import { HomeCompare } from "./home/HomeCompare";
import { HomeHowItWorks } from "./home/HomeHowItWorks";
import { HomePricing } from "./home/HomePricing";
import { HomeNoLockIn } from "./home/HomeNoLockIn";
import { HomeCalculator } from "./home/HomeCalculator";
import { HomeServices } from "./home/HomeServices";
import { HomeIntegrations } from "./home/HomeIntegrations";
import { HomeFaq } from "./home/HomeFaq";

/* ══ The landing page ════════════════════════════════════════════════════════
   Built on the Atlas register (see atlas/): white paper, Inter set tight with a
   Source Serif italic answer in every heading, and the violet poured through
   black into white inside rounded panels inset from the viewport.

   The order follows the reference, section for section, with our own content
   in each slot — and where the reference shows proof we do not have yet
   (endorsements, customer results, testimonials, a performance guarantee), the
   slot carries a mechanism the product actually runs instead:

     hero → facts & stack → the principle → the problem → the workforce (six
     offers) → the work an agent takes on → commitments → old way vs. new →
     how it works → pricing → no lock-in → calculator → services →
     integrations → FAQ → get started → footer.                               */
export function HomePage() {
  return (
    <AtlasPage>
      <HomeHero />
      <HomePrinciple />
      <HomeProblem />
      <HomeWorkforce />
      <HomeWork />
      <HomeCommitments />
      <HomeCompare />
      <HomeHowItWorks />
      <HomePricing />
      <HomeNoLockIn />
      <HomeCalculator />
      <HomeServices />
      <HomeIntegrations />
      <HomeFaq />
      <LandingClose />
    </AtlasPage>
  );
}
