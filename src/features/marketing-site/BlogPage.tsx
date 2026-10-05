import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MagnifyingGlassIcon as Search } from "@phosphor-icons/react";
import { CATEGORIES, POSTS_BY_DATE, formatDate } from "./blogPosts";
import { HnPage } from "./hn/HnPage";
import { ArtPanel, Btn, Chip, Container, H, P } from "./hn/HnKit";
import { CATEGORY_ART } from "./hn/site";

/* ═══ Blog ═══════════════════════════════════════════════════════════════════
   hunar.ai's "All Articles": a big title and its line on the off-white ground,
   a row of category buttons (the active one blue), then one ruled row per
   article — thumbnail, category chip and date, title, "Read article".

   Thumbnails are artwork keyed by category, so the shelf reads as a set.
   The search box is ours: with a handful of articles it costs nothing, and it
   filters what is actually written.

   The previous page carried a newsletter form whose submit did nothing. It is
   gone rather than restyled: a form that accepts an email and drops it is a
   promise we do not keep. */

export function BlogPage() {
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");

  const posts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return POSTS_BY_DATE.filter((p) => {
      if (category !== "all" && p.category !== category) return false;
      if (!q) return true;
      return [p.title, p.excerpt, p.category].join(" ").toLowerCase().includes(q);
    });
  }, [category, query]);

  return (
    <HnPage>
      <section className="bg-[#f7f8fb]">
        <Container className="pb-24 pt-16 lg:pt-24">
          <H as="h1" size="hero">All articles</H>
          <P className="mt-4 max-w-[640px]">
            What we learn putting Cloud collaborators to work on real systems: the governance arguments, the adoption dead ends,
            and the engineering that keeps a pilot from becoming a story.
          </P>

          <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2">
              {["all", ...CATEGORIES].map((c) => {
                const active = category === c;
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setCategory(c)}
                    className={`rounded-full border px-3.5 py-2 text-[16px] font-medium leading-none tracking-[-0.02em] transition-colors ${
                      active ? "border-[#006edd] bg-[#006edd] text-white" : "border-[#e6e9ef] bg-white text-[#0f1728] hover:border-[#cfd5df]"
                    }`}
                  >
                    {c === "all" ? "All articles" : c}
                  </button>
                );
              })}
            </div>
            <div className="relative w-full sm:max-w-[280px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8a94a6]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search articles"
                placeholder="Search articles…"
                className="h-10 w-full rounded-full border border-[#e6e9ef] bg-white pl-9 pr-3 text-[16px] text-[#0f1728] outline-none transition-colors placeholder:text-[#8a94a6] focus:border-[#006edd]"
              />
            </div>
          </div>

          <div className="mt-14">
            {posts.length === 0 ? (
              <p className="border-t border-[#e6e9ef] py-10 text-[18px] text-[#4b5567]">
                Nothing matches yet. Try another category or a shorter search.
              </p>
            ) : (
              posts.map((p) => (
                <article key={p.slug} className="grid gap-6 border-b border-[#e6e9ef] py-6 first:pt-0 sm:grid-cols-[300px_1fr]">
                  <Link to={`/blog/${p.slug}`} aria-hidden tabIndex={-1}>
                    <ArtPanel art={CATEGORY_ART[p.category] ?? "blue"} className="h-[150px] rounded-[20px]" />
                  </Link>
                  <div className="flex flex-col justify-center">
                    <div className="flex items-center gap-4">
                      <Chip className="px-2.5 py-1.5 text-[14px]">{p.category}</Chip>
                      <span className="text-[16px] font-medium tracking-[-0.02em] text-[#4b5567]">{formatDate(p.date)}</span>
                    </div>
                    <Link
                      to={`/blog/${p.slug}`}
                      className="mt-4 max-w-[750px] text-[18px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728] transition-colors hover:text-[#006edd]"
                    >
                      {p.title}
                    </Link>
                    <p className="mt-2 max-w-[750px] text-[16px] leading-[1.4] text-[#4b5567]">{p.excerpt}</p>
                    <Btn to={`/blog/${p.slug}`} variant="link" className="mt-4 self-start">
                      Read article
                    </Btn>
                  </div>
                </article>
              ))
            )}
          </div>
        </Container>
      </section>
    </HnPage>
  );
}
