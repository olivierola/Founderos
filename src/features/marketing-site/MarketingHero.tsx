import { useRef } from "react";
import { Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { motion, useScroll, useTransform } from "framer-motion";
import { Logo } from "@/components/Logo";

const VIDEO_URL =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260307_083826_e938b29f-a43a-41ec-a153-3d4730578ab8.mp4";

// Neuralyn-style hero, using the app's logo + colorimetry (theme tokens).
// Full-width background video at the bottom (no dashboard image over it),
// parallax + staggered entrance animations via Framer Motion. Page structure
// unchanged — the rest of the home follows.
export function MarketingHero() {
  const sectionRef = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ["start start", "end start"] });
  const textY = useTransform(scrollYProgress, [0, 1], [0, -200]);
  const textOpacity = useTransform(scrollYProgress, [0, 0.5], [1, 0]);

  return (
    <section ref={sectionRef} className="font-inter relative flex min-h-screen flex-col overflow-x-clip bg-background text-foreground">
      {/* Navbar */}
      <nav className="flex items-center justify-between px-8 py-4 md:px-28">
        <div className="flex items-center gap-12 md:gap-20">
          <Link to="/" className="flex items-center gap-2">
            <Logo size={28} />
            <span className="text-xl font-bold tracking-tight">FounderOS</span>
          </Link>
          <div className="hidden items-center gap-1 md:flex">
            <Link to="/" className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">Home</Link>
            <Link to="/features" className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
              Services <ChevronDown className="h-3.5 w-3.5" />
            </Link>
            <Link to="/integrations" className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">Reviews</Link>
            <Link to="/contact" className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">Contact us</Link>
          </div>
        </div>
        <Link to="/login" className="rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90">
          Sign In
        </Link>
      </nav>

      {/* Hero content (parallax + fade on scroll) */}
      <motion.div style={{ y: textY, opacity: textOpacity }} className="mt-16 flex flex-col items-center px-4 text-center md:mt-20">
        {/* Tag pill */}
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
          className="liquid-glass mb-6 inline-flex items-center gap-2 rounded-lg px-3 py-2"
        >
          <span className="rounded-md bg-foreground px-2 py-0.5 text-sm font-medium text-background">New</span>
          <span className="text-sm font-medium text-muted-foreground">Say hello to the AI agent cockpit</span>
        </motion.div>

        {/* Title */}
        <motion.h1
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.1 }}
          className="mb-3 text-5xl font-medium leading-tight tracking-[-2px] md:text-7xl md:leading-[1.15]"
        >
          Your insights.
          <br />
          One clear <span className="font-instrument-serif font-normal italic">Overview.</span>
        </motion.h1>

        {/* Subtitle */}
        <motion.p
          initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.2 }}
          className="mb-8 text-lg font-normal leading-6 opacity-90"
          style={{ color: "hsl(210 17% 95%)" }}
        >
          FounderOS helps teams track metrics, goals,
          <br />
          and progress across every client SaaS with precision.
        </motion.p>

        {/* CTA */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, delay: 0.3 }}>
          <Link to="/signup">
            <motion.span
              whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.98 }}
              className="inline-flex rounded-full bg-foreground px-8 py-3.5 text-base font-medium text-background"
            >
              Get started for free
            </motion.span>
          </Link>
        </motion.div>
      </motion.div>

      {/* Full-width background video band (no dashboard image over it) */}
      <motion.div
        initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.4 }}
        className="relative mt-16 w-full self-stretch"
        style={{ aspectRatio: "16 / 9" }}
      >
        <video className="absolute inset-0 block h-full w-full object-cover object-center" src={VIDEO_URL} autoPlay loop muted playsInline />
        {/* Bottom gradient fade into the page background */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-40 bg-gradient-to-t from-background to-transparent" />
      </motion.div>
    </section>
  );
}
