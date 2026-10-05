import { QuotesIcon as Quotes } from "@phosphor-icons/react";
import { ArtPanel, Btn, Card, Container, Head } from "../HnKit";
import { TESTIMONIALS, type Testimonial } from "../testimonials";

/* ══ Testimonials ════════════════════════════════════════════════════════════
   The reference's closing quotes: a left-aligned head with a link, then three
   cards — the company's mark on a picture, a one-line headline in the
   customer's words, the longer quote, and the name and role.

   It renders only what testimonials.ts holds. That list is empty until real
   customers agree to be quoted, so in production the section does not appear;
   in development it shows the layout with labelled placeholders, so the design
   can be reviewed without a single invented name reaching the site. */

const PREVIEW: Testimonial[] = [1, 2, 3].map(() => ({
  headline: "The customer's one-line verdict goes here.",
  quote: "The longer quote, in the customer's own words: the problem they had, what changed with Anduran, and the result they measured themselves.",
  name: "Customer name",
  role: "Role",
  company: "Company",
}));

function TestimonialCard({ t, preview }: { t: Testimonial; preview: boolean }) {
  return (
    <Card hover className={`flex h-full flex-col p-2 ${preview ? "border-dashed" : ""}`}>
      <ArtPanel art="blue" className="relative flex h-[180px] items-center justify-center rounded-[14px]">
        {t.logo ? (
          <span className="rounded-[12px] bg-white px-4 py-3 hn-shadow-lg">
            <img src={t.logo} alt={t.company} className="h-7 w-auto object-contain" />
          </span>
        ) : (
          <span className="rounded-[12px] bg-white/20 px-4 py-2.5 text-[16px] font-semibold text-white backdrop-blur-md">{t.company}</span>
        )}
        {preview && (
          <span className="absolute left-3 top-3 rounded-[14px] bg-white px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#b54708]">
            Preview · not published
          </span>
        )}
      </ArtPanel>
      <div className="flex flex-1 flex-col px-3 pb-4 pt-5">
        <Quotes weight="fill" className="h-6 w-6 text-[#006edd]" />
        <h3 className="mt-3 text-[20px] font-medium leading-[1.3] text-[#0f1728]">{t.headline}</h3>
        <p className="mt-3 text-[16px] leading-[1.5] text-[#4b5567]">{t.quote}</p>
        <div className="mt-auto pt-6">
          <div className="text-[16px] font-medium text-[#0f1728]">{t.name}</div>
          <div className="text-[15px] text-[#4b5567]">
            {t.role}, {t.company}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function HomeTestimonialsHn() {
  const preview = TESTIMONIALS.length === 0;
  if (preview && !import.meta.env.DEV) return null;
  const list = preview ? PREVIEW : TESTIMONIALS;

  return (
    <section className="border-t border-[#e6e9ef] bg-white py-20 lg:py-24">
      <Container narrow>
        <Head
          align="left"
          eyebrow="Testimonials"
          title={
            <>
              Real teams. Real work.
              <br />
              In their own words.
            </>
          }
          lead="How teams use Anduran to put agents to work on their own systems, and keep every action accountable."
        >
          <Btn to="/use-cases" variant="link">See use cases</Btn>
        </Head>
        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {list.slice(0, 3).map((t, i) => (
            <TestimonialCard key={`${t.name}-${i}`} t={t} preview={preview} />
          ))}
        </div>
        {preview && (
          <p className="mt-6 text-[14px] text-[#b54708]">
            Development preview, this section stays hidden in production until real quotes are added to
            hn/testimonials.ts.
          </p>
        )}
      </Container>
    </section>
  );
}
