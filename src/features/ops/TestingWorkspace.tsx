import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { FlaskConical, MonitorPlay, BarChart3, FileText, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { TestsTab } from "./TestingPage";
import { LiveTab } from "./TestingLive";
import { AnalyticsTab, ReportsTab, ObservabilityTab } from "./TestingInsights";

type TabKey = "tests" | "live" | "analytics" | "reports" | "observability";

const TABS: { key: TabKey; label: string; icon: any }[] = [
  { key: "tests", label: "Tests", icon: FlaskConical },
  { key: "live", label: "Live", icon: MonitorPlay },
  { key: "analytics", label: "Analytics", icon: BarChart3 },
  { key: "reports", label: "Reports", icon: FileText },
  { key: "observability", label: "Observability", icon: Activity },
];

export function OpsTestingPage() {
  const { projectId } = useCurrentContext();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as TabKey) || "tests";
  // The Live tab tracks which run is being watched (?run=).
  const activeRun = params.get("run");

  const setTab = (key: TabKey, extra?: Record<string, string>) => {
    const next = new URLSearchParams(params);
    next.set("tab", key);
    if (extra) for (const [k, v] of Object.entries(extra)) next.set(k, v);
    setParams(next, { replace: false });
  };

  const openRun = (runId: string) => setTab("live", { run: runId });

  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Title + tab bar */}
      <div className="border-b border-border px-6 pt-4">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-primary" />
          <h1 className="text-base font-semibold">Testing</h1>
          <span className="text-xs text-muted-foreground">· agentic end-to-end</span>
        </div>
        <div className="mt-3 flex gap-1">
          {TABS.map((t) => {
            const active = t.key === tab;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors",
                  active
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {/* Live is edge-to-edge (the app canvas + chat fill the area). Every
            other tab keeps the usual centred margins like the rest of the app. */}
        {tab === "live" ? (
          <LiveTab
            runId={activeRun}
            onSelectRun={(id) => setTab("live", { run: id })}
            onCreateInTests={() => setTab("tests")}
          />
        ) : (
          <div className="h-full overflow-y-auto px-4 py-6 sm:px-6 lg:px-12 xl:px-20">
            <div className="mx-auto w-full max-w-6xl">
              {tab === "tests" && <TestsTab onOpenRun={openRun} />}
              {tab === "analytics" && <AnalyticsTab />}
              {tab === "reports" && <ReportsTab onOpenRun={openRun} />}
              {tab === "observability" && <ObservabilityTab runId={activeRun} onOpenRun={openRun} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
