import {
  createContext, useContext, useEffect, useRef, useState,
  type ReactNode, type ComponentType,
} from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Topbar tabs — a page (a second-sidebar tab's content) can publish its own
// horizontal sub-tabs into the Topbar, where the breadcrumb used to sit. Think
// of the Personnaliser tab surfacing Instructions · Skills · Memory · Connectors
// up in the header instead of inside the content. Any page that has internal
// sub-tabs can register them; the Topbar renders whatever is registered, or
// nothing when a page has none ("si nécessaire").
//
// State and dispatch live in separate contexts so that registering a page's
// tabs (which only needs the setter) never re-subscribes to state changes — the
// setter's identity is stable, so the register effect can't thrash/loop.
// ─────────────────────────────────────────────────────────────────────────────

export interface TopbarTab {
  key: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
}

export interface TopbarTabsState {
  tabs: TopbarTab[];
  activeKey: string;
  onSelect: (key: string) => void;
}

type SetState = (s: TopbarTabsState | null) => void;

const StateContext = createContext<TopbarTabsState | null>(null);
const SetStateContext = createContext<SetState | null>(null);

export function TopbarTabsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TopbarTabsState | null>(null);
  return (
    <SetStateContext.Provider value={setState}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </SetStateContext.Provider>
  );
}

/** Read the currently-registered sub-tabs. Used by the Topbar. */
export function useTopbarTabs(): TopbarTabsState | null {
  return useContext(StateContext);
}

/**
 * Publish a page's sub-tabs into the Topbar. Pass `tabs = null` (or an empty
 * array) when the page has none. Clears automatically on unmount. `tabs` is
 * expected to be a stable reference (e.g. a module-level constant or a memoised
 * value); `onSelect` may change freely — it is kept fresh through a ref so it
 * never re-triggers the effect.
 */
export function useRegisterTopbarTabs(
  tabs: TopbarTab[] | null,
  activeKey: string,
  onSelect: (key: string) => void,
) {
  const setState = useContext(SetStateContext);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!setState) return;
    if (!tabs || tabs.length === 0) {
      setState(null);
      return;
    }
    setState({ tabs, activeKey, onSelect: (k) => onSelectRef.current(k) });
    return () => setState(null);
    // onSelect is intentionally excluded — it is read through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setState, tabs, activeKey]);
}
