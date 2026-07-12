import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from "react";
import { listAgents, type Agent } from "./api";
import { useSession } from "./session-context";

interface AgentsContextValue {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  get: (id: string) => Agent | undefined;
}

const AgentsContext = createContext<AgentsContextValue | null>(null);

export function AgentsProvider({ children }: { children: ReactNode }) {
  const { session, getToken } = useSession();
  const userId = session?.user.id ?? null;

  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) { setAgents([]); return; }
    setError(null);
    setLoading(true);
    try {
      const token = await getToken();
      setAgents(await listAgents(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec du chargement des agents");
    } finally {
      setLoading(false);
    }
  }, [userId, getToken]);

  // Load (or clear) whenever the signed-in user changes.
  useEffect(() => { refresh(); }, [userId, refresh]);

  const get = useCallback((id: string) => agents.find((a) => a.id === id), [agents]);

  const value = useMemo<AgentsContextValue>(
    () => ({ agents, loading, error, refresh, get }),
    [agents, loading, error, refresh, get],
  );

  return <AgentsContext.Provider value={value}>{children}</AgentsContext.Provider>;
}

export function useAgents(): AgentsContextValue {
  const ctx = useContext(AgentsContext);
  if (!ctx) throw new Error("useAgents must be used within <AgentsProvider>");
  return ctx;
}
