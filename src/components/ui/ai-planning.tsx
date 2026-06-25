import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Check,
  BrainCircuit,
} from "lucide-react";

export type PlanStepStatus = "pending" | "active" | "success" | "error";

export interface PlanStep {
  id: string;
  title: string;
  content?: React.ReactNode;
  status: PlanStepStatus;
  icon?: React.ReactNode;
  duration?: string;
  defaultExpanded?: boolean;
}

export interface AgentPlanningProps {
  title?: string;
  steps?: PlanStep[];
  /** When true, the active step shows a live elapsed-time counter. */
  live?: boolean;
}

const getStatusColor = (status: PlanStepStatus) => {
  switch (status) {
    case "success": return "bg-emerald-100 text-emerald-600 ring-emerald-500/20 dark:bg-emerald-500/20 dark:text-emerald-400";
    case "active": return "bg-blue-100 text-blue-600 ring-blue-500/30 dark:bg-blue-500/20 dark:text-blue-400";
    case "error": return "bg-rose-100 text-rose-600 ring-rose-500/20 dark:bg-rose-500/20 dark:text-rose-400";
    case "pending": return "bg-secondary text-muted-foreground ring-border/50 dark:bg-secondary/50";
  }
};

// Live elapsed timer shown on the active step (counts up while running).
function LiveTimer() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="text-[11px] font-mono text-blue-500 tabular-nums">{secs}s</span>;
}

export const AgentPlanning: React.FC<AgentPlanningProps> = ({
  title = "Agent is planning",
  steps = [],
  live = false,
}) => {
  const [isMainExpanded, setIsMainExpanded] = useState(true);
  const [manualOverride, setManualOverride] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const hasActive = steps.some((s) => s.status === "active");
  const hasError = steps.some((s) => s.status === "error");
  const allSuccess = steps.length > 0 && steps.every((s) => s.status === "success");

  // A step is expanded if: user manually toggled it, OR it's active/error (auto), OR defaultExpanded.
  const isExpanded = (step: PlanStep) => {
    if (step.id in manualOverride) return manualOverride[step.id];
    return step.status === "active" || step.status === "error" || !!step.defaultExpanded;
  };

  const toggleStep = (id: string, current: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    setManualOverride((prev) => ({ ...prev, [id]: !current }));
  };

  // Auto-scroll to keep the newest step visible while streaming.
  const stepCount = steps.length;
  useEffect(() => {
    if (live && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [stepCount, live]);

  const headerIcon = useMemo(() => {
    if (hasActive) return <Loader2 className="w-4 h-4 text-blue-600 dark:text-blue-400 animate-spin" />;
    if (hasError) return <BrainCircuit className="w-4 h-4 text-rose-500" />;
    if (allSuccess) return <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />;
    return <BrainCircuit className="w-4 h-4 text-muted-foreground" />;
  }, [hasActive, hasError, allSuccess]);

  return (
    <div className="w-full font-sans text-foreground my-2">
      <div className={`bg-card border shadow-sm rounded-xl overflow-hidden transition-all duration-300 ${hasActive ? "border-blue-500/30" : "border-border"}`}>
        {/* Header */}
        <div
          onClick={() => setIsMainExpanded(!isMainExpanded)}
          className={`flex items-center justify-between px-4 py-3 cursor-pointer transition-colors select-none
            ${isMainExpanded ? "bg-secondary/30 border-b border-border/50" : "hover:bg-secondary/30"}`}
        >
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-5 h-5">{headerIcon}</div>
            <span className="text-[14px] font-semibold text-foreground/90 tracking-tight">{title}</span>
            {hasActive && <span className="flex items-center gap-1.5 text-[11px] text-blue-500"><span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />running</span>}
          </div>
          <div className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-secondary text-muted-foreground transition-colors">
            {isMainExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </div>
        </div>

        {/* Timeline */}
        <div className={`grid transition-all duration-500 ease-in-out bg-card ${isMainExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
          <div className="overflow-hidden">
            <div ref={scrollRef} className="p-4 flex flex-col max-h-[460px] overflow-y-auto scroll-smooth">
              {steps.map((step, index) => {
                const expanded = isExpanded(step);
                const isLast = index === steps.length - 1;
                return (
                  <div
                    key={step.id}
                    className={`relative flex gap-3 animate-in fade-in slide-in-from-bottom-1 duration-300 fill-mode-both
                      ${step.status === "pending" ? "opacity-50" : "opacity-100"}`}
                  >
                    {/* Connecting line */}
                    {!isLast && <div className="absolute left-[11px] top-7 bottom-[-8px] w-[2px] bg-border/60 z-0" />}

                    {/* Icon node */}
                    <div className="relative z-10 flex-none w-6 h-6 mt-0.5">
                      <div className={`flex items-center justify-center w-full h-full rounded-full ring-4 ring-card transition-colors duration-300 ${getStatusColor(step.status)}`}>
                        {step.status === "success" ? <Check className="w-3.5 h-3.5" />
                          : step.status === "active" ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : step.icon || <div className="w-1.5 h-1.5 rounded-full bg-current" />}
                      </div>
                    </div>

                    {/* Content */}
                    <div className="flex-1 pb-4 min-w-0">
                      <div
                        className={`flex items-center justify-between group rounded-md -mx-2 px-2 py-1 transition-colors ${step.content ? "cursor-pointer hover:bg-secondary/50" : ""}`}
                        onClick={(e) => step.content && toggleStep(step.id, expanded, e)}
                      >
                        <span className={`text-[13px] tracking-tight truncate transition-colors duration-200
                          ${step.status === "active" ? "text-foreground font-semibold"
                            : step.status === "error" ? "text-rose-600 dark:text-rose-400 font-semibold"
                            : "text-foreground/80 group-hover:text-foreground font-medium"}`}>
                          {step.title}
                        </span>
                        <div className="flex items-center gap-2.5 shrink-0 pl-2">
                          {step.status === "active" && live ? <LiveTimer />
                            : step.duration && <span className="text-[11px] font-mono text-muted-foreground tabular-nums">{step.duration}</span>}
                          {step.content && (
                            <div className="text-muted-foreground/40 group-hover:text-muted-foreground transition-colors">
                              {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                            </div>
                          )}
                        </div>
                      </div>

                      {step.content && (
                        <div className={`grid transition-all duration-300 ease-in-out ${expanded ? "grid-rows-[1fr] mt-1.5 opacity-100" : "grid-rows-[0fr] mt-0 opacity-0"}`}>
                          <div className="overflow-hidden"><div className="pt-0.5 pb-1">{step.content}</div></div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgentPlanning;
