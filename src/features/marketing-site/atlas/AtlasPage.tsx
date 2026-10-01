import type { ComponentType, CSSProperties, ReactNode } from "react";
import { CaretDoubleDownIcon as CaretDoubleDown } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Eyebrow, Heading, Lead, Panel, useAtlasSkin } from "./AtlasKit";
import { AtlasNav } from "./AtlasNav";
import { AtlasFooter } from "./AtlasFooter";

type IconType = ComponentType<{ className?: string; style?: CSSProperties }>;

/* ── The page shell ─────────────────────────────────────────────────────────
   Nav, the page, the footer, on white. `.amplify` stays on the root for the
   shared motion classes and the focus rings; `.atlas` overrides its ground,
   ink and type. */
export function AtlasPage({ children, className }: { children: ReactNode; className?: string }) {
  useAtlasSkin();
  return (
    <div className={cn("amplify atlas min-h-screen", className)}>
      <AtlasNav />
      <main>{children}</main>
      <AtlasFooter />
    </div>
  );
}

/* ── The interior hero ──────────────────────────────────────────────────────
   Two shapes, as on the reference:
   · `glow` — the eyebrow on white, then the title in white over a violet pool
     with a dark heart, and a round "scroll on" button at its foot. For pages
     whose opening is the statement.
   · `plain` — eyebrow and a dark title straight on the paper. For pages that
     open onto a working block (plans, a form), where a violet pool would push
     the thing the reader came for below the fold. */
export function AtlasPageHero({
  icon,
  eyebrow,
  accent,
  lead,
  serif,
  description,
  children,
  note,
  variant = "glow",
  align = "center",
}: {
  icon?: IconType;
  eyebrow?: ReactNode;
  accent?: ReactNode;
  lead?: ReactNode;
  serif?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  note?: ReactNode;
  variant?: "glow" | "plain";
  align?: "center" | "left";
}) {
  const center = align === "center";
  const cols = cn("flex flex-col", center ? "items-center text-center" : "items-start text-left");

  if (variant === "plain") {
    return (
      <section className="relative pt-[118px] sm:pt-[132px]">
        <div className={cn("mx-auto w-full max-w-[1200px] px-5 sm:px-8", cols)}>
          {(eyebrow || accent) && (
            <div className="amp-in" style={{ animationDelay: "40ms" }}>
              <Eyebrow icon={icon} accent={accent}>
                {eyebrow}
              </Eyebrow>
            </div>
          )}
          <div className="amp-in" style={{ animationDelay: "120ms" }}>
            <Heading
              as="h1"
              size="hero"
              lead={lead}
              serif={serif}
              className={cn("mt-8", center ? "max-w-[20ch]" : "max-w-[24ch]")}
            />
          </div>
          {description && (
            <div className="amp-in" style={{ animationDelay: "220ms" }}>
              <Lead className={cn("mt-6", center ? "mx-auto max-w-[56ch]" : "max-w-[60ch]")}>{description}</Lead>
            </div>
          )}
          {children && (
            <div className="amp-in mt-9 w-full" style={{ animationDelay: "300ms" }}>
              {children}
            </div>
          )}
          {note && (
            <div
              className="amp-in mt-6 flex items-center gap-2 text-[13.5px] text-[#666666]"
              style={{ animationDelay: "360ms" }}
            >
              {note}
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="relative pt-[82px]">
      <Panel
        variant="page"
        lit={[[0, 4], [1, 5], [14, 3], [15, 4], [13, 6], [0, 8], [15, 8]]}
        tileMask="linear-gradient(180deg, transparent 10%, #000 30%, #000 70%, transparent 95%)"
      >
        <div className={cn("mx-auto w-full max-w-[1000px] px-5 pb-10 pt-10 sm:px-8 sm:pt-12", cols)}>
          {(eyebrow || accent) && (
            <div className="amp-in" style={{ animationDelay: "40ms" }}>
              <Eyebrow icon={icon} accent={accent}>
                {eyebrow}
              </Eyebrow>
            </div>
          )}
          <div className="amp-in mt-14 sm:mt-20" style={{ animationDelay: "120ms" }}>
            <Heading
              as="h1"
              size="hero"
              tone="white"
              lead={lead}
              serif={serif}
              className={center ? "mx-auto max-w-[20ch]" : "max-w-[22ch]"}
            />
          </div>
          {description && (
            <div className="amp-in" style={{ animationDelay: "220ms" }}>
              <Lead tone="white" className={cn("mt-6", center ? "mx-auto max-w-[54ch]" : "max-w-[58ch]")}>
                {description}
              </Lead>
            </div>
          )}
          {children && (
            <div className="amp-in mt-9 w-full" style={{ animationDelay: "300ms" }}>
              {children}
            </div>
          )}
          {note && (
            <div
              className="amp-in mt-6 flex items-center gap-2 text-[13.5px] text-white/85"
              style={{ animationDelay: "360ms" }}
            >
              {note}
            </div>
          )}
          <button
            type="button"
            aria-label="Scroll to content"
            onClick={() => window.scrollBy({ top: window.innerHeight * 0.75, behavior: "smooth" })}
            className="amp-in mt-12 grid h-[58px] w-[58px] place-items-center self-center rounded-full bg-white text-[#111011] shadow-[0_18px_40px_-16px_rgba(60,0,90,0.7)] ring-[6px] ring-white/25 transition-transform hover:translate-y-0.5 sm:mt-16"
            style={{ animationDelay: "420ms" }}
          >
            <CaretDoubleDown weight="bold" className="h-5 w-5" />
          </button>
        </div>
      </Panel>
    </section>
  );
}
