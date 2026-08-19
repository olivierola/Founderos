import { useEffect } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, Quote } from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { ClosingCta, HeroField, frameFromSeed, tintFromKey, useLandingSkin } from "./PageHero";
import { CtaGhost, CtaPrimary, Reveal } from "./LandingKit";
import { HERO_BG } from "./LandingHero";
import { POSTS_BY_DATE, formatDate, getPost, type Block, type Post } from "./blogPosts";

/* ===================== One post =====================
   A reading page, so the design steps back: no shader field behind the title,
   one measure of text, and the only colour is the post's own cover key. The
   nav, the closing slab and the footer stay exactly as they are everywhere
   else — the article is a page of the site, not a microsite. */

/* One renderer per block shape. The vocabulary is closed (see blogPosts.ts), so
   an article can never introduce a layout the design system has not sized. */
function BlockView({ block, accent }: { block: Block; accent: string }) {
  switch (block.type) {
    case "h2":
      return (
        <h2 className="mt-14 text-balance text-[26px] font-semibold leading-[1.2] tracking-[-0.02em] text-[#000007] sm:text-[30px]">
          {block.text}
        </h2>
      );

    case "p":
      return <p className="mt-6 text-[17.5px] leading-[1.75] text-black/70">{block.text}</p>;

    case "list":
      return (
        <ul className="mt-7 space-y-4">
          {block.items.map((item) => (
            <li key={item} className="flex gap-4">
              {/* A rule rather than a bullet — it lines the items up against the
                  measure instead of hanging outside it. */}
              <span
                aria-hidden
                className="mt-[0.7em] h-px w-5 shrink-0"
                style={{ background: accent }}
              />
              <span className="text-[16.5px] leading-[1.7] text-black/70">{item}</span>
            </li>
          ))}
        </ul>
      );

    case "quote":
      return (
        <figure className="mt-12 border-l-2 pl-7" style={{ borderColor: accent }}>
          <Quote className="h-5 w-5" style={{ color: accent }} />
          <blockquote className="mt-4 text-balance text-[21px] font-medium leading-[1.45] tracking-[-0.015em] text-[#000007] sm:text-[24px]">
            {block.text}
          </blockquote>
          {block.by && (
            <figcaption className="mt-4 text-[13.5px] text-black/45">{block.by}</figcaption>
          )}
        </figure>
      );

    case "callout":
      return (
        <aside className="mt-12 rounded-2xl bg-[#f2f2f2] px-7 py-7">
          <div className="text-[12px] uppercase tracking-[0.12em]" style={{ color: accent }}>
            {block.title}
          </div>
          <p className="mt-3 text-[16.5px] leading-[1.65] text-[#0d0d0d]">{block.text}</p>
        </aside>
      );
  }
}

function RelatedCard({ post }: { post: Post }) {
  return (
    <Link
      to={`/blog/${post.slug}`}
      className="amp-card-light amp-lift group flex h-full flex-col overflow-hidden rounded-2xl p-6 hover:shadow-lg"
    >
      <div className="flex items-center gap-2 text-[12px] text-black/45">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: post.cover[0] }}
          aria-hidden
        />
        {post.category}
        <span className="h-1 w-1 rounded-full bg-black/20" />
        {post.readMinutes} min
      </div>
      <h3 className="mt-3 flex-1 text-balance text-[18px] font-semibold leading-[1.25] tracking-[-0.015em] text-[#000007]">
        {post.title}
      </h3>
      <span className="mt-5 inline-flex items-center gap-1.5 text-[14px] text-black/55 transition-colors group-hover:text-black">
        Read
        <ArrowUpRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </span>
    </Link>
  );
}

