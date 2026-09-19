import { useState } from "react";
import NumberFlow from "@number-flow/react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Eyebrow } from "./LandingKit";

const BARS = [
  { value: 8, label: "Generic copilot rollout" },
  { value: 24, label: "In-house build" },
  { value: 31, label: "Traditional consultancy" },
  { value: 79, label: "Anduran", highlight: true, tooltip: "weekly active use" },
];

// Animated proof bars — the candy-striped track, spring-grown fills and the
// counting number are the reference component, restyled for the dark band.
export function LandingStats() {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
        <div className="amp-rails relative py-24 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <Eyebrow>Results</Eyebrow>
            <h2 className="mt-7 text-balance text-[34px] font-semibold leading-[1.06] tracking-[-0.028em] sm:text-[46px] lg:text-[54px]">
              We don't do pilots. We deliver adoption.
            </h2>
            <p className="mt-6 text-[17px] leading-[1.6] text-[var(--amp-muted)]">
              Licences are easy to buy and easy to waste. What we measure is whether people actually use the
              thing twelve weeks later. Here is where our rollouts land against the alternatives.
            </p>
          </div>

          <div className="relative mx-auto mt-20 flex h-[24rem] max-w-4xl items-end justify-center gap-2 sm:h-[28rem] sm:gap-4">
            {BARS.map((bar, i) => (
              <motion.div
                key={bar.label}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.3 }}
                transition={{ duration: 0.5, delay: i * 0.2, type: "spring", damping: 10 }}
                className="h-full w-full"
              >
                <Bar {...bar} delay={0.2 + i * 0.2} />
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Bar({
  value,
  label,
  highlight = false,
  tooltip,
  delay = 0,
}: {
  value: number;
  label: string;
  highlight?: boolean;
  tooltip?: string;
  delay?: number;
}) {
  // One in-view trigger for the whole column. It has to live on the full-height
  // wrapper: the fill and the callout both start at height 0, and a zero-height
  // element can never satisfy an intersection threshold, so `whileInView` on
  // them would never fire and the bars would stay empty forever.
  const [on, setOn] = useState(false);

  return (
    <motion.div
      className="group relative flex h-full w-full flex-col"
      onViewportEnter={() => setOn(true)}
      viewport={{ once: true, amount: 0.3 }}
    >
      <div className="amp-candy relative w-full flex-1 overflow-hidden rounded-[40px]">
        <motion.div
          initial={{ opacity: 0, y: 100, height: 0 }}
          animate={on ? { opacity: 1, y: 0, height: `${value}%` } : undefined}
          transition={{ duration: 0.5, type: "spring", damping: 20, delay }}
          className={cn(
            "absolute bottom-0 w-full rounded-[40px] p-2 text-white sm:p-3",
            // Fills stay translucent so the candy stripes read through them,
            // exactly as in the reference.
            highlight ? "bg-[#F5F5F5]/80" : "bg-[#f5f5f5]/80",
          )}
        >
          <div className="flex h-11 w-full items-center justify-center rounded-full bg-black/20 text-[15px] font-medium tracking-tighter sm:h-14 sm:text-[17px]">
            {/* NumberFlow only animates on change, so it counts up from zero. */}
            <NumberFlow value={on ? value : 0} suffix="%" />
          </div>
        </motion.div>
      </div>

      {/* Callout pinned to the top of the winning bar */}
      {tooltip && (
        <motion.div
          initial={{ height: 0 }}
          animate={on ? { height: `${value}%` } : undefined}
          transition={{ duration: 0.5, type: "spring", damping: 15, delay }}
          className="pointer-events-none absolute bottom-8 w-full"
        >
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={on ? { opacity: 1, y: 0 } : undefined}
            transition={{ duration: 0.5, type: "spring", damping: 15, delay: delay + 0.35 }}
            className="absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-xl bg-[#F5F5F5] px-2.5 py-1.5 text-[12px] font-medium text-white"
          >
            {tooltip}
            <svg
              className="absolute -bottom-[7px] left-1/2 -translate-x-1/2 text-[#F5F5F5]"
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              aria-hidden
            >
              <path
                d="M3.83855 8.41381C4.43827 9.45255 5.93756 9.45255 6.53728 8.41381L9.65582 3.01233C10.2555 1.97359 9.50589 0.675159 8.30646 0.675159H2.06937C0.869935 0.675159 0.120287 1.97359 0.720006 3.01233L3.83855 8.41381Z"
                fill="currentColor"
              />
            </svg>
            <span className="absolute -bottom-[26px] left-1/2 size-3.5 -translate-x-1/2 rounded-full border-2 border-white bg-[#F5F5F5]" />
          </motion.div>
        </motion.div>
      )}

      <p
        className={cn(
          "mx-auto mt-4 w-fit text-center text-[13px] tracking-tight",
          highlight ? "font-medium text-white" : "text-[var(--amp-faint)]",
        )}
      >
        {label}
      </p>
    </motion.div>
  );
}
