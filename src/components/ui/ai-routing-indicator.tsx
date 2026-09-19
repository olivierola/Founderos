import * as React from "react";

import {
  ArrowRightIcon as ArrowRight,
  RobotIcon as Bot,
  CircleDashedIcon as CircleDashed,
  PathIcon as Route,
  SparkleIcon as Sparkles,
  LightningIcon as Zap,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

// Shows how one request was ROUTED: the input, the signal that decided it, and
// the agent it landed on. Headless-ish — pass `children` to compose your own
// body, or let it render the default header + content.

interface AiRoutingIndicatorProps {
  input: string;
  matchedPattern?: string;
  targetAgent?: string;
  confidence?: number;
  isRouting?: boolean;
  children?: React.ReactNode;
  className?: string;
}

function AiRoutingIndicator({
  input,
  matchedPattern,
  targetAgent,
  confidence,
  isRouting = false,
  children,
  className,
}: AiRoutingIndicatorProps) {
  return (
    <div
      data-slot="ai-routing-indicator"
      data-routing={isRouting}
      className={cn(
        "overflow-hidden rounded-lg border bg-card text-card-foreground transition-all",
        isRouting
          ? "border-indigo-300 shadow-lg shadow-indigo-100 dark:border-indigo-800 dark:shadow-indigo-950/50"
          : "border-border",
        className,
      )}
    >
      {children || (
        <>
          <AiRoutingIndicatorHeader isRouting={isRouting} />
          <AiRoutingIndicatorContent
            input={input}
            matchedPattern={matchedPattern}
            targetAgent={targetAgent}
            confidence={confidence}
            isRouting={isRouting}
          />
        </>
      )}
    </div>
  );
}

interface AiRoutingIndicatorHeaderProps {
  isRouting?: boolean;
  children?: React.ReactNode;
  className?: string;
}

function AiRoutingIndicatorHeader({
  isRouting,
  children,
  className,
}: AiRoutingIndicatorHeaderProps) {
  return (
    <div
      data-slot="ai-routing-indicator-header"
      className={cn(
        "flex items-center gap-2 border-b px-4 py-3 transition-colors",
        isRouting ? "border-indigo-200 dark:border-indigo-900" : "border-border",
        className,
      )}
    >
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md transition-colors",
          isRouting ? "bg-indigo-100 dark:bg-indigo-950" : "bg-muted",
        )}
      >
        {isRouting ? (
          <Sparkles className="size-4 animate-pulse text-indigo-600 dark:text-indigo-400" />
        ) : (
          <Route className="size-4 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <h3
          className={cn(
            "text-sm font-semibold",
            isRouting && "text-indigo-700 dark:text-indigo-300",
          )}
        >
          {children || "Routage du message"}
          {isRouting && (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
              Routage…
            </span>
          )}
        </h3>
      </div>
    </div>
  );
}

interface AiRoutingIndicatorContentProps {
  input: string;
  matchedPattern?: string;
  targetAgent?: string;
  confidence?: number;
  isRouting?: boolean;
  className?: string;
}

function AiRoutingIndicatorContent({
  input,
  matchedPattern,
  targetAgent,
  confidence,
  isRouting,
  className,
}: AiRoutingIndicatorContentProps) {
  return (
    <div
      data-slot="ai-routing-indicator-content"
      className={cn("relative space-y-4 p-4", isRouting && "overflow-hidden", className)}
    >
      {isRouting && (
        <div className="pointer-events-none absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-indigo-100/50 to-transparent motion-reduce:animate-none dark:via-indigo-900/30" />
      )}
      <AiRoutingInput input={input} matchedPattern={matchedPattern} />
      {(matchedPattern || targetAgent || isRouting) && (
        <AiRoutingFlow
          matchedPattern={matchedPattern}
          targetAgent={targetAgent}
          confidence={confidence}
          isRouting={isRouting}
        />
      )}
    </div>
  );
}

interface AiRoutingInputProps {
  input: string;
  matchedPattern?: string;
  label?: string;
  className?: string;
}

function AiRoutingInput({ input, matchedPattern, label = "Demande", className }: AiRoutingInputProps) {
  const highlightedText = React.useMemo(() => {
    if (!matchedPattern || !input) return null;
    // The pattern is free text written by an LLM, so it must be escaped before
    // it ever reaches the RegExp constructor — an unbalanced parenthesis in a
    // routing reason would otherwise throw on every render.
    const escaped = matchedPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      const regex = new RegExp(`(${escaped})`, "gi");
      const parts = input.split(regex);
      return parts.map((part, index) =>
        part.toLowerCase() === matchedPattern.toLowerCase() ? (
          <mark
            key={index}
            className="rounded bg-indigo-200 px-0.5 text-indigo-900 dark:bg-indigo-900 dark:text-indigo-100"
          >
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      );
    } catch {
      return null;
    }
  }, [input, matchedPattern]);

  return (
    <div data-slot="ai-routing-input" className={cn("space-y-1.5", className)}>
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-sm">
        {highlightedText || input}
      </div>
    </div>
  );
}

interface AiRoutingFlowProps {
  matchedPattern?: string;
  targetAgent?: string;
  confidence?: number;
  isRouting?: boolean;
  patternLabel?: string;
  targetLabel?: string;
  className?: string;
}

function AiRoutingFlow({
  matchedPattern,
  targetAgent,
  confidence,
  isRouting,
  patternLabel = "Signal",
  targetLabel = "Agent visé",
  className,
}: AiRoutingFlowProps) {
  return (
    <div data-slot="ai-routing-flow" className={cn("flex items-center gap-3", className)}>
      {matchedPattern && (
        <div className="min-w-0 flex-1">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {patternLabel}
          </span>
          <div className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-amber-100 px-2.5 py-1.5 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            <Zap className="size-3 shrink-0" />
            <span className="truncate">{matchedPattern}</span>
          </div>
        </div>
      )}

      {(matchedPattern || isRouting) && (targetAgent || isRouting) && (
        <div className="flex items-center justify-center py-4">
          <div className={cn("relative flex items-center", isRouting && "animate-pulse")}>
            <div
              className={cn(
                "h-0.5 w-8 rounded-full",
                isRouting ? "bg-indigo-400 dark:bg-indigo-600" : "bg-muted-foreground/30",
              )}
            />
            <ArrowRight
              className={cn(
                "-ml-1 size-4",
                isRouting ? "text-indigo-500 dark:text-indigo-400" : "text-muted-foreground/50",
              )}
            />
          </div>
        </div>
      )}

      {(targetAgent || isRouting) && (
        <div className="min-w-0 flex-1">
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {targetLabel}
          </span>
          {isRouting && !targetAgent ? (
            <div className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
              <CircleDashed className="size-3.5 animate-spin" />
              Décision en cours…
            </div>
          ) : (
            <div className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-green-100 px-2.5 py-1.5 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
              <Bot className="size-3.5 shrink-0" />
              <span className="truncate">{targetAgent}</span>
              {confidence !== undefined && (
                <span className="ml-1 rounded bg-green-200 px-1 py-0.5 font-mono text-[10px] dark:bg-green-900">
                  {Math.round(confidence * 100)}%
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface AiRoutingIndicatorEmptyProps {
  children?: React.ReactNode;
  className?: string;
}

function AiRoutingIndicatorEmpty({ children, className }: AiRoutingIndicatorEmptyProps) {
  return (
    <div
      data-slot="ai-routing-indicator-empty"
      className={cn("flex flex-col items-center justify-center py-8 text-center", className)}
    >
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
        <Route className="size-6 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground">{children || "Aucun routage à afficher"}</p>
    </div>
  );
}

interface AiRoutingMatchProps {
  pattern: string;
  text: string;
  className?: string;
}

function AiRoutingMatch({ pattern, text, className }: AiRoutingMatchProps) {
  return (
    <div
      data-slot="ai-routing-match"
      className={cn("flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs", className)}
    >
      <span className="font-mono text-amber-600 dark:text-amber-400">{pattern}</span>
      <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground">{text}</span>
    </div>
  );
}

export {
  AiRoutingIndicator,
  AiRoutingIndicatorHeader,
  AiRoutingIndicatorContent,
  AiRoutingInput,
  AiRoutingFlow,
  AiRoutingIndicatorEmpty,
  AiRoutingMatch,
};
export type { AiRoutingIndicatorProps };

export default AiRoutingIndicator;
