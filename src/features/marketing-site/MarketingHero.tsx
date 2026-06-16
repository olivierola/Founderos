import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Menu, X } from "lucide-react";
import Hls from "hls.js";
import { Logo } from "@/components/Logo";

const HLS_URL = "https://stream.mux.com/tLkHO1qZoaaQOUeVWo8hEBeGQfySP02EPS02BmnNFyXys.m3u8";

const NAV = [
  { label: "Projects", to: "/features" },
  { label: "Blog", to: "/changelog" },
  { label: "About", to: "/about" },
  { label: "Resume", to: "/pricing" },
];

// High-end dark hero (CodeNest layout) using the app's base colorimetry:
// background = --background, accent = --primary, text = --foreground. HLS video
// background, central glow, grid lines and a left-aligned liquid-glass card.
export function MarketingHero() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let hls: Hls | null = null;
    if (v.canPlayType("application/vnd.apple.mpegurl")) {
      v.src = HLS_URL; // native HLS (Safari)
    } else if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: false });
      hls.loadSource(HLS_URL);
      hls.attachMedia(v);
    }
    v.play().catch(() => {});
    return () => { hls?.destroy(); };
  }, []);

  return (
    <section className="font-inter relative min-h-screen w-full overflow-hidden bg-background text-foreground">
      {/* Background video @ 60% */}
      <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover opacity-60" autoPlay loop muted playsInline />
      {/* Left + bottom gradient overlays for readability (theme background) */}
      <div className="pointer-events-none absolute inset-0" style={{ background: "linear-gradient(90deg, hsl(var(--background)) 0%, transparent 60%)" }} />
      <div className="pointer-events-none absolute inset-0" style={{ background: "linear-gradient(0deg, hsl(var(--background)) 0%, transparent 50%)" }} />

      {/* Vertical grid lines (desktop) */}
      <div className="pointer-events-none absolute inset-0 hidden md:block">
        <span className="absolute top-0 h-full w-px bg-white/10" style={{ left: "25%" }} />
        <span className="absolute top-0 h-full w-px bg-white/10" style={{ left: "50%" }} />
        <span className="absolute top-0 h-full w-px bg-white/10" style={{ left: "75%" }} />
      </div>

      {/* Navbar */}
      <nav className="relative z-20 mx-auto flex max-w-7xl items-center justify-between px-8 py-6 md:px-12">
        <Link to="/" className="flex items-center gap-2">
          <Logo size={26} />
          <span className="text-xl font-extrabold tracking-tight text-foreground">FounderOS</span>
        </Link>
        <div className="hidden items-center gap-10 md:flex">
          {NAV.map((l) => (
            <Link key={l.to} to={l.to} className="text-[15px] text-foreground/85 transition-colors hover:text-primary">
              {l.label.toUpperCase()}
            </Link>
          ))}
        </div>
        <Link to="/signup" className="hidden text-[15px] font-medium text-foreground/85 transition-colors hover:text-primary md:inline-flex">
          [ REGISTER NOW ]
        </Link>
        <button className="text-foreground md:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu"><Menu className="h-6 w-6" /></button>
      </nav>

      {/* Mobile menu overlay */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background p-6 md:hidden">
          <div className="flex items-center justify-between">
            <span className="text-xl font-extrabold text-foreground">FounderOS</span>
            <button className="text-foreground" onClick={() => setMenuOpen(false)} aria-label="Close menu"><X className="h-6 w-6" /></button>
          </div>
          <div className="mt-12 flex flex-col gap-6">
            {NAV.map((l) => (
              <Link key={l.to} to={l.to} onClick={() => setMenuOpen(false)} className="text-2xl font-semibold text-foreground">{l.label}</Link>
            ))}
            <Link to="/signup" onClick={() => setMenuOpen(false)} className="mt-4 inline-flex w-fit rounded-full bg-primary px-6 py-3 text-sm font-bold uppercase text-primary-foreground">
              Register now
            </Link>
          </div>
        </div>
      )}

      {/* Content — left aligned, glass card above the headline */}
      <div className="relative z-10 mx-auto flex min-h-[calc(100vh-88px)] max-w-7xl flex-col justify-between px-8 pb-16 pt-6 md:px-12">
        {/* Liquid glass card (top-left) */}
        <div className="liquid-glass flex h-[200px] w-[200px] -translate-y-[10px] flex-col justify-between rounded-2xl p-4 text-left">
          <span className="text-[14px] text-foreground/70">[ 2025 ]</span>
          <span className="text-[18px] font-medium leading-tight text-foreground">
            Taught by <span className="font-instrument-serif italic">Industry</span> Professionals
          </span>
          <span className="text-[11px] text-foreground/55">Built and operated by senior SaaS &amp; ops engineers.</span>
        </div>

        {/* Headline + description + CTA (bottom-left) */}
        <div className="max-w-2xl">
          <p className="font-jakarta mb-3 text-[11px] font-bold uppercase tracking-wide text-primary">
            Career-ready cockpit
          </p>
          <h1 className="text-[40px] font-extrabold uppercase leading-[0.98] tracking-tight text-foreground md:text-[72px]" style={{ fontFamily: "Inter, sans-serif" }}>
            Launch your<br />agency cockpit<span className="text-primary">.</span>
          </h1>
          <p className="mt-5 max-w-[512px] text-[14px] text-foreground/70" style={{ fontFamily: "Inter, sans-serif" }}>
            Master every client SaaS with one panel — billing, infra, deploys, secrets, support and the
            AI agents that operate them. From zero to in-control.
          </p>
          <Link
            to="/signup"
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary px-7 py-3 text-sm font-bold uppercase text-primary-foreground transition-transform hover:scale-[1.03]"
          >
            Get started <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
