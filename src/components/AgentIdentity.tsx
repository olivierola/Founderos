import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/features/internal-agents/AvatarPicker";

// An agent's visual identity — always an illustrated avatar (orbs were
// removed). One component so every surface stays consistent. The legacy
// `style`/`glow`/`lightOrb`/`accentColor` props are accepted but ignored so
// existing call sites keep compiling.
export function AgentIdentity({
  url, seed, size = 32, rounded = "rounded-2xl", className,
}: {
  style?: "avatar" | "orb" | null;
  url?: string | null;
  seed?: string;
  size?: number;
  /** Tailwind rounding for the avatar. */
  rounded?: string;
  className?: string;
  glow?: boolean;
  lightOrb?: boolean;
  accentColor?: string | null;
}) {
  return (
    <span
      className={cn("inline-block shrink-0 overflow-hidden", rounded, className)}
      style={{ width: size, height: size }}
    >
      <AgentAvatar url={url} seed={seed} className="h-full w-full" />
    </span>
  );
}
