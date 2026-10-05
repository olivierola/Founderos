import { useMemo } from "react";
import { BotAvatar, botAvatarTypes, type BotAvatarState, type BotAvatarType } from "bot-avatars";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/features/internal-agents/AvatarPicker";

// An agent's visual identity: an ANIMATED bot (bot-avatars) rather than the
// frozen DiceBear portrait it used to be. One component, so every surface —
// roster, room thread, chat header, mission cards — shows the same agent as
// the same creature.
//
// The shape and the animation offset are derived from the agent's name, so an
// agent always gets its own body and a row of them never blinks in unison; the
// colour follows the agent's accent when it has one. A portrait the user
// actually uploaded still wins: it is their choice, not a default.

const GENERATED_HOSTS = ["dicebear.com", "api.dicebear"];
/** A body chosen by hand in the picker, stored in `avatar_url` as `bot:star`
 *  — no migration needed, and it reads for itself in the database. */
const BOT_PREFIX = "bot:";

export const isBotAvatar = (url: string | null | undefined): boolean => !!url?.startsWith(BOT_PREFIX);
export const botAvatarValue = (type: BotAvatarType): string => `${BOT_PREFIX}${type}`;

/** The chosen body, or null when nothing was chosen (the name decides). */
function chosenType(url: string | null | undefined): BotAvatarType | null {
  if (!isBotAvatar(url)) return null;
  const t = url!.slice(BOT_PREFIX.length) as BotAvatarType;
  return botAvatarTypes.includes(t) ? t : null;
}

/** True for the auto-assigned portrait services — those are the "frozen
 *  avatars" the bots replace, as opposed to a real uploaded image. */
function isGeneratedPortrait(url: string | null | undefined): boolean {
  if (!url) return true;
  if (isBotAvatar(url)) return true;
  return GENERATED_HOSTS.some((h) => url.includes(h));
}

/** Stable 32-bit hash — same agent, same body, on every screen and reload. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function AgentIdentity({
  url, seed, size = 32, rounded = "rounded-2xl", className, state = "default",
  accentColor, face = "eyes", interactive = true, paused,
}: {
  style?: "avatar" | "orb" | null;
  url?: string | null;
  /** Identity of the agent — its name or id. Picks the body and the offset. */
  seed?: string;
  size?: number;
  /** Tailwind rounding, applied to an uploaded portrait (a bot needs none). */
  rounded?: string;
  className?: string;
  /** What the agent is doing: working = hops and spins, sleeping = at rest. */
  state?: BotAvatarState;
  /** Tints the body; defaults to the shape's own colour. */
  accentColor?: string | null;
  face?: "eyes" | "mouth";
  /** The eyes follow the pointer and a click makes it hop. Off in dense lists. */
  interactive?: boolean;
  paused?: boolean;
  glow?: boolean;
  lightOrb?: boolean;
}) {
  const key = seed || "agent";
  const { type, offset } = useMemo(() => {
    const h = hash(key);
    return {
      type: chosenType(url) ?? (botAvatarTypes[h % botAvatarTypes.length] as BotAvatarType),
      offset: ((h >>> 8) % 1000) / 1000,
    };
  }, [key, url]);

  // A portrait the user uploaded stays a portrait.
  if (url && !isGeneratedPortrait(url)) {
    return (
      <span
        className={cn("inline-block shrink-0 overflow-hidden", rounded, className)}
        style={{ width: size, height: size }}
      >
        <AgentAvatar url={url} seed={seed} className="h-full w-full" />
      </span>
    );
  }

  // Two things the library's own box does not give us:
  //
  //  · SHARPNESS. It sizes its canvas from the element's box, so asking for a
  //    bigger `size` and shrinking it with width/height changes nothing. Scaled
  //    down with a transform, the box stays big and the backing store with it —
  //    a real 2× supersample. Only worth it where it shows: a screen without
  //    device pixels to spare, and an avatar big enough to read.
  //  · FOOTPRINT. The canvas is 1.5× the body (room for the hop). Left in the
  //    flow it pushed everything around; centred in a box of exactly `size`, the
  //    body matches the portraits it replaces and the jump just overflows.
  const dense = typeof window !== "undefined" && (window.devicePixelRatio || 1) >= 1.5;
  const ss = !dense && size >= 40 ? 2 : 1;

  return (
    <span
      className={cn("relative inline-block shrink-0 align-middle", className)}
      style={{ width: size, height: size }}
    >
      <span
        className="absolute left-1/2 top-1/2 leading-none"
        style={{ transform: `translate(-50%, -50%) scale(${1 / ss})` }}
      >
        <BotAvatar
          type={type}
          face={face}
          state={state}
          size={size * ss}
          seed={offset}
          color={accentColor || undefined}
          interactive={interactive}
          paused={paused}
          aria-label={seed ? `${seed}, avatar` : "Avatar de l'agent"}
        />
      </span>
    </span>
  );
}
