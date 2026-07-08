import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from "react";
import { loadAgents, persistAgents, type RegisteredAgent } from "./storage";

interface AgentsContextValue {
  agents: RegisteredAgent[];
  loading: boolean;
  add: (agent: Omit<RegisteredAgent, "addedAt">) => Promise<void>;
  remove: (id: string) => Promise<void>;
  get: (id: string) => RegisteredAgent | undefined;
}

const AgentsContext = createContext<AgentsContextValue | null>(null);

export function AgentsProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAgents()
      .then(setAgents)
      .finally(() => setLoading(false));
  }, []);

  const persist = useCallback(async (next: RegisteredAgent[]) => {
    setAgents(next);
    await persistAgents(next);
  }, []);

  const add = useCallback<AgentsContextValue["add"]>(
    async (agent) => {
      const entry: RegisteredAgent = { ...agent, addedAt: new Date().toISOString() };
      // Replace on duplicate id (re-registering updates the secret/name).
      const next = [entry, ...agents.filter((a) => a.id !== agent.id)];
      await persist(next);
    },
    [agents, persist],
  );

  const remove = useCallback<AgentsContextValue["remove"]>(
    async (id) => {
      await persist(agents.filter((a) => a.id !== id));
    },
    [agents, persist],
  );

  const get = useCallback(
    (id: string) => agents.find((a) => a.id === id),
    [agents],
  );

  const value = useMemo(
    () => ({ agents, loading, add, remove, get }),
    [agents, loading, add, remove, get],
  );

  return <AgentsContext.Provider value={value}>{children}</AgentsContext.Provider>;
}

export function useAgents(): AgentsContextValue {
  const ctx = useContext(AgentsContext);
  if (!ctx) throw new Error("useAgents must be used within <AgentsProvider>");
  return ctx;
}
