import { HnPage } from "./hn/HnPage";
import { HomeHeroHn } from "./hn/home/HomeHeroHn";
import { HomeProductsHn, HomeUseCasesHn } from "./hn/home/HomeProductsHn";
import { HomeCompareHn } from "./hn/home/HomeCompareHn";
import { HomeAgentsHn, HomeDifferentHn } from "./hn/home/HomeDarkHn";
import { HomeAgentsBandHn, HomeFeaturesHn, HomeHowHn } from "./hn/home/HomeHowHn";
import { HomeBlogHn, HomeGovernHn, HomePrincipleHn, HomeTrustHn } from "./hn/home/HomeGovernHn";
import { HomeTestimonialsHn } from "./hn/home/HomeTestimonialsHn";

/* ══ The landing page ════════════════════════════════════════════════════════
   Built on the Hunar register (see hn/): Geist, one blue, cool off-white bands
   alternating with deep navy ones, gradient artwork and product vignettes
   instead of photographs; cards flood blue on hover and fade up on scroll.

   The order follows hunar.ai section for section, with our content in each
   slot. Where the reference shows proof we do not have yet — customer logos,
   customer stories with figures, testimonials, certifications — the slot
   carries something we can stand behind instead (connectors, illustrative
   workflows, the product's own rule, the security measures in place):

     hero & marks → solution cards → products → use cases → why it holds up →
     meet the agents → what makes us different → product band → built for real
     work → how it works → the principle → Anduran Govern & solution blocks →
     built for scrutiny & integrations → testimonials (only once real ones
     exist; a labelled preview in development) → from the blog → CTA → footer.        */
export function HomePage() {
  return (
    <HnPage>
      <HomeHeroHn />
      <HomeProductsHn />
      <HomeUseCasesHn />
      <HomeCompareHn />
      <HomeAgentsHn />
      <HomeDifferentHn />
      <HomeAgentsBandHn />
      <HomeFeaturesHn />
      <HomeHowHn />
      <HomePrincipleHn />
      <HomeGovernHn />
      <HomeTrustHn />
      <HomeTestimonialsHn />
      <HomeBlogHn />
    </HnPage>
  );
}
