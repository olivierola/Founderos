import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { dashboardOfModule, DEFAULT_DASHBOARD, type DashboardId } from "@/lib/navigation";

const KEY = "founderos.activeDashboard";

/**
 * Resolves the active dashboard from the current route's module. Shared modules
 * ("both", e.g. Settings/Integrations) or non-module routes keep the last
 * dashboard the user was on (persisted), so switching doesn't flip unexpectedly.
 */
export function useActiveDashboard(): DashboardId {
  const location = useLocation();
  const segs = location.pathname.split("/").filter(Boolean);
  const appIdx = segs.indexOf("app");
  const moduleSlug = appIdx >= 0 ? segs[appIdx + 3] : undefined;
  const owner = dashboardOfModule(moduleSlug); // "workforce" | "tools" | "both"

  useEffect(() => {
    if (owner === "workforce" || owner === "tools") {
      try { localStorage.setItem(KEY, owner); } catch { /* ignore */ }
    }
  }, [owner]);

  if (owner === "workforce" || owner === "tools") return owner;
  try {
    const stored = localStorage.getItem(KEY) as DashboardId | null;
    if (stored === "workforce" || stored === "tools") return stored;
  } catch { /* ignore */ }
  return DEFAULT_DASHBOARD;
}
