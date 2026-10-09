import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Pill sombre « métal » : pas de motif ni d'animation, juste un léger reflet
// statique en haut, un effet au survol (éclaircit, bordure et ombre) et au clic
// (presse). forwardRef + spread des props pour servir de déclencheur
// (Radix `asChild`, etc.).
type ChromeButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
};

export const ChromeButton = forwardRef<HTMLButtonElement, ChromeButtonProps>(
  ({ children, className, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "group relative overflow-hidden rounded-full border border-white/10 bg-neutral-950 px-5 py-2.5 text-[13px] font-medium text-white shadow-lg transition-all duration-150 hover:border-white/25 hover:bg-neutral-900 hover:shadow-xl active:scale-95",
          className,
        )}
        {...props}
      >
        {/* Un simple reflet en haut (pas de motif), un peu plus marqué au survol. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/15 to-transparent opacity-60 transition-opacity duration-200 group-hover:opacity-100"
        />
        <span className="relative z-10 inline-flex items-center gap-1.5">{children}</span>
      </button>
    );
  },
);
ChromeButton.displayName = "ChromeButton";

export default ChromeButton;
