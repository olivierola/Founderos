import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Container, Eyebrow, H, P, useHnReveal, useHnSkin } from "./HnKit";
import { HnNav } from "./HnNav";
import { HnFooter } from "./HnFooter";

/* ── The page shell ─────────────────────────────────────────────────────────
   Nav, the page, the sky CTA and the ruled footer, on white. `.amplify` stays
   on the root for the shared reveal classes; `.hn` overrides its ground, ink
   and type. */
export function HnPage({
  children,
  className,
  cta = true,
}: {
  children: ReactNode;
  className?: string;
  cta?: boolean;
}) {
  useHnSkin();
  const main = useRef<HTMLElement>(null);
  useHnReveal(main);
  return (
    <div className={cn("amplify hn min-h-screen", className)}>
      <HnNav />
      <main ref={main}>{children}</main>
      <HnFooter cta={cta} />
    </div>
  );
}

/* ── The interior hero ──────────────────────────────────────────────────────
   Three shapes, as on the reference:
   · `title`  — a big title and a line on the off-white ground (Customer
                Stories, All Articles, Get in touch);
   · `center` — eyebrow, title, line and button centred (product pages);
   · `split`  — text on the left, artwork on the right (solution pages). */
export function HnHero({
  eyebrow,
  title,
  lead,
  children,
  aside,
  note,
  variant = "title",
  tone = "bg",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  /** The right-hand panel of the split hero. */
  aside?: ReactNode;
  note?: ReactNode;
  variant?: "title" | "center" | "split";
  tone?: "bg" | "white";
}) {
  const ground = tone === "bg" ? "bg-[#f7f8fb]" : "bg-white";

  if (variant === "split") {
    return (
      <section className={ground}>
        <Container className="grid items-stretch gap-10 py-10 lg:grid-cols-2 lg:gap-16 lg:py-12">
          <div className="flex flex-col justify-between">
            <div className="amp-in">
              {eyebrow && <div className="text-[16px] font-medium text-[#006edd]">{eyebrow}</div>}
              <H as="h1" size="hero" className="mt-6 max-w-[14ch]">
                {title}
              </H>
              {lead && <P className="mt-5 max-w-[44ch]">{lead}</P>}
              {children && <div className="mt-8">{children}</div>}
            </div>
            {note && <div className="mt-12 text-[16px] text-[#4b5567]">{note}</div>}
          </div>
          {aside && <div className="amp-in min-h-[420px]" style={{ animationDelay: "120ms" }}>{aside}</div>}
        </Container>
      </section>
    );
  }

  if (variant === "center") {
    return (
      <section className={ground}>
        <Container className="flex flex-col items-center py-16 text-center lg:py-24">
          {eyebrow && <Eyebrow className="amp-in">{eyebrow}</Eyebrow>}
          <H as="h1" size="hero" className="amp-in mt-5 max-w-[16ch]">
            {title}
          </H>
          {lead && <P className="amp-in mt-5 max-w-[44ch]">{lead}</P>}
          {children && <div className="amp-in mt-8">{children}</div>}
          {note && <div className="mt-6 text-[15px] text-[#4b5567]">{note}</div>}
        </Container>
      </section>
    );
  }

  return (
    <section className={ground}>
      <Container className="py-14 lg:py-20">
        {eyebrow && <Eyebrow className="amp-in">{eyebrow}</Eyebrow>}
        <H as="h1" size="hero" className="amp-in mt-4 max-w-[20ch]">
          {title}
        </H>
        {lead && <P className="amp-in mt-4 max-w-[56ch]">{lead}</P>}
        {children && <div className="amp-in mt-8">{children}</div>}
        {note && <div className="mt-6 text-[15px] text-[#4b5567]">{note}</div>}
      </Container>
    </section>
  );
}
