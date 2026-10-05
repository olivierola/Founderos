/* ══ Testimonials ════════════════════════════════════════════════════════════
   The reference closes its home page with three customer quotes. The section
   is built (hn/home/HomeTestimonialsHn) and reads from this list — and it is
   EMPTY on purpose: we publish no quote that a real customer has not given and
   agreed to see printed (see the "no fabricated proof" rule). Until then the
   section is hidden in production and shown in development only, as a clearly
   labelled preview of the layout.

   To publish one, add an entry with the customer's own words, their name and
   role, the company, and their logo in /public/logos. Keep the written
   permission somewhere you can find it. */

export type Testimonial = {
  /** One line, set large — the customer's own words. */
  headline: string;
  /** The longer quote under it. */
  quote: string;
  name: string;
  role: string;
  company: string;
  /** Path under /public, e.g. "/logos/acme.svg". Optional. */
  logo?: string;
};

export const TESTIMONIALS: Testimonial[] = [];
