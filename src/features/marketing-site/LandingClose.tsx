import { Link } from "react-router-dom";
import { Display, Em, Pill, Reveal } from "./LandingKit";
import { ToneSection } from "./LandingTone";

/* The last thing before the footer: one card, one sentence, one way in. The
   photograph behind it is blurred past recognition — it is there to give the
   card depth on a flat canvas, not to say anything. */

export function LandingClose() {
  return (
    <ToneSection tone="ink">
      <div className="mx-auto max-w-[1420px] px-5 pb-20 pt-2 sm:px-9 sm:pb-24">
        <Reveal>
          <div className="relative flex min-h-[380px] items-center overflow-hidden rounded-[20px] border border-white/[0.08] sm:min-h-[440px]">
            <img
              src="/landing/adopt.jpg"
              alt=""
              aria-hidden
              className="absolute inset-0 h-full w-full scale-110 object-cover opacity-45 blur-[30px]"
            />
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(115deg, rgba(8,8,8,0.88) 20%, rgba(8,8,8,0.52))",
              }}
            />

            <div className="relative w-full px-7 py-12 sm:px-14 sm:py-16">
              <Display className="max-w-[14ch] text-[32px] sm:text-[44px] lg:text-[50px]">
                Accelerate your AI <Em>adoption</Em>
              </Display>
              <p className="mt-6 max-w-lg text-[15.5px] leading-[1.6] text-white/60">
                Thirty minutes is usually enough to know whether we are a fit. Or start with the maturity
                assessment — it tells you where you stand before anyone builds anything.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link to="/contact">
                  <Pill variant="light" className="px-6 py-3">Book a consultation</Pill>
                </Link>
                <Link to="/signup">
                  <Pill variant="ghost" className="px-6 py-3">
                    Start free
                  </Pill>
                </Link>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </ToneSection>
  );
}
