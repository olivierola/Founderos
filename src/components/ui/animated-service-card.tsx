"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

// --- Service Card ---
export interface Service {
  number: string;
  title: string;
  description: string;
  icon: React.ElementType;
  gradient: string;
}

// Sober, dark, muted card colours (deep desaturated tones — not vivid),
// readable with white text in both light and dark themes. Users pick one per
// card; a null selection falls back to a kind-based default.
export const CARD_COLORS: { key: string; label: string; gradient: string }[] = [
  { key: "slate", label: "Ardoise", gradient: "from-slate-700 to-slate-900" },
  { key: "graphite", label: "Graphite", gradient: "from-zinc-700 to-zinc-900" },
  { key: "night", label: "Nuit", gradient: "from-slate-800 to-blue-950" },
  { key: "forest", label: "Forêt", gradient: "from-slate-800 to-emerald-950" },
  { key: "teal", label: "Sarcelle", gradient: "from-slate-800 to-teal-950" },
  { key: "plum", label: "Prune", gradient: "from-zinc-800 to-violet-950" },
  { key: "wine", label: "Bordeaux", gradient: "from-zinc-800 to-rose-950" },
  { key: "earth", label: "Terre", gradient: "from-stone-700 to-stone-900" },
];
export const gradientForKey = (key?: string | null) => CARD_COLORS.find((c) => c.key === key)?.gradient;

// Card reproduced exactly from the reference (gradient, number, icon, uppercase
// title + description, subtle top overlay). Only `onClick`/`cursor-pointer` are
// added so an artifact card can open its editor — the visual is unchanged.
export const ServiceCard = ({ service, index, onClick }: { service: Service; index: number; onClick?: () => void }) => {
  const cardVariants = {
    hidden: { opacity: 0, y: 50 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.5,
        delay: index * 0.1,
      },
    },
  };

  return (
    <motion.div
      variants={cardVariants}
      onClick={onClick}
      className={cn(
        "group relative flex h-[450px] w-full flex-col justify-between overflow-hidden rounded-3xl p-8 bg-gradient-to-br cursor-pointer text-white",
        service.gradient
      )}
    >
      {/* Grain / noise texture */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.22] mix-blend-overlay" style={{ backgroundImage: `url("${NOISE_URI}")`, backgroundSize: "140px 140px" }} />
      {/* Depth vignette for text legibility */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-black/10 to-black/5" />

      {/* Card Content */}
      <div className="z-10 flex flex-col items-start text-left">
        <span className="mb-8 text-sm font-mono text-white/55">
          ( {service.number} )
        </span>
        <service.icon className="mb-auto h-12 w-12 text-white/95" />
      </div>
      <div className="z-10">
        <h3 className="mb-2 text-lg font-semibold uppercase tracking-wider">
          {service.title}
        </h3>
        <p className="text-sm text-white/70">{service.description}</p>
      </div>
    </motion.div>
  );
};

// Tileable fractal-noise texture (inline SVG) — gives the cards a grainy finish.
const NOISE_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";
