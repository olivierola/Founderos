import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRightIcon as ArrowUpRight,
  MagnifyingGlassIcon as Search,
} from "@phosphor-icons/react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { LandingClose } from "./LandingClose";
import { Reveal } from "./LandingKit";
import { PaperHero } from "./PaperHero";
import { CornerMarks, MonoLabel, PAPER_ACCENT, SectionTitle } from "./PaperKit";
import { ToneCanvas, ToneSection } from "./LandingTone";
import { CATEGORIES, POSTS_BY_DATE, formatDate, type Post } from "./blogPosts";

/* ═══ Blog ═══════════════════════════════════════════════════════════════════
   Rebuilt onto the same system as the home and pricing pages: one tone canvas
   behind everything, the paper hero on top, register marks and hairlines rather
   than rounded cards, and the one blue as the only colour.

   What went, and why:

   · the generated cover art. Every post carried a two-stop gradient plate, which
     was the old generation's way of making an index look full. On a site whose
     palette is black, white, greys and one blue, seven coloured gradients were
     the loudest thing on any page — and they were decoration standing in for
     information. The post's key colour survives as a single small mark;
   · the rounded cards. Pricing compares things in hairline-separated columns and
     the home page stacks plates with corner marks; a 22px-radius card belonged
     to neither;
   · the floating dark newsletter slab with its own hue. The page now closes the
     way every other page closes.

   The three densities stay, because they were the right idea: the newest piece
   gets a spread, the next two get plates, the rest are rows. Filtering collapses
   everything to rows — once you are searching there is no "latest".           */

const INK = "#111111";
const GREY = "#777777";
const RULE = "rgba(17,17,17,0.12)";

/** The post's key, reduced to one mark. It is a label, not a surface. */
function CategoryMark({ post }: { post: Post }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="h-[7px] w-[7px] shrink-0" style={{ background: post.cover[0] }} />
      <span className="font-mono text-[11px] uppercase tracking-[0.11em]" style={{ color: GREY }}>
        {post.category}
      </span>
    </span>
  );
}

function Byline({ post }: { post: Post }) {
  return (
    <span className="flex items-center gap-2.5">
      <span
        className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-semibold text-white"
        style={{ background: INK }}
      >
        {post.author.initials}
      </span>
      <span className="text-[13px]" style={{ color: GREY }}>
        <span style={{ color: INK }}>{post.author.name}</span> · {post.author.role}
      </span>
    </span>
  );
}

/** Density two: a plate, for the two pieces behind the lead. */
function PostPlate({ post }: { post: Post }) {
  return (
    <Link
      to={`/blog/${post.slug}`}
      className="group relative flex h-full flex-col bg-[#F7F7F7] p-8 transition-colors duration-300 hover:bg-[#F1F1F1]"
    >
      <CornerMarks />
      <CategoryMark post={post} />
      <h3
        className="mt-5 text-balance text-[24px] font-normal leading-[1.15] tracking-[-0.028em] sm:text-[27px]"
        style={{ color: INK }}
      >
        {post.title}
      </h3>
      <p className="mt-4 flex-1 text-[14.5px] leading-[1.6]" style={{ color: GREY }}>
        {post.excerpt}
      </p>
      <span
        className="mt-8 flex items-center justify-between border-t pt-5 text-[13.5px]"
        style={{ borderColor: RULE, color: GREY }}
      >
        <span>
          <time dateTime={post.date}>{formatDate(post.date)}</time> · {post.readMinutes} min
        </span>
        <span className="inline-flex items-center gap-1.5" style={{ color: PAPER_ACCENT }}>
          Read
          <ArrowUpRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </span>
      </span>
    </Link>
  );
}

/** Density three: a row. No art, just what you need to decide. */
function PostRow({ post }: { post: Post }) {
  return (
    <Link
      to={`/blog/${post.slug}`}
      className="group grid items-baseline gap-x-8 gap-y-2 border-b py-7 sm:grid-cols-[120px_1fr_auto]"
      style={{ borderColor: RULE }}
    >
      <span className="font-mono text-[11.5px] tabular-nums" style={{ color: GREY }}>
        <time dateTime={post.date}>{formatDate(post.date)}</time>
      </span>
      <span className="min-w-0">
        <CategoryMark post={post} />
        <span
          className="mt-2.5 block text-balance text-[20px] font-normal leading-[1.25] tracking-[-0.022em]"
          style={{ color: INK }}
        >
          {post.title}
        </span>
        <span className="mt-2 block max-w-2xl text-[14.5px] leading-[1.55]" style={{ color: GREY }}>
          {post.excerpt}
        </span>
      </span>
      <span className="flex items-center gap-3 text-[13px]" style={{ color: GREY }}>
        {post.readMinutes} min
        <ArrowUpRight className="h-4 w-4 opacity-0 transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100" />
      </span>
    </Link>
  );
}

