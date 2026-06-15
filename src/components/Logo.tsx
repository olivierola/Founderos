import { cn } from "@/lib/utils";

// FounderOS brand mark — a rounded-square "F" monogram with an orbiting dot
// ("OS"), drawn with the app accent. Use `variant="mark"` for the icon only.
export function Logo({ className, size = 36 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-label="FounderOS"
    >
      <defs>
        <linearGradient id="fos-grad" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="hsl(343 72% 56%)" />
          <stop offset="1" stopColor="hsl(343 66% 42%)" />
        </linearGradient>
      </defs>
      {/* Rounded tile */}
      <rect x="1.5" y="1.5" width="37" height="37" rx="10" fill="url(#fos-grad)" />
      <rect x="1.5" y="1.5" width="37" height="37" rx="10" stroke="white" strokeOpacity="0.12" />
      {/* Stylised "F" */}
      <path
        d="M14 12.5h13.5M14 12.5v15.5M14 20.5h9.5"
        stroke="white"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Orbiting "OS" dot */}
      <circle cx="29.5" cy="27.5" r="2.6" fill="white" />
    </svg>
  );
}
