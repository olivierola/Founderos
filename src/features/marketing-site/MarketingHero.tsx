import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRightIcon as ArrowRight,
  ArrowUpRightIcon as ArrowUpRight,
  RobotIcon as Bot,
  CpuIcon as Cpu,
  GithubLogoIcon as Github,
  ListIcon as Menu,
  MicrophoneIcon as Mic,
  PauseIcon as Pause,
  PlayIcon as Play,
  ShieldCheckIcon as ShieldCheck,
  SpeakerHighIcon as Volume2,
  SpeakerXIcon as VolumeX,
  XIcon as X,
} from "@phosphor-icons/react";
import { Logo } from "@/components/Logo";

const ORANGE = "#68bbfb";
const BUTTON_BG = ORANGE;

const NAV = [
  { label: "How it works", to: "/features" },
  { label: "Product", to: "/features" },
  { label: "Pricing", to: "/pricing" },
  { label: "Docs", to: "/docs" },
  { label: "Blog", to: "/changelog" },
  { label: "Integrations", to: "/integrations" },
];

const STRIP_LOGOS = ["Stripe", "Vercel", "GitHub", "Supabase", "Linear", "Slack", "Sentry", "PostHog"];

// Short agentforce lines that cycle in the corner of the F1 video (speed + AI workforce).
const PHRASES = ["Agents that never sleep", "Support on autopilot", "Ops at race pace", "Live in minutes"];

// Groq-style hero: a light cream canvas, a rounded autoplay video card on the left
// with a giant word overlay + player controls, a headline + CTA + two proof cards on
// the right, and a logo strip / chat bar underneath.
export function MarketingHero() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <section className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#efede7] text-neutral-900">
      {/* ── Navbar (fixed, light) ────────────────────────────────────────────── */}
      <nav
        className={`fixed inset-x-0 top-0 z-50 border-b transition-colors duration-300 ${
          scrolled ? "border-black/10 bg-[#efede7]/85 backdrop-blur-xl" : "border-transparent"
        }`}
      >
        <div className="mx-auto flex w-full max-w-[1500px] items-center justify-between gap-6 px-6 py-4 md:px-10">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <Logo size={26} />
            <span className="text-lg font-semibold tracking-tight text-neutral-900">Anduran</span>
          </Link>

          <div className="hidden flex-1 items-center justify-center gap-8 lg:flex">
            {NAV.map((l, i) => (
              <Link
                key={`${l.label}-${i}`}
                to={l.to}
                className="text-[12px] font-medium uppercase tracking-[0.08em] text-neutral-500 transition-colors hover:text-neutral-900"
              >
                {l.label}
              </Link>
            ))}
          </div>

          <div className="hidden shrink-0 items-center gap-2.5 md:flex">
            <a
              href="https://github.com/olivierola/Founderos"
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-black/10 bg-white/60 text-neutral-700 transition-colors hover:bg-white"
              aria-label="GitHub"
            >
              <Github className="h-4 w-4" />
            </a>
            <Link
              to="/contact"
              className="rounded-lg border border-black/10 bg-white/60 px-4 py-2 text-[13px] font-semibold text-neutral-800 transition-colors hover:bg-white"
            >
              Book a demo
            </Link>
            <Link
              to="/signup"
              className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white transition-transform hover:scale-[1.03]"
              style={{ backgroundColor: BUTTON_BG }}
            >
              Get started
            </Link>
          </div>

          <button className="text-neutral-900 md:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Menu className="h-6 w-6" />
          </button>
        </div>
      </nav>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#efede7] p-6 md:hidden">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-lg font-semibold text-neutral-900">
              <Logo size={24} /> Anduran
            </span>
            <button className="text-neutral-900" onClick={() => setMenuOpen(false)} aria-label="Close menu">
              <X className="h-6 w-6" />
            </button>
          </div>
          <div className="mt-10 flex flex-col gap-5">
            {NAV.map((l, i) => (
              <Link key={`${l.label}-${i}`} to={l.to} onClick={() => setMenuOpen(false)} className="text-xl font-medium text-neutral-900">
                {l.label}
              </Link>
            ))}
            <Link
              to="/signup"
              onClick={() => setMenuOpen(false)}
              className="mt-4 inline-flex w-fit rounded-lg px-6 py-3 text-sm font-bold text-white"
              style={{ backgroundColor: BUTTON_BG }}
            >
              Get started
            </Link>
          </div>
        </div>
      )}

      {/* ── Hero grid (centered within the viewport, Groq proportions) ───────── */}
      <div className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col justify-center px-6 pb-16 pt-36 md:px-10 md:pb-20 md:pt-44">
        <div className="grid items-start gap-7 lg:grid-cols-[1.9fr_1fr]">
          {/* LEFT — video card */}
          <VideoHero />

          {/* RIGHT — copy + proof cards */}
          <div className="flex min-w-0 flex-col">
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em]" style={{ color: ORANGE }}>
              The AI workforce for enterprises
            </p>
            <h1 className="mt-4 text-[32px] font-medium leading-[1.08] tracking-tight text-neutral-900 sm:text-[38px] lg:text-[44px]">
              Deploy a workforce of AI agents that run your operations — and don't flake when things get real.
            </h1>
            <div className="mt-7">
              <Link
                to="/signup"
                className="group inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-[13px] font-semibold text-white transition-transform hover:scale-[1.03]"
                style={{ backgroundColor: BUTTON_BG }}
              >
                Get started
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>

            {/* Two proof cards */}
            <div className="mt-8 grid flex-1 grid-cols-1 gap-px overflow-hidden rounded-2xl border border-black/10 bg-black/10 sm:grid-cols-2">
              <ProofCard
                eyebrow="Agents in production"
                body="Support, ops and billing agents run 24/7 — with humans kept on approvals."
                visual={
                  <div className="flex h-full items-center justify-center gap-2 text-neutral-800">
                    <Bot className="h-6 w-6" style={{ color: ORANGE }} />
                    <span className="text-sm font-semibold tracking-tight">Anduran</span>
                    <span className="mx-1 h-4 w-px bg-black/15" />
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-500">Live</span>
                  </div>
                }
              />
              <ProofCard
                eyebrow="Audit on every action"
                body="Every agent action is logged, attributed and reversible."
                visual={
                  <div className="flex h-full items-center justify-center gap-3 text-neutral-700">
                    <Cpu className="h-7 w-7" weight="light" />
                    <ShieldCheck className="h-6 w-6" weight="light" style={{ color: ORANGE }} />
                  </div>
                }
              />
            </div>
          </div>
        </div>

        {/* ── Bottom strip: logos + chat bar (same columns as the grid) ────────── */}
        <div className="mt-7 grid gap-7 lg:grid-cols-[1.9fr_1fr]">
          <LogoStrip />
          <ChatBar />
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Video card with a big word overlay + player controls.                         */
/* ─────────────────────────────────────────────────────────────────────────── */