export function BlogPage() {
  useEffect(() => {
    document.documentElement.classList.add("mkt-no-scrollbar", "amp-root");
    return () => document.documentElement.classList.remove("mkt-no-scrollbar", "amp-root");
  }, []);

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
  // handing `undefined` to a plate.
  const lead = POSTS_BY_DATE[0];
  const plates = POSTS_BY_DATE.slice(1, 3);
  const rest = POSTS_BY_DATE.slice(3);
  const index = filtering ? matches : rest;

  return (
    <div className="amplify min-h-screen text-white" style={{ backgroundColor: "transparent" }}>
      <LandingNav />

      <ToneCanvas initial="paper">
        <ToneSection tone="paper">
          <PaperHero
            label="Journal"
            frame={["Field notes on"]}
            claim="adopting AI in public"
            lead="What we learn running agents inside real companies: the governance arguments, the adoption dead ends, and the engineering that keeps a pilot from becoming a story."
            tiles={["adopt", "scale"]}
          >
            <div className="relative mx-auto max-w-md">
              <Search
                className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2"
                style={{ color: GREY }}
              />
              {/* Square and hairlined, like the pricing controls. A pill with a
                  blur belonged to the generation this page just left. */}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the journal…"
                aria-label="Search the journal"
                className="h-12 w-full border bg-white pl-11 pr-4 text-[15px] outline-none transition-colors placeholder:text-[#9A9A9A] focus:border-[#176995]"
                style={{ borderColor: RULE, color: INK }}
              />
            </div>
          </PaperHero>
        </ToneSection>

        {/* ══ Density one: the latest piece ═══════════════════════════════ */}
        {!filtering && lead && (
          <ToneSection tone="paper">
            <div className="mx-auto max-w-[1420px] px-5 pb-24 sm:px-9 sm:pb-28" style={{ color: INK }}>
              <Reveal>
                <Link to={`/blog/${lead.slug}`} className="group relative block bg-[#F7F7F7] p-8 sm:p-12">
                  {/* The one accent-marked surface on the page: the lead piece
                      is the only thing here being pointed at. */}
                  <CornerMarks accent />
                  <div className="grid gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16">
                    <div>
                      <MonoLabel>Latest · {lead.category}</MonoLabel>
                      <h2
                        className="mt-6 max-w-[18ch] text-balance text-[34px] font-normal leading-[1.06] tracking-[-0.035em] sm:text-[46px] lg:text-[54px]"
                        style={{ color: INK }}
                      >
                        {lead.title}
                      </h2>
                      <span
                        className="mt-8 inline-flex items-center gap-2 text-[15px]"
                        style={{ color: PAPER_ACCENT }}
                      >
                        Read the piece
                        <ArrowUpRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                      </span>
                    </div>

                    <div className="flex flex-col justify-end">
                      <p
                        className="font-instrument-serif text-[20px] leading-[1.5] sm:text-[22px]"
                        style={{ color: "#3A3A3A" }}
                      >
                        {lead.excerpt}
                      </p>
                      <div
                        className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3 border-t pt-6"
                        style={{ borderColor: RULE }}
                      >
                        <Byline post={lead} />
                        <span className="text-[13px]" style={{ color: GREY }}>
                          <time dateTime={lead.date}>{formatDate(lead.date)}</time> ·{" "}
                          {lead.readMinutes} min read
                        </span>
                      </div>
                    </div>
                  </div>
                </Link>
              </Reveal>
            </div>
          </ToneSection>
        )}

        {/* ══ Density two: two plates ═════════════════════════════════════ */}
        {!filtering && plates.length > 0 && (
          <ToneSection tone="paper">
            <div className="mx-auto max-w-[1420px] px-5 pb-24 sm:px-9 sm:pb-28">
              <div className="grid gap-5 lg:grid-cols-2">
                {plates.map((p, i) => (
                  <Reveal key={p.slug} delay={i * 110} className="h-full">
                    <PostPlate post={p} />
                  </Reveal>
                ))}
              </div>
            </div>
          </ToneSection>
        )}

        {/* ══ Density three: the index ════════════════════════════════════ */}
        <ToneSection tone="bone">
          <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28" style={{ color: INK }}>
            <Reveal>
              <SectionTitle
                frame={filtering ? "Matching your search" : "Everything else"}
                claim={`${index.length} ${index.length === 1 ? "piece" : "pieces"}`}
                flip
              />
            </Reveal>

            {/* Filters live with the index they filter, not stranded under the
                hero where they read as a second navbar. Square segments, like
                the pricing billing switch. */}
            <Reveal delay={60}>
              <div className="mt-10 flex flex-wrap items-center gap-1.5 border p-1.5" style={{ borderColor: RULE, width: "fit-content" }}>
                {["all", ...CATEGORIES].map((c) => (
                  <button
                    key={c}
                    onClick={() => setCategory(c)}
                    aria-pressed={category === c}
                    className="px-4 py-2 text-[13.5px] transition-colors"
                    style={
                      category === c
                        ? { background: INK, color: "#FFFFFF" }
                        : { color: GREY }
                    }
                  >
                    {c === "all" ? "All" : c}
                  </button>
                ))}
              </div>
            </Reveal>

            {index.length > 0 ? (
              <Reveal delay={80} className="mt-12">
                <div className="border-t" style={{ borderColor: RULE }}>
                  {index.map((p) => (
                    <PostRow key={p.slug} post={p} />
                  ))}
                </div>
              </Reveal>
            ) : (
              <div className="relative mt-12 bg-white px-8 py-16 text-center">
                <CornerMarks />
                <p className="text-[19px]" style={{ color: INK }}>
                  Nothing here yet.
                </p>
                <p className="mx-auto mt-3 max-w-sm text-[15px] leading-[1.6]" style={{ color: GREY }}>
                  No post matches that search. Try another term, or clear the filters to see everything
                  we have written.
                </p>
                <button
                  onClick={() => {
                    setQuery("");
                    setCategory("all");
                  }}
                  className="mt-8 px-6 py-3 text-[14.5px] font-medium text-white transition-opacity hover:opacity-85"
                  style={{ background: INK }}
                >
                  Clear filters
                </button>
              </div>
            )}
          </div>
        </ToneSection>

        {/* ══ Subscribe ═══════════════════════════════════════════════════ */}
        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1420px] px-5 pb-24 sm:px-9 sm:pb-28" style={{ color: INK }}>
            <Reveal>
              <div className="relative grid items-end gap-10 bg-[#F7F7F7] p-8 sm:p-12 lg:grid-cols-[1fr_420px]">
                <CornerMarks />
                <div>
                  <MonoLabel>Subscribe</MonoLabel>
                  <h2
                    className="mt-5 max-w-[22ch] text-balance text-[28px] font-normal leading-[1.1] tracking-[-0.03em] sm:text-[36px]"
                    style={{ color: INK }}
                  >
                    One note a month, when we have learned something worth sending
                  </h2>
                  <p className="mt-4 max-w-lg text-[15px] leading-[1.6]" style={{ color: GREY }}>
                    No product announcements, no drip sequence. Unsubscribe in one click.
                  </p>
                </div>
                <form className="flex w-full flex-col gap-2.5 sm:flex-row" onSubmit={(e) => e.preventDefault()}>
                  <input
                    type="email"
                    required
                    placeholder="you@company.com"
                    aria-label="Email address"
                    className="h-12 flex-1 border bg-white px-4 text-[15px] outline-none transition-colors placeholder:text-[#9A9A9A] focus:border-[#176995]"
                    style={{ borderColor: RULE, color: INK }}
                  />
                  <button
                    className="h-12 shrink-0 px-7 text-[15px] font-medium text-white transition-opacity hover:opacity-85"
                    style={{ background: PAPER_ACCENT }}
                  >
                    Subscribe
                  </button>
                </form>
              </div>
            </Reveal>
          </div>
        </ToneSection>

        <LandingClose />

        <ToneSection tone="ink">
          <LandingFooter band="transparent" />
        </ToneSection>
      </ToneCanvas>
    </div>
  );
}
