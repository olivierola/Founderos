import { cn } from "@/lib/utils";

/** Low-level shimmer block. Compose these to mirror a page's real layout. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted/60", className)} />;
}

/**
 * Generic page-loading skeleton: a header, an optional KPI-card grid and an
 * optional table/list. Sized to roughly match the real content so the swap-in
 * doesn't jump. Tune `cards`/`rows`/`header` per page.
 */
export function PageSkeleton({
  header = true,
  cards = 3,
  rows = 6,
  className,
}: {
  header?: boolean;
  cards?: number;
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-6", className)}>
      {header && (
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
      )}

      {cards > 0 && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {Array.from({ length: cards }).map((_, i) => (
            <div key={i} className="space-y-3 rounded-xl border border-border/60 p-4">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-7 w-20" />
            </div>
          ))}
        </div>
      )}

      {rows > 0 && (
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-14" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
