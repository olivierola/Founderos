import { cn } from "@/lib/utils";

// Realistic, illustrated portrait avatars (DiceBear "personas" — professional,
// diverse). Photo-realistic faces would require uploads / image-gen; these are
// the best stable, free, consistent option for an "AI employee" look.
const AVATAR_STYLE = "personas";
const AVATAR_SEEDS = [
  "Aiden", "Bella", "Caleb", "Diana", "Ezra", "Faye", "Gabriel", "Hana",
  "Ivan", "Jade", "Kian", "Lia", "Milo", "Nora", "Omar", "Priya",
  "Quentin", "Rosa", "Soren", "Tara", "Umar", "Vera", "Wyatt", "Zoe",
];

export function avatarUrl(seed: string): string {
  return `https://api.dicebear.com/9.x/${AVATAR_STYLE}/svg?seed=${encodeURIComponent(seed)}&backgroundType=gradientLinear`;
}

export const AVATAR_OPTIONS: string[] = AVATAR_SEEDS.map(avatarUrl);

/** Render an agent's avatar: the chosen image, or the emoji fallback. */
export function AgentAvatar({
  url, emoji, accent, className,
}: {
  url?: string | null;
  emoji?: string | null;
  accent?: string | null;
  className?: string;
}) {
  if (url) {
    return <img src={url} alt="" className={cn("object-cover", className)} loading="lazy" draggable={false} />;
  }
  return (
    <div
      className={cn("flex items-center justify-center", className)}
      style={{ backgroundColor: (accent ?? "#2F2FE4") + "22", color: accent ?? undefined }}
    >
      <span className="text-[1.4em] leading-none">{emoji ?? "🤖"}</span>
    </div>
  );
}

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
            "aspect-square overflow-hidden rounded-lg border bg-muted transition-all hover:brightness-110",
            value === url ? "border-primary ring-2 ring-primary" : "border-border hover:border-primary/50",
          )}
        >
          <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" draggable={false} />
        </button>
      ))}
    </div>
  );
}
