import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { TestsTab } from "./TestingPage";
import { LiveTab } from "./TestingLive";
import { AnalyticsTab, ReportsTab, ObservabilityTab } from "./TestingInsights";

type TabKey = "tests" | "live" | "analytics" | "reports" | "observability";
const KEYS: TabKey[] = ["tests", "live", "analytics", "reports", "observability"];

// Test runs module — the tab is the route sub-slug (/test-runs/<tab>); onglets
// are rendered by the SecondarySidebar. The Live tab tracks the watched run via
// ?run=.
export function TestRunsPage() {
  const { projectId, workspace, project } = useCurrentContext();
  const { sub } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const tab: TabKey = KEYS.includes(sub as TabKey) ? (sub as TabKey) : "tests";
  const activeRun = params.get("run");
  const base = workspace && project ? `/app/${workspace.slug}/${project.slug}/test-runs` : "";
  const openRun = (runId: string) => navigate(`${base}/live?run=${runId}`);

  if (!projectId) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "live" ? (
          <LiveTab
            runId={activeRun}
            onSelectRun={(id) => navigate(`${base}/live?run=${id}`)}
            onCreateInTests={() => navigate(`${base}/tests`)}
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