function VideoHero() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [phraseIdx, setPhraseIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setPhraseIdx((i) => (i + 1) % PHRASES.length), 3400);
    return () => clearInterval(id);
  }, []);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  return (
    <div className="relative aspect-[16/10] min-w-0 overflow-hidden rounded-[1.25rem] bg-black shadow-[0_20px_60px_-20px_rgba(0,0,0,0.35)] lg:aspect-[16/9]">
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover"
        src="/0705.mp4"
        poster="/hero-f1.jpg"
        autoPlay
        loop
        muted
        playsInline
      />
      {/* Legibility scrim (bottom, for the corner text + controls) */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-black/5 to-transparent" />

      {/* Unmute pill (top-center) */}
      {muted && (
        <button
          onClick={toggleMute}
          className="absolute left-1/2 top-4 -translate-x-1/2 rounded-md bg-black/55 px-3 py-1.5 text-[12px] font-medium text-white backdrop-blur transition-colors hover:bg-black/70"
        >
          Unmute
        </button>
      )}

      {/* Cycling line, bottom-left (Groq-style big type) */}
      <span className="pointer-events-none absolute bottom-5 left-6 max-w-[88%]">
        <span
          key={phraseIdx}
          className="animate-fade-rise inline-block text-[40px] font-medium leading-[0.98] tracking-tight text-white drop-shadow-md sm:text-[58px] lg:text-[74px]"
        >
          {PHRASES[phraseIdx]}
          <span style={{ color: ORANGE }}>.</span>
        </span>
      </span>

      {/* Bottom-right controls */}
      <div
        className="absolute bottom-4 right-4 flex items-center gap-1 rounded-xl px-1.5 py-1.5"
        style={{ backgroundColor: ORANGE }}
      >
        <button
          onClick={toggleMute}
          aria-label={muted ? "Unmute" : "Mute"}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-white transition-colors hover:bg-white/20"
        >
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        <button
          onClick={togglePlay}
          aria-label={playing ? "Pause" : "Play"}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-white transition-colors hover:bg-white/20"
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

/* A proof card: an inset visual box on top, an orange eyebrow + body below. */
function ProofCard({ eyebrow, body, visual }: { eyebrow: string; body: string; visual: ReactNode }) {
  return (
    <div className="flex flex-col bg-[#efede7] p-4">
      <div className="mb-4 flex h-28 items-center justify-center rounded-xl border border-black/5 bg-white/50">
        {visual}
      </div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: ORANGE }}>
        {eyebrow}
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-neutral-600">{body}</p>
    </div>
  );
}

/* Logo strip: a headline stat + a row of integration name pills. */
function LogoStrip() {
  return (
    <div className="flex items-center gap-5 overflow-hidden rounded-2xl border border-black/10 bg-white/40 px-5 py-4">
      <div className="shrink-0 leading-tight">
        <div className="font-stat-number text-2xl font-semibold tracking-tight text-neutral-900">57</div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-neutral-500">
          Integrations
          <br />& counting
        </div>
      </div>
      <div className="h-10 w-px bg-black/10" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2 text-neutral-500">
        {STRIP_LOGOS.map((l) => (
          <span key={l} className="text-sm font-semibold tracking-tight">
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

/* Decorative chat bar that routes to sign-up on submit. */
function ChatBar() {
  const navigate = useNavigate();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    navigate("/signup");
  };
  return (
    <form
      onSubmit={onSubmit}
      className="flex items-center gap-3 rounded-2xl bg-neutral-900 px-4 py-4 text-neutral-300"
    >
      <Mic className="h-4 w-4 shrink-0 text-neutral-400" />
      <input
        type="text"
        placeholder="TRY ANDURAN ON A REAL PROJECT…"
        className="min-w-0 flex-1 bg-transparent text-[12px] font-medium uppercase tracking-[0.08em] text-neutral-300 placeholder:text-neutral-500 focus:outline-none"
      />
      <button
        type="submit"
        aria-label="Start"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white transition-transform hover:scale-105"
        style={{ backgroundColor: ORANGE }}
      >
        <ArrowUpRight className="h-4 w-4" />
      </button>
    </form>
  );
}
