import type { ReactNode } from "react";
import { InfoIcon } from "@phosphor-icons/react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * L'explication d'un réglage, rangée derrière un (i).
 *
 * Les formulaires de configuration portaient une phrase sous chaque champ.
 * Une par une, elles étaient justes ; ensemble, elles noyaient les réglages
 * dans du texte qu'on ne relit jamais après la première fois. Le libellé et
 * le placeholder disent l'essentiel ; le détail reste à un survol.
 */
export function InfoHint({ children, className, side = "top" }: {
  children: ReactNode;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            tabIndex={0}
            aria-label="Plus d'informations"
            onClick={(e) => e.preventDefault()}
            className={cn(
              "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none",
              className,
            )}
          >
            <InfoIcon className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side={side} className="max-w-[260px] text-[11.5px] leading-snug">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
