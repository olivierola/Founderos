import {
  createContext, useContext, useEffect, useState,
  type ReactNode, type ComponentType,
} from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Topbar breadcrumb — a page can publish extra breadcrumb segments (beyond the
// workspace/project chips) into the main navbar breadcrumb. Used by the CRM
// record view to surface "Autonomous agents / Support Concierge" up in the
// navbar instead of a separate breadcrumb bar inside the page. When a page
// publishes nothing, the Topbar falls back to the module/sub derived from the
// route.
//
// Split state/dispatch contexts (same rationale as TopbarTabs): registering a
// page's crumbs only needs the setter, whose identity is stable, so the effect
// never thrashes. `items` MUST be a stable/memoised reference from the caller.
// ─────────────────────────────────────────────────────────────────────────────

export interface Crumb {
  label: string;
  to?: string;
  icon?: ComponentType<{ className?: string }>;
}

type SetCrumbs = (items: Crumb[] | null) => void;

const StateContext = createContext<Crumb[] | null>(null);
const SetStateContext = createContext<SetCrumbs | null>(null);

export function TopbarBreadcrumbProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Crumb[] | null>(null);
  return (
    <SetStateContext.Provider value={setItems}>
      <StateContext.Provider value={items}>{children}</StateContext.Provider>
    </SetStateContext.Provider>
  );
}

/** Read the currently-published breadcrumb segments. Used by the Topbar. */
export function useTopbarBreadcrumb(): Crumb[] | null {
  return useContext(StateContext);
}

/**
 * Publish a page's breadcrumb segments into the navbar. Pass `null` (or an empty
 * array) when the page has none. Clears automatically on unmount. `items` is
 * expected to be a stable reference (e.g. a memoised value).
 */
export function useRegisterTopbarBreadcrumb(items: Crumb[] | null) {
  const setItems = useContext(SetStateContext);
  useEffect(() => {
    if (!setItems) return;
    if (!items || items.length === 0) {
      setItems(null);
      return;
    }
    setItems(items);
    return () => setItems(null);
  }, [setItems, items]);
}
