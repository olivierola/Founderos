import { useState } from "react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ *
 * Illustrated agent portraits via the DiceBear library. Agents keep a
 * full portrait URL in `avatar_url`; the picker lets you choose among
 * many DiceBear styles (Adventurer, Avataaars, Bottts, Lorelei…) and a
 * grid of seeds. No emojis/orbs — agents always show a real avatar.
 * ------------------------------------------------------------------ */
const AVATAR_STYLE = "notionists"; // historical default (keeps existing look)

// Curated DiceBear styles (slugs) — mirrors the library gallery.
export const AVATAR_STYLES = [
  "adventurer", "adventurer-neutral", "avataaars", "avataaars-neutral",
  "big-ears", "big-ears-neutral", "big-smile", "bottts", "bottts-neutral",
  "croodles", "croodles-neutral", "dylan", "fun-emoji", "glass", "icons",
  "identicon", "initials", "lorelei", "lorelei-neutral", "micah", "miniavs",
  "notionists", "notionists-neutral", "open-peeps", "personas",
  "pixel-art", "pixel-art-neutral", "shapes", "thumbs",
] as const;
export type AvatarStyle = (typeof AVATAR_STYLES)[number];

const AVATAR_SEEDS = [
  "Aiden", "Bella", "Caleb", "Diana", "Ezra", "Faye", "Gabriel", "Hana",
  "Ivan", "Jade", "Kian", "Lia", "Milo", "Nora", "Omar", "Priya",
  "Quentin", "Rosa", "Soren", "Tara", "Umar", "Vera", "Wyatt", "Zoe",
  "Aria", "Bruno", "Cleo", "Dahlia", "Enzo", "Freya",
];

const prettyStyle = (s: string) => s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

export function avatarUrl(seed: string, style: string = AVATAR_STYLE): string {
  // Keep the historical gradient background for the default notionists style so
  // existing agents/templates look unchanged; other styles use their own art.
  const bg = style === "notionists" ? "&backgroundType=gradientLinear" : "";
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}${bg}&radius=20`;
}

export const AVATAR_OPTIONS: string[] = AVATAR_SEEDS.map((s) => avatarUrl(s));

/** Render an agent's portrait. Falls back to a deterministic portrait
 *  derived from `seed` (e.g. the agent name) when no URL is stored. */
export function AgentAvatar({
  url, seed, className,
}: {
  url?: string | null;
  seed?: string | null;
  className?: string;
}) {
  const src = url || avatarUrl(seed || "agent");
  return <img src={src} alt="" className={cn("object-cover", className)} loading="lazy" draggable={false} />;
}

const styleFromUrl = (url: string | null | undefined): string => {
  const m = url?.match(/9\.x\/([^/]+)\/svg/);
  return m && (AVATAR_STYLES as readonly string[]).includes(m[1]) ? m[1] : AVATAR_STYLE;
};

/** Portrait picker — a styles list (DiceBear gallery) + a grid of seeds. */
export function AvatarPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (url: string) => void;
}) {
  const [style, setStyle] = useState<string>(() => styleFromUrl(value));

  return (
    <div className="flex h-72 overflow-hidden rounded-xl border border-border">
      {/* Styles list */}
      <div className="w-40 shrink-0 overflow-y-auto border-r border-border bg-muted/30 p-1.5 scrollbar-slim">
        <div className="px-1.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Styles</div>
        {AVATAR_STYLES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStyle(s)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs transition-colors",
              style === s ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted",
            )}
          >
            <img src={avatarUrl("Preview", s)} alt="" className="h-5 w-5 shrink-0 rounded" loading="lazy" draggable={false} />
            <span className="truncate">{prettyStyle(s)}</span>
          </button>
        ))}
      </div>

      {/* Seed grid for the selected style */}
      <div className="flex-1 overflow-y-auto p-2 scrollbar-slim">
        <div className="grid grid-cols-6 gap-2">
          {AVATAR_SEEDS.map((seed) => {
            const url = avatarUrl(seed, style);
            const active = value === url;
            return (
              <button
                key={seed}
                type="button"
                onClick={() => onChange(url)}
                className={cn(
                  "aspect-square overflow-hidden rounded-xl border bg-muted transition-all hover:brightness-110",
                  active ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary/50",
                )}
              >
                <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" draggable={false} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
