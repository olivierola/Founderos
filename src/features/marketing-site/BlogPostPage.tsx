import { useEffect } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowUpRightIcon as ArrowUpRight,
  QuotesIcon as Quote,
} from "@phosphor-icons/react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { LandingClose } from "./LandingClose";
import { Reveal } from "./LandingKit";
import { RegisterMarks } from "./PaperHero";
import { CornerMarks, MonoLabel, PAPER_ACCENT, SectionTitle } from "./PaperKit";
import { ToneCanvas, ToneSection } from "./LandingTone";
import { POSTS_BY_DATE, formatDate, getPost, type Block, type Post } from "./blogPosts";

/* ═══ One post ═══════════════════════════════════════════════════════════════
   A reading page, on the same canvas as every other page. The design steps back
   further here than anywhere else on the site — one measure of text, no
   collage, no typed line — because the only job is to be read.

   The post's own key colour survives in exactly two places: the category mark
   at the top and the rules beside pull-quotes and list items. Everything else
   is the site's ink, greys and the one blue. An earlier cut keyed the whole
   header to the post, which made seven articles look like seven microsites. */

const INK = "#111111";
const GREY = "#777777";
const RULE = "rgba(17,17,17,0.12)";

/* One renderer per block shape. The vocabulary is closed (see blogPosts.ts), so
   an article can never introduce a layout the design system has not sized. */
function BlockView({ block, accent }: { block: Block; accent: string }) {
  switch (block.type) {
    case "h2":
      return (
        <h2
          className="mt-14 text-balance text-[26px] font-normal leading-[1.18] tracking-[-0.03em] sm:text-[31px]"
          style={{ color: INK }}
        >
          {block.text}
        </h2>
      );

    case "p":
      return (
        <p className="mt-6 text-[17.5px] leading-[1.75]" style={{ color: "#3A3A3A" }}>
          {block.text}
        </p>
      );

    case "list":
      return (
        <ul className="mt-7 space-y-4">
          {block.items.map((item) => (
            <li key={item} className="flex gap-4">
              {/* A rule rather than a bullet — it lines the items up against the
                  measure instead of hanging outside it. */}
              <span aria-hidden className="mt-[0.7em] h-px w-5 shrink-0" style={{ background: accent }} />
              <span className="text-[16.5px] leading-[1.7]" style={{ color: "#3A3A3A" }}>
                {item}
              </span>
            </li>
          ))}
        </ul>
      );

    case "quote":
      return (
        <figure className="mt-12 border-l-2 pl-7" style={{ borderColor: accent }}>
          <Quote className="h-5 w-5" style={{ color: accent }} />
          <blockquote
            className="mt-4 text-balance font-instrument-serif text-[23px] leading-[1.4] sm:text-[27px]"
            style={{ color: INK }}
          >
            {block.text}
          </blockquote>
          {block.by && (
            <figcaption className="mt-4 text-[13.5px]" style={{ color: GREY }}>
              {block.by}
            </figcaption>
          )}
        </figure>
      );

    case "callout":
      return (
        <aside className="relative mt-12 bg-[#F7F7F7] px-7 py-7">
          <CornerMarks />
          <MonoLabel>{block.title}</MonoLabel>
          <p className="mt-3 text-[16.5px] leading-[1.65]" style={{ color: INK }}>
            {block.text}
          </p>
        </aside>
      );
  }
}

function RelatedPlate({ post }: { post: Post }) {
  return (
    <Link
      to={`/blog/${post.slug}`}
      className="group relative flex h-full flex-col bg-white p-6 transition-colors duration-300 hover:bg-[#FAFAFA]"
    >
      <CornerMarks />
      <span className="flex items-center gap-2">
        <span aria-hidden className="h-[7px] w-[7px] shrink-0" style={{ background: post.cover[0] }} />
        <span className="font-mono text-[11px] uppercase tracking-[0.11em]" style={{ color: GREY }}>
          {post.category}
        </span>
      </span>
      <h3
        className="mt-4 flex-1 text-balance text-[19px] font-normal leading-[1.25] tracking-[-0.022em]"
        style={{ color: INK }}
      >
        {post.title}
      </h3>
      <span
        className="mt-6 flex items-center justify-between border-t pt-4 text-[13px]"
        style={{ borderColor: RULE, color: GREY }}
      >
        {post.readMinutes} min
        <span className="inline-flex items-center gap-1.5" style={{ color: PAPER_ACCENT }}>
          Read
          <ArrowUpRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </span>
      </span>
    </Link>
  );
}

