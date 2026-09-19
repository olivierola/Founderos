import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { HeartIcon as Heart } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

/**
 * Immersive image card: full-bleed photo, gradient scrim, overline + title, and
 * a like affordance. Filed as `destination-card` rather than `card` because
 * `@/components/ui/card` is the shadcn primitive that 85 files already import.
 *
 * The embeddable widget renders the same design in vanilla DOM (see the
 * `.fosw-product` rules in public/widget.js) — that surface is a standalone
 * script with no React, so the two are deliberate twins rather than one shared
 * component. Change the look here, change it there.
 */
const cardVariants = cva(
  "relative grid h-full w-full transform-gpu overflow-hidden rounded-xl border shadow-sm transition-all duration-300 ease-in-out group",
  { variants: {}, defaultVariants: {} },
);

export interface DestinationCardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {
  /** The URL for the background image of the card. */
  imageUrl: string;
  /** The category or region text displayed above the main title. */
  category: string;
  /** The main title of the destination. */
  title: string;
  /** A callback function to be invoked when the like button is clicked. */
  onLike: () => void;
  /** Determines if the destination is marked as liked. */
  isLiked?: boolean;
}

const DestinationCard = React.forwardRef<HTMLDivElement, DestinationCardProps>(
  ({ className, imageUrl, category, title, onLike, isLiked = false, ...props }, ref) => {
    // A broken image falls back to the scrim alone rather than fetching a
    // placeholder from a third-party host: that request would fire from every
    // page the card renders on, and it leaks the visit to that host.
    const [broken, setBroken] = React.useState(false);

    return (
      <div ref={ref} className={cn(cardVariants({ className }))} {...props}>
        {broken ? (
          <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-br from-muted to-muted-foreground/30" />
        ) : (
          <img
            src={imageUrl}
            alt={title}
            loading="lazy"
            onError={() => setBroken(true)}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-in-out group-hover:scale-110"
          />
        )}

        {/* Scrim, so the text keeps its contrast whatever the photo does. */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />

        <button
          type="button"
          aria-label={isLiked ? "Unlike destination" : "Like destination"}
          aria-pressed={isLiked}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onLike();
          }}
          className={cn(
            "absolute right-4 top-4 z-20 rounded-full bg-white/20 p-2 backdrop-blur-sm transition-all duration-200 hover:bg-white/30 active:scale-95",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          )}
        >
          <Heart weight={isLiked ? "fill" : "regular"} className={cn("h-6 w-6 text-white transition-all", isLiked && "text-red-500")} />
        </button>

        <div className="relative z-10 flex h-full flex-col justify-end p-6 text-white transition-transform duration-500 ease-in-out group-hover:-translate-y-2">
          <p className="text-sm font-medium uppercase tracking-wider text-gray-200">- {category} -</p>
          <h2 className="mt-1 text-3xl font-bold leading-tight tracking-tight text-white md:text-4xl">{title}</h2>
        </div>
      </div>
    );
  },
);
DestinationCard.displayName = "DestinationCard";

export { DestinationCard };
