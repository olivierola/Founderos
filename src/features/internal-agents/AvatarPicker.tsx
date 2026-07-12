import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ *
 * Portraits — DiceBear "notionists" reads polished/professional for an
 * "AI employee" look. Agents & templates use these exclusively (no
 * emojis / icons). Existing agents keep whatever URL they stored.
 * ------------------------------------------------------------------ */
const AVATAR_STYLE = "notionists";
const AVATAR_SEEDS = [
  "Aiden", "Bella", "Caleb", "Diana", "Ezra", "Faye", "Gabriel", "Hana",
  "Ivan", "Jade", "Kian", "Lia", "Milo", "Nora", "Omar", "Priya",
  "Quentin", "Rosa", "Soren", "Tara", "Umar", "Vera", "Wyatt", "Zoe",
];

export function avatarUrl(seed: string): string {
  return `https://api.dicebear.com/9.x/${AVATAR_STYLE}/svg?seed=${encodeURIComponent(seed)}&backgroundType=gradientLinear&radius=20`;
}

export const AVATAR_OPTIONS: string[] = AVATAR_SEEDS.map(avatarUrl);

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

/** Portrait picker — a grid of illustrated avatars. */
export function AvatarPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (url: string) => void;
}) {
  return (
    <div className="grid max-h-44 grid-cols-8 gap-2 overflow-y-auto pr-1 scrollbar-slim">
      {AVATAR_OPTIONS.map((url) => (
        <button
          key={url}
          type="button"
          onClick={() => onChange(url)}
          className={cn(
            "aspect-square overflow-hidden rounded-xl border bg-muted transition-all hover:brightness-110",
            value === url ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary/50",
          )}
        >
          <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" draggable={false} />
        </button>
      ))}
    </div>
  );
}