export function BlogPostPage() {
  useEffect(() => {
    document.documentElement.classList.add("mkt-no-scrollbar", "amp-root");
    return () => document.documentElement.classList.remove("mkt-no-scrollbar", "amp-root");
  }, []);

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
    <div className="amplify min-h-screen text-white" style={{ backgroundColor: "transparent" }}>
      <LandingNav />

      <ToneCanvas initial="paper">
        {/* ══ Title block ═════════════════════════════════════════════════
            Left-aligned on the measure the article is about to use, rather than
            through the centred paper hero: a title centred over a left-aligned
            body reads as two pages stapled together. */}
        <ToneSection tone="paper">
          <header className="relative overflow-hidden">
            <RegisterMarks />
            <div className="relative mx-auto max-w-[760px] px-5 pb-14 pt-[132px] sm:px-6 sm:pt-[150px]">
              <Link
                to="/blog"
                className="inline-flex items-center gap-2 text-[14px] transition-colors hover:text-[#111111]"
                style={{ color: GREY }}
              >
                <ArrowLeft className="h-4 w-4" />
                All posts
              </Link>

              <div className="mt-9 flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="flex items-center gap-2">
                  <span aria-hidden className="h-[7px] w-[7px] shrink-0" style={{ background: accent }} />
                  <span className="font-mono text-[11px] uppercase tracking-[0.11em]" style={{ color: GREY }}>
                    {post.category}
                  </span>
                </span>
                <span className="text-[13px]" style={{ color: GREY }}>
                  <time dateTime={post.date}>{formatDate(post.date)}</time> · {post.readMinutes} min read
                </span>
              </div>

              <h1
                className="mt-6 text-pretty text-[36px] font-normal leading-[1.06] tracking-[-0.035em] sm:text-[52px]"
                style={{ color: INK }}
              >
                {post.title}
              </h1>
              <p
                className="mt-6 font-instrument-serif text-[20px] leading-[1.5] sm:text-[23px]"
                style={{ color: "#3A3A3A" }}
              >
                {post.excerpt}
              </p>

              <div
                className="mt-10 flex items-center gap-3 border-t pt-7"
                style={{ borderColor: RULE }}
              >
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-full text-[12px] font-semibold text-white"
                  style={{ background: INK }}
                >
                  {post.author.initials}
                </span>
                <span className="text-[14px]">
                  <span className="block" style={{ color: INK }}>
                    {post.author.name}
                  </span>
                  <span className="block" style={{ color: GREY }}>
                    {post.author.role}
                  </span>
                </span>
              </div>
            </div>
          </header>
        </ToneSection>

        {/* ══ Body ════════════════════════════════════════════════════════ */}
        <ToneSection tone="paper">
          <article className="mx-auto max-w-[760px] px-5 pb-20 sm:px-6">
            {post.body.map((block, i) => (
              <BlockView key={i} block={block} accent={accent} />
            ))}

            <div className="mt-16 border-t pt-8" style={{ borderColor: RULE }}>
              <p className="text-[15px] leading-[1.6]" style={{ color: GREY }}>
                Written by <span style={{ color: INK }}>{post.author.name}</span>, {post.author.role} at
                Anduran. Questions about anything here?{" "}
                <Link
                  to="/contact"
                  className="underline underline-offset-4"
                  style={{ color: PAPER_ACCENT }}
                >
                  Talk to us
                </Link>
                .
              </p>
            </div>
          </article>
        </ToneSection>

        {/* ══ Related ═════════════════════════════════════════════════════ */}
        <ToneSection tone="bone">
          <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28">
            <Reveal>
              <SectionTitle frame="Keep" claim="reading" />
            </Reveal>
            <div className="mt-12 grid gap-5 sm:grid-cols-3">
              {related.map((p, i) => (
                <Reveal key={p.slug} delay={i * 90} className="h-full">
                  <RelatedPlate post={p} />
                </Reveal>
              ))}
            </div>
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
