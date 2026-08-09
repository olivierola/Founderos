import { cn } from "@/lib/utils";

/* Brand mark — the orange chevron drawn bare, on any surface. The artwork is a
   touch wider than tall, so `size` is read as its height and the width follows —
   squashing it into a square would deform the mark. */
const RATIO = 246 / 240;

export function Logo({
  className,
  size = 36,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      width={Math.round(size * RATIO)}
      height={size}
      viewBox="0 0 246 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      role="img"
      aria-label="Anduran"
    >
      <path
        d="M119.083 2.03953C121.068 -0.696592 125.151 -0.676387 127.108 2.07992C189.867 90.4781 229.025 187.592 245.345 232.765C247.233 237.99 240.811 241.35 237.407 236.959L127.077 94.6241C125.075 92.0417 121.175 92.0417 119.173 94.6241L8.24815 237.726C4.86677 242.088 -1.50121 238.781 0.321783 233.572C16.0061 188.75 54.5606 90.9785 119.083 2.03953Z"
        fill="#FF4D00"
      />
      <path
        d="M118.665 145.285C120.466 141.505 125.837 141.48 127.673 145.242L159.322 210.094C161.352 214.253 157.128 218.7 152.87 216.887L125.108 205.067C123.842 204.528 122.411 204.534 121.15 205.084L94.3234 216.785C90.0827 218.635 85.8206 214.228 87.8104 210.052L118.665 145.285Z"
        fill="#FF4D00"
      />
    </svg>
  );
}
