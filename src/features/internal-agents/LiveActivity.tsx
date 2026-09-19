// LiveActivity — the single line that says what an agent is doing right now.
//
// The live run block deliberately has no card, no border and no spinner, so
// this line is the entire live UI. It cross-fades: when the activity changes
// the outgoing sentence fades up and out while the incoming one fades up and
// in, both stacked in the same box so nothing around it jumps. A slow sheen
// crosses the text (see globals.css) so a step that takes a while still reads
// as running.
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const CROSSFADE_MS = 260;

export function LiveActivity({ text, className }: { text: string; className?: string }) {
  const [current, setCurrent] = useState(text);
  const [leaving, setLeaving] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (text === current) return;
    setLeaving(current);
    setCurrent(text);
    clearTimeout(timer.current);
    // Drop the outgoing line once its animation is done — keeping it mounted
    // would leave an invisible element inflating the row's height.
    timer.current = setTimeout(() => setLeaving(null), CROSSFADE_MS);
  }, [text, current]);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!current) return null;

  return (
    <div className={cn("relative min-h-[1.35rem] select-none", className)}>
      {leaving && (
        <span
          key={`out-${leaving}`}
          aria-hidden
          className="agent-activity-out pointer-events-none absolute inset-x-0 top-0 block truncate text-[13px] leading-[1.35rem] text-muted-foreground"
        >
          {leaving}
        </span>
      )}
      <span
        key={`in-${current}`}
        // aria-live so a screen reader hears the agent's progress; the visual
        // cross-fade is decorative on top of that.
        aria-live="polite"
        className="agent-activity-in agent-activity-live block truncate text-[13px] font-medium leading-[1.35rem]"
      >
        {current}
      </span>
    </div>
  );
}
