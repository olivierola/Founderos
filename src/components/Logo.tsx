import { cn } from "@/lib/utils";

// RedAI brand mark — a rounded-square "R" monogram on the red accent tile, with a
// small spark dot for the "AI". Named after its red accent colour.
export function Logo({ className, size = 36 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-label="RedAI"
    >
      <defs>
        <linearGradient id="redai-grad" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f5583a" />
          <stop offset="1" stopColor="#c9331a" />
        </linearGradient>
      </defs>
      {/* Rounded tile */}
      <rect x="1.5" y="1.5" width="37" height="37" rx="10" fill="url(#redai-grad)" />
      <rect x="1.5" y="1.5" width="37" height="37" rx="10" stroke="white" strokeOpacity="0.14" />
      {/* Stylised "R" — stem, bowl, leg */}
      <path d="M14.5 12.5v15.5" stroke="white" strokeWidth="3.3" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M14.5 12.5h6.4a4.6 4.6 0 0 1 0 9.2h-6.4"
        stroke="white"
        strokeWidth="3.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M19.4 21.7l6.1 6.3" stroke="white" strokeWidth="3.3" strokeLinecap="round" strokeLinejoin="round" />
      {/* AI spark */}
      <circle cx="28.5" cy="12.5" r="2.4" fill="white" />
    </svg>
  );
}
