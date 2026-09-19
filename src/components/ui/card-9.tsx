import * as React from "react";
import { XIcon as X } from "@phosphor-icons/react";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "@/components/ui/button";

/**
 * Grainy noise overlay — the texture that gives this card family its matte,
 * printed feel.
 *
 * The filter id is generated per instance. The original snippet hardcoded
 * `id="grainy"`, which is fine for a single promo card but silently breaks the
 * moment two of them share a page: duplicate DOM ids mean every card resolves
 * `url(#grainy)` to the first one, and removing that card strips the texture
 * from all the others.
 */
export function GrainOverlay({ className, opacity = 0.03 }: { className?: string; opacity?: number }) {
  const id = React.useId().replace(/:/g, "");
  return (
    <>
      <svg className="pointer-events-none absolute -z-10 h-0 w-0" aria-hidden="true">
        <filter id={id}>
          <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
        </filter>
      </svg>
      <div
        aria-hidden="true"
        className={cn("pointer-events-none absolute inset-0 z-0", className)}
        style={{ filter: `url(#${id})`, opacity }}
      />
    </>
  );
}

/** Three pulsing dots, the card family's "working" tell. */
export function CardLoaderDots({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center space-x-1", className)}>
      <span className="h-1.5 w-4 animate-[promo-card-loader-pulse_1.5s_infinite] rounded-full bg-muted-foreground" />
      <span className="h-1.5 w-1.5 animate-[promo-card-loader-pulse_1.5s_infinite_0.2s] rounded-full bg-muted-foreground" />
      <span className="h-1.5 w-1.5 animate-[promo-card-loader-pulse_1.5s_infinite_0.4s] rounded-full bg-muted-foreground" />
    </div>
  );
}

/**
 * The div props a motion.div can actually accept: framer-motion redefines the
 * drag/animation handlers with its own signatures, and `title` is widened to a
 * ReactNode here so the card can take markup rather than a plain string.
 */
type PromoCardDivProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "title" | "onDrag" | "onDragStart" | "onDragEnd" | "onAnimationStart" | "onAnimationEnd" | "onAnimationIteration"
>;

interface PromoCardProps extends PromoCardDivProps {
  label: string;
  title: React.ReactNode;
  buttonText: string;
  buttonVariant?: ButtonProps["variant"];
  onButtonClick: () => void;
  onClose: () => void;
  showLoader?: boolean;
}

const PromoCard = React.forwardRef<HTMLDivElement, PromoCardProps>(
  (
    {
      className,
      label,
      title,
      buttonText,
      buttonVariant = "secondary",
      onButtonClick,
      onClose,
      showLoader = true,
      ...props
    },
    ref,
  ) => {
    return (
      <motion.div
        ref={ref}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20, transition: { duration: 0.3 } }}
        transition={{ duration: 0.5, ease: "easeInOut" }}
        className={cn(
          "relative w-full max-w-md overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-lg",
          className,
        )}
        aria-labelledby="promo-card-title"
        role="dialog"
        aria-modal="true"
        {...props}
      >
        <GrainOverlay />

        <Button
          variant="ghost"
          size="icon"
          className="absolute right-4 top-4 z-20 h-8 w-8 rounded-full"
          onClick={onClose}
          aria-label="Close promotion"
        >
          <X className="h-4 w-4" />
        </Button>

        <div className="relative z-10 flex h-full flex-col p-8">
          {showLoader && <CardLoaderDots className="absolute left-6 top-6" />}

          <div className="mt-8 flex-grow">
            <p className="mb-2 text-sm font-medium text-muted-foreground">{label}</p>
            <h2 id="promo-card-title" className="text-3xl font-bold tracking-tight text-foreground">
              {title}
            </h2>
          </div>

          <div className="mt-8 flex-shrink-0">
            <Button className="w-full sm:w-auto" size="lg" variant={buttonVariant} onClick={onButtonClick}>
              {buttonText}
            </Button>
          </div>
        </div>
      </motion.div>
    );
  },
);

PromoCard.displayName = "PromoCard";

export { PromoCard };
