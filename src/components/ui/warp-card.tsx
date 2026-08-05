"use client";

import type React from "react";
import { Warp } from "@paper-design/shaders-react";
import { cn } from "@/lib/utils";

// Shader-backed card (paper-design Warp) — a vivid animated background behind a
// dark glass panel with icon, title, description and an "open" affordance.
export interface WarpConfig {
  proportion: number;
  softness: number;
  distortion: number;
  swirl: number;
  swirlIterations: number;
  shape: "checks" | "stripes" | "edge";
  shapeScale: number;
  colors: string[];
}

// Per-theme shader presets (a user can pick one per card; otherwise they cycle).
export const WARP_CONFIGS: { key: string; label: string; config: WarpConfig }[] = [
  { key: "magenta", label: "Magenta", config: { proportion: 0.3, softness: 0.8, distortion: 0.15, swirl: 0.6, swirlIterations: 8, shape: "checks", shapeScale: 0.08, colors: ["hsl(280, 100%, 30%)", "hsl(320, 100%, 60%)", "hsl(340, 90%, 40%)", "hsl(300, 100%, 70%)"] } },
  { key: "cyan", label: "Cyan", config: { proportion: 0.4, softness: 1.2, distortion: 0.2, swirl: 0.9, swirlIterations: 12, shape: "stripes", shapeScale: 0.12, colors: ["hsl(200, 100%, 25%)", "hsl(180, 100%, 65%)", "hsl(160, 90%, 35%)", "hsl(190, 100%, 75%)"] } },
  { key: "green", label: "Vert", config: { proportion: 0.35, softness: 0.9, distortion: 0.18, swirl: 0.7, swirlIterations: 10, shape: "checks", shapeScale: 0.1, colors: ["hsl(120, 100%, 25%)", "hsl(140, 100%, 60%)", "hsl(100, 90%, 30%)", "hsl(130, 100%, 70%)"] } },
  { key: "amber", label: "Ambre", config: { proportion: 0.45, softness: 1.1, distortion: 0.22, swirl: 0.8, swirlIterations: 15, shape: "stripes", shapeScale: 0.09, colors: ["hsl(30, 100%, 35%)", "hsl(50, 100%, 65%)", "hsl(40, 90%, 40%)", "hsl(45, 100%, 75%)"] } },
  { key: "violet", label: "Violet", config: { proportion: 0.38, softness: 0.95, distortion: 0.16, swirl: 0.85, swirlIterations: 11, shape: "checks", shapeScale: 0.11, colors: ["hsl(250, 100%, 30%)", "hsl(270, 100%, 65%)", "hsl(260, 90%, 35%)", "hsl(265, 100%, 70%)"] } },
  { key: "rose", label: "Rose", config: { proportion: 0.42, softness: 1.0, distortion: 0.19, swirl: 0.75, swirlIterations: 9, shape: "stripes", shapeScale: 0.13, colors: ["hsl(330, 100%, 30%)", "hsl(350, 100%, 60%)", "hsl(340, 90%, 35%)", "hsl(345, 100%, 75%)"] } },
];

export const configForKey = (key?: string | null) => WARP_CONFIGS.find((c) => c.key === key)?.config;
export const cssGradientForConfig = (c: WarpConfig) => `linear-gradient(135deg, ${c.colors.join(", ")})`;

export function WarpCard({
  title, description, icon, config, onClick, className,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  config: WarpConfig;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <div onClick={onClick} className={cn("group relative h-80 cursor-pointer", className)}>
      <div className="absolute inset-0 overflow-hidden rounded-3xl">
        <Warp
          style={{ height: "100%", width: "100%" }}
          proportion={config.proportion}
          softness={config.softness}
          distortion={config.distortion}
          swirl={config.swirl}
          swirlIterations={config.swirlIterations}
          shape={config.shape}
          shapeScale={config.shapeScale}
          scale={1}
          rotation={0}
          speed={0.8}
          colors={config.colors}
        />
      </div>

      <div className="relative z-10 flex h-full flex-col rounded-3xl border border-white/20 bg-black/80 p-8 dark:border-white/10">
        <div className="mb-6 filter drop-shadow-lg">{icon}</div>
        <h3 className="mb-4 line-clamp-2 text-2xl font-bold text-white">{title}</h3>
        <p className="line-clamp-4 flex-grow font-medium leading-relaxed text-gray-100">{description}</p>
        <div className="mt-6 flex items-center text-sm font-bold text-gray-200">
          <span className="mr-2">Ouvrir</span>
          <svg className="h-4 w-4 transition-transform group-hover:translate-x-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </div>
    </div>
  );
}
