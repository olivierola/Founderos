import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** An agent the assistant is currently configuring — drives the setup card deck. */
export interface AssistantAgentContext {
  id: string;
  name: string;
}

/** A prompt handed to the assistant by a page (e.g. "configure this agent"). */
export interface AssistantRequest {
  prompt: string;
  /** Send it straight away instead of only pre-filling the composer. */
  autoSend?: boolean;
  /** Start a fresh conversation — a configuration hand-off shouldn't land in
   *  the middle of an unrelated thread. */
  newChat?: boolean;
  /** Bumped on every ask() so the same prompt twice still fires the panel. */
  nonce: number;
}

interface AssistantCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  /** True inside the provider — pages outside the app shell can fall back. */
  available: boolean;
  /** Open the panel, optionally with a prompt and/or an agent to configure. */
  ask: (req: Partial<Omit<AssistantRequest, "nonce">> & { agent?: AssistantAgentContext | null }) => void;
  request: AssistantRequest | null;
  clearRequest: () => void;
  /** The agent whose setup cards the panel shows, if any. */
  agent: AssistantAgentContext | null;
  setAgent: (a: AssistantAgentContext | null) => void;
}

const Ctx = createContext<AssistantCtx | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<AssistantRequest | null>(null);
  const [agent, setAgent] = useState<AssistantAgentContext | null>(null);

  const ask = useCallback((req: Partial<Omit<AssistantRequest, "nonce">> & { agent?: AssistantAgentContext | null }) => {
    // `agent` present (even null) means "switch the setup deck"; absent leaves it.
    if ("agent" in req) setAgent(req.agent ?? null);
    if (req.prompt) setRequest({ ...req, prompt: req.prompt, nonce: Date.now() });
    setOpen(true);
  }, []);

  const value = useMemo<AssistantCtx>(
    () => ({
      open,
      setOpen,
      toggle: () => setOpen((o) => !o),
      available: true,
      ask,
      request,
      clearRequest: () => setRequest(null),
      agent,
      setAgent,
    }),
    [open, request, ask, agent],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const NOOP: AssistantCtx = {
  open: false,
  setOpen: () => {},
  toggle: () => {},
  available: false,
  ask: () => {},
  request: null,
  clearRequest: () => {},
  agent: null,
  setAgent: () => {},
};

export function useAssistant(): AssistantCtx {
  return useContext(Ctx) ?? NOOP;
}
