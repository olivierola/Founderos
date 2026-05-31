import { useSearchParams } from "react-router-dom";
import { LayoutDashboard, Workflow, Route, ListChecks, BarChart3, FolderTree } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  OnboardingOverviewPage,
  OnboardingFlowsPage,
  OnboardingToursPage,
  OnboardingChecklistPage,
  OnboardingAnalyticsPage,
} from "./OnboardingPages";
import { OnboardingTreePage } from "./OnboardingTreePage";

type Tab = "overview" | "flows" | "tours" | "checklist" | "analytics" | "tree";

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "flows", label: "Flows", icon: Workflow },
  { id: "tours", label: "Tours", icon: Route },
  { id: "checklist", label: "Checklist", icon: ListChecks },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "tree", label: "Tree", icon: FolderTree },
];

export function OnboardingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get("tab") as Tab) || "overview";

  function setTab(t: Tab) {
    const next = new URLSearchParams(searchParams);
    next.set("tab", t);
    setSearchParams(next, { replace: true });
  }

  return (
    <div>
      {/* Internal tabs */}
      <div className="mb-4 flex items-center gap-1 border-b border-border">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "relative inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
              {active && (
                <span className="absolute -bottom-px left-2 right-2 h-0.5 rounded-t bg-[hsl(var(--primary-soft))]" />
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {tab === "overview" && <OnboardingOverviewPage />}
      {tab === "flows" && <OnboardingFlowsPage />}
      {tab === "tours" && <OnboardingToursPage />}
      {tab === "checklist" && <OnboardingChecklistPage />}
      {tab === "analytics" && <OnboardingAnalyticsPage />}
      {tab === "tree" && <OnboardingTreePage />}
    </div>
  );
}
