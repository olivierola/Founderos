import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Search } from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { PageHero, ctaWash, useLandingSkin } from "./PageHero";
import { Eyebrow, Reveal } from "./LandingKit";
import { CATEGORIES, POSTS_BY_DATE, formatDate, type Post } from "./blogPosts";

/* ===================== Blog =====================
   Three densities, not one grid. An earlier cut ran every post through the same
   card, which made a seven-post archive look like a product catalogue and gave
   the newest piece exactly as much weight as the oldest.

   Now the shelf falls off: the latest post gets a full-width spread, the next
   two get cards, and the rest are text rows on hairlines with no art at all.
   That is an index, and an index is what a reader scanning for one article
   actually wants. Filtering collapses everything to the row form, because once
   you are searching there is no "latest" to feature. */

/* Cover art, generated per post from its two-stop key: a diagonal wash plus the
   masked band pattern the dark slabs use, so the covers belong to the same
   family as the rest of the site instead of looking like stock photography. */
function Cover({ post, className = "" }: { post: Post; className?: string }) {
  const [from, to] = post.cover;
  return (
    <div
      className={`amp-grain relative overflow-hidden ${className}`}
      style={{ background: `linear-gradient(135deg, ${to} 0%, ${from} 100%)` }}
    >
      <div
        aria-hidden
        className="amp-bands absolute inset-0 opacity-[0.35]"
        style={{
          WebkitMaskImage: "radial-gradient(ellipse 70% 90% at 80% 20%, #000, transparent 70%)",
          maskImage: "radial-gradient(ellipse 70% 90% at 80% 20%, #000, transparent 70%)",
        }}
      />
    </div>
  );
}

function Byline({ post, className = "" }: { post: Post; className?: string }) {
  return (
    <div className={"flex items-center gap-2.5 " + className}>
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#1e1e22] text-[11px] font-semibold text-white">
        {post.author.initials}
      </span>
      <span className="text-[13px] text-black/55">
        {post.author.name}
        <span className="text-black/35"> · {post.author.role}</span>
      </span>
    </div>
  );
}

/** Density two: a card, for the two posts behind the lead. */
function PostCard({ post }: { post: Post }) {
  return (
    <Link
      to={`/blog/${post.slug}`}
      className="amp-lift group flex h-full flex-col overflow-hidden rounded-[22px] bg-[#f7f7f7]"
    >
      <Cover post={post} className="aspect-[16/9]" />
      <div className="flex flex-1 flex-col p-7">
        <div className="flex items-center gap-2 text-[12.5px] text-black/45">
          <span style={{ color: post.cover[0] }}>{post.category}</span>
          <span className="h-1 w-1 rounded-full bg-black/20" />
          <span>{post.readMinutes} min</span>
        </div>
        <h3 className="mt-3 text-balance text-[21px] font-semibold leading-[1.2] tracking-[-0.018em] text-[#000007]">
          {post.title}
        </h3>
        <p className="mt-3 flex-1 text-[14.5px] leading-[1.6] text-[var(--amp-muted)]">
          {post.excerpt}
        </p>
        <span className="mt-6 inline-flex items-center gap-1.5 text-[14px] font-medium text-[#000007]">
          Read
          <ArrowUpRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </span>
      </div>
    </Link>
  );
}

/** Density three: a row. No art, just what you need to decide. */
function PostRow({ post }: { post: Post }) {
  return (
    <Link
      to={`/blog/${post.slug}`}
      className="group grid items-baseline gap-x-8 gap-y-2 border-b border-black/[0.08] py-7 sm:grid-cols-[110px_1fr_auto]"
    >
      <span className="text-[13px] tabular-nums text-black/40">
        <time dateTime={post.date}>{formatDate(post.date)}</time>
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ background: post.cover[0] }}
          />
          <span className="text-[11px] uppercase tracking-[0.12em] text-black/35">
            {post.category}
          </span>
        </span>
        <span className="mt-2 block text-balance text-[20px] font-medium leading-[1.25] tracking-[-0.015em] text-[#000007] transition-colors group-hover:text-black">
          {post.title}
        </span>
        <span className="mt-2 block max-w-2xl text-[14.5px] leading-[1.55] text-black/50">
          {post.excerpt}
        </span>
      </span>
      <span className="flex items-center gap-3 text-[13px] text-black/40">
        {post.readMinutes} min
        <ArrowUpRight className="h-4 w-4 opacity-0 transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100" />
      </span>
    </Link>
  );
}

