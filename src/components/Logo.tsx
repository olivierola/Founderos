import { cn } from "@/lib/utils";

/* Brand mark — the chevron drawn bare, on any surface, in the brand's
   red-orange. It carries its own colour rather than inheriting the ink around
   it: a mark that repaints itself per context is a shape, not a logo, and this
   one now has to hold on a nav that flips between paper and near-black within a
   single scroll. Pass `color` to override it — "currentColor" for the places
   that genuinely want the surrounding ink, such as a monochrome print or a
   disabled state. The artwork is a touch wider than tall, so `size` is read as
   its height and the width follows — squashing it into a square would deform
   the mark. */
const RATIO = 246 / 240;

/* The accent's two cuts. #2893CC is 3.4:1 on white — fine for a large mark,
   thin for a small one — so the default is the deepened #176995, which clears
   6.0:1 on white and 4.4:1 on the darkest ground and therefore holds anywhere
   the logo is dropped without knowing its surface.

   Somewhere with a known dark ground — the nav once the canvas has gone
   near-black — pass `BRAND_MARK_BRIGHT` and get the true blue. */
export const BRAND_MARK = "#176995";
export const BRAND_MARK_BRIGHT = "#2893CC";

export function Logo({
  className,
  size = 36,
  color = BRAND_MARK,
}: {
  className?: string;
  size?: number;
  color?: string;
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
        fill={color}
      />
      <path
        d="M118.665 145.285C120.466 141.505 125.837 141.48 127.673 145.242L159.322 210.094C161.352 214.253 157.128 218.7 152.87 216.887L125.108 205.067C123.842 204.528 122.411 204.534 121.15 205.084L94.3234 216.785C90.0827 218.635 85.8206 214.228 87.8104 210.052L118.665 145.285Z"
        fill={color}
      />
    </svg>
  );
}
