import { cn } from "@/lib/utils";
import { BotAvatar, botAvatarTypes } from "bot-avatars";

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

/**
 * Body picker — the eighteen animated bodies of bot-avatars.
 *
 * It replaced the DiceBear portrait gallery: agents are living bots now, and a
 * picker that still handed out frozen portraits would put them straight back.
 * The choice is stored in `avatar_url` as `bot:<type>`, so nothing migrates;
 * « Automatique » clears it and the agent's name picks the body again.
 */
export function AvatarPicker({
  value,
  onChange,
  accentColor,
  name,
}: {
  value: string | null;
  onChange: (url: string) => void;
  /** Tints the previews like the real avatar. */
  accentColor?: string | null;
  /** The agent's name — drives the automatic body. */
  name?: string;
}) {
  const chosen = value?.startsWith("bot:") ? value.slice(4) : null;
  return (
    <div className="rounded-xl border border-border p-2">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Corps de l'agent</span>
        <button
          type="button"
          onClick={() => onChange("")}
          className={cn(
            "rounded-full px-2.5 py-1 text-[11px] transition-colors",
            chosen ? "text-muted-foreground hover:text-foreground" : "bg-primary/10 font-medium text-primary",
          )}
        >
          Automatique
        </button>
      </div>
      <div className="grid max-h-60 grid-cols-6 gap-2 overflow-y-auto scrollbar-slim p-1">
        {botAvatarTypes.map((t) => (
          <button
            key={t}
            type="button"
            title={t}
            onClick={() => onChange(`bot:${t}`)}
            className={cn(
              "flex aspect-square items-center justify-center rounded-xl border transition-all",
              chosen === t ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary/50",
            )}
          >
            <BotAvatar type={t} size={40} color={accentColor || undefined} interactive={false} seed={0.13} />
          </button>
        ))}
      </div>
      <p className="px-1 pt-2 text-[11px] text-muted-foreground">
        Chaque corps a sa couleur ; celle de l'agent la remplace quand elle est définie.
        {name ? " En automatique, le nom de l'agent décide." : ""}
      </p>
    </div>
  );
}