export function BlogPage() {
  useLandingSkin();

  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");

  // The tiered shelf only makes sense on the full archive. Once you have
  // filtered, there is no "latest", so everything collapses to rows.
  const filtering = category !== "all" || query.trim().length > 0;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return POSTS_BY_DATE.filter((p) => {
      if (category !== "all" && p.category !== category) return false;
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        p.excerpt.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      );
    });
  }, [category, query]);

  // Sliced rather than destructured so a shorter archive degrades instead of
  // handing `undefined` to a card.
  const lead = POSTS_BY_DATE[0];
  const cards = POSTS_BY_DATE.slice(1, 3);
  const rest = POSTS_BY_DATE.slice(3);

  return (
    <div className="amplify amp-light min-h-screen overflow-x-hidden bg-white">
      <LandingNav />

      <PageHero
        eyebrow="Journal"
        title="Field notes on adopting AI"
        lead="What we learn running agents inside real companies: the governance arguments, the adoption dead ends, and the engineering that keeps a pilot from becoming a story."
        hue="indigo"
        frame={3910}
        padBottom={60}
      >
        <div className="relative mx-auto mt-10 max-w-md">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-black/35" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the journal…"
            aria-label="Search the journal"
            className="h-12 w-full rounded-full border border-black/[0.08] bg-white/80 pl-11 pr-4 text-[15px] text-[#000007] shadow-[0_10px_30px_-18px_rgba(0,0,7,0.35)] outline-none backdrop-blur-xl transition-colors placeholder:text-black/35 focus:border-black/20"
          />
        </div>
      </PageHero>

      {/* ══ Density one: the latest piece, full width ════════════════════════ */}
      {!filtering && lead && (
        <section className="amp-light relative bg-white">
          <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
            <div className="amp-rails relative pb-20">
              <Reveal>
                <Link to={`/blog/${lead.slug}`} className="amp-zoom group block">
                  <div className="relative overflow-hidden rounded-[28px]">
                    <Cover post={lead} className="h-[300px] sm:h-[420px]" />
                    {/* The wash lands mid-tone at the bottom-left, which is
                        exactly where the title sits, so it gets its own scrim
                        rather than relying on whichever key the post carries. */}
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/70 via-black/25 to-transparent"
                    />
                    <div className="absolute inset-x-0 bottom-0 p-8 sm:p-12">
                      <Eyebrow>Latest</Eyebrow>
                      <h2 className="mt-6 max-w-3xl text-balance text-[32px] font-semibold leading-[1.06] tracking-[-0.028em] text-white sm:text-[46px]">
                        {lead.title}
                      </h2>
                    </div>
                  </div>
                  <div className="mt-7 grid gap-6 sm:grid-cols-[1fr_auto] sm:items-end">
                    <p className="max-w-2xl text-[17px] leading-[1.6] text-[var(--amp-muted)]">
                      {lead.excerpt}
                    </p>
                    <span className="inline-flex items-center gap-1.5 text-[15px] font-medium text-[#000007]">
                      Read the piece
                      <ArrowUpRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                    </span>
                  </div>
                  <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-black/[0.08] pt-6">
                    <Byline post={lead} />
                    <span className="text-[13px] text-black/35">
                      <time dateTime={lead.date}>{formatDate(lead.date)}</time> ·{" "}
                      {lead.readMinutes} min read
                    </span>
                  </div>
                </Link>
              </Reveal>
            </div>
          </div>
        </section>
      )}

      {/* ══ Density two: two cards ══════════════════════════════════════════ */}
      {!filtering && cards.length > 0 && (
        <section className="amp-light relative bg-white">
          <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
            <div className="amp-rails relative grid gap-6 pb-20 lg:grid-cols-2">
              {cards.map((p, i) => (
                <Reveal key={p.slug} delay={i * 110}>
                  <PostCard post={p} />
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ══ Density three: the index ════════════════════════════════════════ */}
      <section className="amp-light relative" style={{ background: "#f7f7f7" }}>
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative py-20 sm:py-24">
            <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-5">
              <h2 className="text-[13px] font-medium uppercase tracking-[0.14em] text-black/40">
                {filtering ? `${matches.length} ${matches.length === 1 ? "post" : "posts"}` : "Everything else"}
              </h2>
              {/* Filters live with the index they filter, not stranded up under
                  the hero where they read as a second navbar. */}
              <div className="flex flex-wrap items-center gap-1.5">
                {["all", ...CATEGORIES].map((c) => (
                  <button
                    key={c}
                    onClick={() => setCategory(c)}
                    className={
                      "rounded-full px-3.5 py-1.5 text-[13px] transition-colors " +
                      (category === c
                        ? "bg-[#2b2b2b] text-white"
                        : "text-black/55 hover:bg-black/[0.06] hover:text-black")
                    }
                  >
                    {c === "all" ? "All" : c}
                  </button>
                ))}
              </div>
            </div>

            {(filtering ? matches : rest).length > 0 ? (
              <Reveal delay={80} className="mt-10 border-t border-black/[0.08]">
                {(filtering ? matches : rest).map((p) => (
                  <PostRow key={p.slug} post={p} />
                ))}
              </Reveal>
            ) : (
              <div className="mt-10 rounded-[24px] bg-white px-8 py-16 text-center">
                <p className="text-[19px] font-medium text-[#000007]">Nothing here yet.</p>
                <p className="mx-auto mt-3 max-w-sm text-[15px] leading-[1.6] text-[var(--amp-muted)]">
                  No post matches that search. Try another term, or clear the filters to see
                  everything we have written.
                </p>
                <button
                  onClick={() => {
                    setQuery("");
                    setCategory("all");
                  }}
                  className="mt-8 rounded-full bg-[#2b2b2b] px-6 py-3 text-[14.5px] font-medium text-white transition-colors hover:bg-[#0d0d0d]"
                >
                  Clear filters
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ══ Newsletter, in the floating dark slab's short form ═══════════════ */}
      <div className="relative px-3 py-3 sm:px-5 sm:py-5" style={{ background: "#e4e4e4" }}>
        <section className="relative overflow-hidden rounded-[28px] bg-[#08080a] sm:rounded-[36px]">
          {/* The journal's own key, same as its hero: this slab is the page's
              closing band, so it follows the page and not the brand default. */}
          <div
            aria-hidden
            className="amp-wash-drift pointer-events-none absolute inset-0"
            style={{ background: ctaWash("indigo") }}
          />
          <div className="relative mx-auto max-w-[1280px] px-4 sm:px-8">
            <div className="amp-rails relative grid items-center gap-10 py-20 lg:grid-cols-[1fr_auto]">
              <div>
                <Eyebrow>Subscribe</Eyebrow>
                <h2 className="mt-6 max-w-xl text-balance text-[28px] font-semibold leading-[1.12] tracking-[-0.025em] sm:text-[36px]">
                  One note a month, when we have learned something worth sending
                </h2>
                <p className="mt-4 max-w-lg text-[15.5px] leading-[1.6] text-[var(--amp-muted)]">
                  No product announcements, no drip sequence. Unsubscribe in one click.
                </p>
              </div>
              <form
                className="flex w-full flex-col gap-3 sm:flex-row lg:w-[420px]"
                onSubmit={(e) => e.preventDefault()}
              >
                <input
                  type="email"
                  required
                  placeholder="you@company.com"
                  aria-label="Email address"
                  className="h-12 flex-1 rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 text-[15px] text-white outline-none transition-colors placeholder:text-white/35 focus:border-white/30"
                />
                <button className="h-12 shrink-0 rounded-xl bg-[var(--amp-accent)] px-7 text-[15px] font-medium text-[var(--amp-on-accent)] transition-opacity hover:opacity-90">
                  Subscribe
                </button>
              </form>
            </div>
          </div>
        </section>
      </div>

      <LandingFooter />
    </div>
  );
}
