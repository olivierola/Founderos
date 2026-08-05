import { cn } from "@/lib/utils";

/* Brand mark — the orange chevron cut out of a black rounded slab, exactly as
   drawn. The slab keeps its colour on every surface: it is part of the mark,
   not a background that adapts. `paper` exists only for an inverted lockup. */
const TILES = {
  ink: "#000000",
  paper: "#ffffff",
} as const;

/* The artwork is a touch wider than tall, so `size` is read as its height and
   the width follows — squashing it into a square would deform the corners. */
const RATIO = 392 / 360;

export function Logo({
  className,
  size = 36,
  tone = "ink",
}: {
  className?: string;
  size?: number;
  tone?: keyof typeof TILES;
}) {
  return (
    <svg
      width={Math.round(size * RATIO)}
      height={size}
      viewBox="0 0 392 360"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      role="img"
      aria-label="AchiCorp"
    >
      <rect width="392" height="360" rx="55" fill={TILES[tone]} />
      <path
        d="M57.829 271.533L168.967 60.2722C180.248 38.8274 210.985 38.9137 222.145 60.4216L269.038 150.787C269.546 151.651 270.011 152.545 270.43 153.469L280.53 172.934L333.118 271.363C343.795 291.347 329.315 315.5 306.658 315.5H294.97H260.075C256.882 315.5 254.413 312.699 254.814 309.531L272.107 172.934C273.783 165.616 272.944 159.016 270.43 153.469L269.038 150.787C258.411 132.71 229.127 128.094 216.676 151.102L136.222 299.778C130.98 309.465 120.851 315.5 109.837 315.5H84.3792C61.8065 315.5 47.3197 291.51 57.829 271.533Z"
        fill="#FF4D00"
      />
    </svg>
  );
}
