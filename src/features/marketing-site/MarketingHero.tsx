import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { Link } from "react-router-dom";

const VIDEO_URL =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260403_050628_c4e32401-fab4-4a27-b7a8-6e9291cd5959.mp4";

// Fades its children from opacity 0 → 1 after `delay` ms over `duration` ms.
function FadeIn({ delay = 0, duration = 1000, children, className }: { delay?: number; duration?: number; children: ReactNode; className?: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return (
    <div
      className={`transition-opacity ${className ?? ""}`}
      style={{ opacity: shown ? 1 : 0, transitionDuration: `${duration}ms` }}
    >
      {children}
    </div>
  );
}

// Character-by-character entrance: each char slides in from the left + fades in,
// staggered per line and per character.
function AnimatedHeading({ text, className, style, charDelay = 30, initialDelay = 200 }: {
  text: string; className?: string; style?: CSSProperties; charDelay?: number; initialDelay?: number;
}) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGo(true), initialDelay);
    return () => clearTimeout(t);
  }, [initialDelay]);
  const lines = text.split("\n");
  return (
    <h1 className={className} style={style}>
      {lines.map((line, lineIndex) => (
        <span key={lineIndex} className="block">
          {line.split("").map((ch, charIndex) => {
            const delay = lineIndex * line.length * charDelay + charIndex * charDelay;
            return (
              <span
                key={charIndex}
                className="inline-block"
                style={{
                  opacity: go ? 1 : 0,
                  transform: go ? "translateX(0)" : "translateX(-18px)",
                  transition: "opacity 500ms, transform 500ms",
                  transitionDelay: `${delay}ms`,
                }}
              >
                {ch === " " ? " " : ch}
              </span>
            );
          })}
        </span>
      ))}
    </h1>
  );
}

export function MarketingHero() {
  return (
    <section className="font-inter relative h-screen w-full overflow-hidden bg-black text-white">
      {/* Raw background video — no overlay, no dimming. */}
      <video
        className="absolute inset-0 h-full w-full object-cover"
        src={VIDEO_URL}
        autoPlay
        loop
        muted
        playsInline
      />

      {/* Foreground */}
      <div className="relative z-10 flex h-full flex-col">
        {/* Navbar */}
        <div className="px-6 pt-6 md:px-12 lg:px-16">
          <nav className="liquid-glass flex items-center justify-between rounded-xl px-4 py-2">
            <Link to="/" className="text-2xl font-semibold tracking-tight">FounderOS</Link>
            <div className="hidden items-center gap-8 md:flex">
              <Link to="/features" className="text-sm transition-colors hover:text-gray-300">Features</Link>
              <Link to="/integrations" className="text-sm transition-colors hover:text-gray-300">Integrations</Link>
              <Link to="/pricing" className="text-sm transition-colors hover:text-gray-300">Pricing</Link>
              <Link to="/docs" className="text-sm transition-colors hover:text-gray-300">Docs</Link>
            </div>
            <Link to="/signup" className="rounded-lg bg-white px-6 py-2 text-sm font-medium text-black transition-colors hover:bg-gray-100">
              Start free
            </Link>
          </nav>
        </div>

        {/* Hero content pushed to the bottom */}
        <div className="flex flex-1 flex-col justify-end px-6 pb-12 md:px-12 lg:px-16 lg:pb-16">
          <div className="lg:grid lg:grid-cols-2 lg:items-end">
            {/* Left column */}
            <div>
              <AnimatedHeading
                text={"Shaping tomorrow\nwith vision and action."}
                className="mb-4 text-4xl font-normal md:text-5xl lg:text-6xl xl:text-7xl"
                style={{ letterSpacing: "-0.04em" }}
              />
              <FadeIn delay={800} duration={1000}>
                <p className="mb-5 text-base text-gray-300 md:text-lg">
                  The cockpit agencies run on — manage every client SaaS, and the AI agents that operate it, from one panel.
                </p>
              </FadeIn>
              <FadeIn delay={1200} duration={1000}>
                <div className="flex flex-wrap gap-4">
                  <Link to="/signup" className="rounded-lg bg-white px-8 py-3 font-medium text-black transition-colors hover:bg-gray-100">
                    Start free
                  </Link>
                  <Link to="/features" className="liquid-glass rounded-lg border border-white/20 px-8 py-3 font-medium text-white transition-colors hover:bg-white hover:text-black">
                    Explore now
                  </Link>
                </div>
              </FadeIn>
            </div>

            {/* Right column — glass tag */}
            <div className="mt-8 flex items-end justify-start lg:mt-0 lg:justify-end">
              <FadeIn delay={1400} duration={1000}>
                <div className="liquid-glass rounded-xl border border-white/20 px-6 py-3">
                  <span className="text-lg font-light md:text-xl lg:text-2xl">Billing. Infra. Agents.</span>
                </div>
              </FadeIn>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
