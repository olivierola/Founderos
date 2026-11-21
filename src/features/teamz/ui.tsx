import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import "./teamz.css";

/** Un nombre qui monte jusqu'à sa valeur — une fois, à l'apparition. */
export function CountUp({ value, duration = 1100, format = (n: number) => n.toLocaleString("fr-FR"), className }: {
  value: number; duration?: number; format?: (n: number) => string; className?: string;
}) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setShown(value); from.current = value; return; }
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(Math.round(a + (value - a) * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span className={cn("tabular-nums", className)}>{format(shown)}</span>;
}

/** Le score qualité d'un plan : un anneau qui se remplit, une couleur honnête. */
export function QualityRing({ score, size = 54, label = true }: { score: number; size?: number; label?: boolean }) {
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const [on, setOn] = useState(false);
  useEffect(() => { const t = setTimeout(() => setOn(true), 60); return () => clearTimeout(t); }, []);
  const color = score >= 90 ? "#3d9a8b" : score >= 70 ? "#d4a537" : "#e07a5f";
  return (
    <span className="relative inline-grid place-items-center" style={{ width: size, height: size }} title={`Qualité des prompts : ${score}/100`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="hsl(var(--border))" strokeWidth="4" fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth="4" fill="none" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={on ? c * (1 - score / 100) : c} className="tz-score-ring"
        />
      </svg>
      {label && <span className="absolute text-[13px] font-semibold tabular-nums">{score}</span>}
    </span>
  );
}

export function PlugChip({ name, required, connected, logo, title }: {
  name: string; required?: boolean; connected?: boolean; logo?: string | null; title?: string;
}) {
  return (
    <span title={title} className={cn(
      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px]",
      connected ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-border bg-secondary/50",
    )}>
      {logo
        ? <img src={logo} alt="" className="h-3.5 w-3.5 rounded-sm object-contain" loading="lazy" />
        : <span className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-muted-foreground/50")} />}
      {name}
      {required && !connected && <span className="text-[10px] text-muted-foreground">· requis</span>}
      {connected && <span className="text-[10px]">· branché</span>}
    </span>
  );
}

export function Stat({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="text-[22px] font-semibold leading-none tracking-tight">{children}</div>
      <div className="mt-1.5 text-[11.5px] text-muted-foreground">{label}</div>
    </div>
  );
}
