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
  /** La largeur du panneau ancré — partagée avec la barre du haut, dont la
   *  zone de droite devient l'en-tête de l'assistant, à la même largeur. */
  width: number;
  setWidth: (w: number) => void;
}

/** L'élément de la barre du haut qui porte l'en-tête de l'assistant ancré. */
export const ASSISTANT_NAV_SLOT_ID = "assistant-nav-slot";

export const ASSISTANT_MIN_W = 360;
export const ASSISTANT_MAX_W = 820;
const ASSISTANT_DEFAULT_W = 440;

function readWidth(): number {
  try {
    const saved = Number(localStorage.getItem("assistant_width"));
    return saved >= ASSISTANT_MIN_W && saved <= ASSISTANT_MAX_W ? saved : ASSISTANT_DEFAULT_W;
  } catch { return ASSISTANT_DEFAULT_W; }
}

const Ctx = createContext<AssistantCtx | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<AssistantRequest | null>(null);
  const [agent, setAgent] = useState<AssistantAgentContext | null>(null);
  const [width, setWidthState] = useState<number>(readWidth);
  const setWidth = useCallback((w: number) => {
    const next = Math.min(ASSISTANT_MAX_W, Math.max(ASSISTANT_MIN_W, Math.round(w)));
    setWidthState(next);
    try { localStorage.setItem("assistant_width", String(next)); } catch { /* navigation privée */ }
  }, []);

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
      width,
      setWidth,
    }),
    [open, request, ask, agent, width, setWidth],
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
  width: ASSISTANT_DEFAULT_W,
  setWidth: () => {},
};

export function useAssistant(): AssistantCtx {
  return useContext(Ctx) ?? NOOP;
}
