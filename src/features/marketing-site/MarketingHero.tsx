import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";

const VIDEO_URL =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260328_083109_283f3553-e28f-428b-a723-d639c617eb2b.mp4";

const FADE = 0.5; // seconds of fade in/out
const BLACK = "#000000";
const GRAY = "#6F6F6F";

// Cinematic, white-background hero with a looping background video that fades
// in at the start and out before the end (manual seamless loop). Branding
// adapted to FounderOS; structure/animation per spec.
export function MarketingHero() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      const d = v.duration;
      if (d && !Number.isNaN(d)) {
        const t = v.currentTime;
        if (t < FADE) v.style.opacity = String(t / FADE);
        else if (t > d - FADE) v.style.opacity = String(Math.max(0, (d - t) / FADE));
        else v.style.opacity = "1";
      }
      raf = requestAnimationFrame(tick);
    };
    const onEnded = () => {
      v.style.opacity = "0";
      setTimeout(() => { v.currentTime = 0; v.play().catch(() => {}); }, 100);
    };
    v.addEventListener("ended", onEnded);
    v.play().catch(() => {});
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); v.removeEventListener("ended", onEnded); };
  }, []);

  return (
    <section className="relative min-h-screen w-full overflow-hidden bg-white text-black">
      {/* Background video (z-0) */}
      <div className="absolute z-0" style={{ top: "300px", inset: "auto 0 0 0" }}>
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          style={{ opacity: 0, transition: "opacity 120ms linear" }}
          src={VIDEO_URL}
          muted
          playsInline
          autoPlay
        />
      </div>
      {/* Gradient overlays over the video */}
      <div className="pointer-events-none absolute inset-0 z-0 bg-gradient-to-b from-white via-transparent to-white" />

      {/* Navbar (z-10) */}
      <nav className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-8 py-6">
        <Link to="/" className="font-instrument-serif text-3xl tracking-tight" style={{ color: BLACK }}>
          FounderOS<sup className="text-base">®</sup>
        </Link>
        <div className="hidden items-center gap-8 md:flex">
          <Link to="/" className="text-sm transition-colors" style={{ color: BLACK }}>Home</Link>
          <Link to="/features" className="text-sm transition-colors hover:text-black" style={{ color: GRAY }}>Features</Link>
          <Link to="/integrations" className="text-sm transition-colors hover:text-black" style={{ color: GRAY }}>Integrations</Link>
          <Link to="/pricing" className="text-sm transition-colors hover:text-black" style={{ color: GRAY }}>Pricing</Link>
          <Link to="/docs" className="text-sm transition-colors hover:text-black" style={{ color: GRAY }}>Docs</Link>
        </div>
        <Link
          to="/signup"
          className="rounded-full px-6 py-2.5 text-sm font-medium text-white transition-transform hover:scale-[1.03]"
          style={{ backgroundColor: BLACK }}
        >
          Start free
        </Link>
      </nav>

      {/* Hero content (z-10) */}
      <div
        className="relative z-10 flex flex-col items-center justify-center px-6 pb-40 text-center"
        style={{ paddingTop: "calc(8rem - 75px)" }}
      >
        <h1
          className="font-instrument-serif animate-fade-rise max-w-7xl text-5xl font-normal sm:text-7xl md:text-8xl"
          style={{ color: BLACK, lineHeight: 0.95, letterSpacing: "-2.46px" }}
        >
          The cockpit, beyond the <span style={{ color: GRAY }} className="italic">noise.</span>
        </h1>

        <p
          className="animate-fade-rise-delay mt-8 max-w-2xl text-base leading-relaxed sm:text-lg"
          style={{ color: GRAY }}
        >
          Run every client SaaS from one panel — billing, infra, deploys, secrets, support and the AI agents
          that operate them. Replace twelve dashboards with one calm cockpit.
        </p>

        <Link
          to="/signup"
          className="animate-fade-rise-delay-2 mt-12 rounded-full px-14 py-5 text-base text-white transition-transform hover:scale-[1.03]"
          style={{ backgroundColor: BLACK }}
        >
          Start free
        </Link>
      </div>
    </section>
  );
}