export function BlogPostPage() {
  useLandingSkin();
  const { slug } = useParams();
  const post = getPost(slug);

  // Router keeps the scroll position between routes, so moving from one article
  // to another would otherwise drop you mid-paragraph of a piece you never read.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [slug]);

  if (!post) return <Navigate to="/blog" replace />;

  const accent = post.cover[0];
  // Same category first, then whatever is most recent — never the post itself.
  const related = POSTS_BY_DATE.filter((p) => p.slug !== post.slug)
    .sort((a, b) => Number(b.category === post.category) - Number(a.category === post.category))
    .slice(0, 3);

  return (
    <div className="amplify amp-light min-h-screen overflow-x-hidden bg-white">
      <LandingNav />

      {/* ══ Title block ══════════════════════════════════════════════════════
          The same animated field as every other page, keyed to this post: its
          own cover colour, lifted to clear the nav, and a frame seeded from the
          slug so no two articles compose alike. The layout stays the article's
          own, left-aligned on the reading measure, which is why the field is
          mounted directly rather than through PageHero's centred variant. */}
      <header className="relative overflow-hidden pt-[104px]" style={{ background: HERO_BG }}>
        <HeroField hue={tintFromKey(accent)} frame={frameFromSeed(post.slug)} />
        <div className="relative mx-auto max-w-[760px] px-4 py-16 sm:px-6 sm:py-20">
          <Link
            to="/blog"
            className="inline-flex items-center gap-2 text-[14px] text-black/50 transition-colors hover:text-black"
          >
            <ArrowLeft className="h-4 w-4" />
            All posts
          </Link>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <span
              className="rounded-full px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-white"
              style={{ background: accent }}
            >
              {post.category}
            </span>
            <span className="text-[13px] text-black/45">
              <time dateTime={post.date}>{formatDate(post.date)}</time> · {post.readMinutes} min read
            </span>
          </div>

          <h1 className="mt-6 text-balance text-[36px] font-semibold leading-[1.08] tracking-[-0.03em] text-[#000007] sm:text-[50px]">
            {post.title}
          </h1>
          <p className="mt-6 text-[18px] leading-[1.6] text-black/60">{post.excerpt}</p>

          <div className="mt-10 flex items-center gap-3 border-t border-black/[0.08] pt-7">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1e1e22] text-[12px] font-semibold text-white">
              {post.author.initials}
            </span>
            <span className="text-[14px]">
              <span className="block font-medium text-[#000007]">{post.author.name}</span>
              <span className="block text-black/45">{post.author.role}</span>
            </span>
          </div>
        </div>
      </header>

      {/* ══ Body ═════════════════════════════════════════════════════════════ */}
      <article className="amp-light relative bg-white">
        <div className="mx-auto max-w-[760px] px-4 py-16 sm:px-6 sm:py-20">
          {post.body.map((block, i) => (
            <BlockView key={i} block={block} accent={accent} />
          ))}

          <div className="mt-16 border-t border-black/[0.08] pt-8">
            <p className="text-[15px] leading-[1.6] text-black/55">
              Written by <span className="font-medium text-[#000007]">{post.author.name}</span>,{" "}
              {post.author.role} at Anduran. Questions about anything here?{" "}
              <Link to="/contact" className="text-[#000007] underline underline-offset-4">
                Talk to us
              </Link>
              .
            </p>
          </div>
        </div>
      </article>

      {/* ══ Related ══════════════════════════════════════════════════════════ */}
      <section className="amp-light relative" style={{ background: "#f7f7f7" }}>
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative py-20">
            <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-[#000007]">
              Keep reading
            </h2>
            <Reveal delay={80} className="mt-8 grid gap-5 sm:grid-cols-3">
              {related.map((p) => (
                <RelatedCard key={p.slug} post={p} />
              ))}
            </Reveal>
          </div>
        </div>
      </section>

      {/* Indigo, not the post's own colour: the article header is keyed to the
          piece, but the closing slab belongs to the journal as a section. */}
      <ClosingCta
        hue="indigo"
        eyebrow="Get Started"
        title="Want this applied to your own stack?"
        lead="Thirty minutes is usually enough to tell whether the problem in this post is the problem you actually have."
        actions={
          <>
            <Link to="/contact">
              <CtaPrimary>Book a Consultation</CtaPrimary>
            </Link>
            <Link to="/solutions">
              <CtaGhost>See our solutions</CtaGhost>
            </Link>
          </>
        }
      />

      <LandingFooter />
    </div>
  );
}
