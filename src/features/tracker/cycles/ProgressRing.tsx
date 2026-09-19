import { cn } from "@/lib/utils";

/**
 * L'anneau de progression d'un cycle.
 *
 * Le pourcentage est écrit AU CENTRE, pas seulement tracé : un arc se lit à
 * peu près — on distingue « environ un quart » de « environ trois quarts »,
 * jamais 20 % de 25 %. L'anneau donne l'ordre de grandeur d'un coup d'œil, le
 * chiffre donne la valeur ; supprimer l'un des deux revient à choisir entre
 * balayer et savoir.
 *
 * La couleur suit l'écart au rythme et non la valeur absolue : un cycle à 20 %
 * le troisième jour va bien, le même à 20 % la veille de la fin ne va pas. Sans
 * ce réglage, la couleur dirait quelque chose de faux la moitié du temps.
 */
export function ProgressRing({
  percent, size = 44, tone = "neutral", className,
}: {
  percent: number;
  size?: number;
  tone?: "neutral" | "ahead" | "behind";
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const stroke = size > 36 ? 3.5 : 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);

  const color = tone === "behind" ? "#eda100" : tone === "ahead" ? "#3e9b4f" : "hsl(var(--primary))";

  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${clamped}% terminé`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke}
        />
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-[stroke-dashoffset] duration-500"
        />
      </svg>
      <span
        className="absolute font-semibold tabular-nums"
        style={{ fontSize: size > 36 ? 12 : 10 }}
      >
        {clamped}%
      </span>
    </span>
  );
}
