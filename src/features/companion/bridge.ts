import { useCallback, useEffect, useRef, useState } from "react";
import type { PageCapture, PickedElement } from "./contextBlocks";

/**
 * The app side of the browser panel.
 *
 * In the extension, this page runs inside an iframe of the side panel
 * (browser-recorder/src/panel.html). The panel is an extension page: it can
 * read the active tab, highlight in it, follow tab changes — none of which a
 * web page can do. The two talk by postMessage, and each side checks who it is
 * talking to: here, only the direct parent, and only an extension origin.
 *
 * Outside the extension (the page opened in a normal tab), the hook simply
 * reports `inPanel: false` and every page feature is hidden.
 */

export interface CompanionTab {
  id: number;
  url: string;
  host: string;
  title: string;
  favIconUrl: string | null;
  injectable: boolean;
}

export type SelectionAction = "ask" | "explain" | "summarize" | "translate";

export type CompanionIntent =
  | { kind: "send_page"; url?: string; title?: string }
  | { kind: "selection"; action?: SelectionAction; text: string; url?: string; title?: string }
  | { kind: "link"; url: string; text?: string; page?: string }
  | { kind: "pick" }
  | { kind: "focus" }
  | { kind: "open_conversation"; conversation_id?: string; agent_id?: string };

export interface FeedItem {
  id: string;
  kind: "reply" | "question" | "approval";
  interim?: boolean;
  conversation_id: string;
  agent: { id: string; name: string };
  text: string;
  options: string[];
  at: string;
}

export type DeviceState = "unknown" | "paired" | "pairing" | "other_project" | "error";

interface Handlers {
  onIntent?: (intent: CompanionIntent) => void;
  onFeed?: (items: FeedItem[]) => void;
  onPairCode?: (code: string) => void;
}

const EXT_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\//;
const SESSION_FLAG = "anduran.companion.ext";

/** Inside the side panel? The panel loads `/companion?ext=<version>`; the flag
 *  survives the redirect to the project URL, which drops the query string. */
export function detectPanel(): boolean {
  if (typeof window === "undefined" || window.parent === window) return false;
  try {
    const v = new URLSearchParams(window.location.search).get("ext");
    if (v) sessionStorage.setItem(SESSION_FLAG, v);
    return !!(v || sessionStorage.getItem(SESSION_FLAG));
  } catch {
    return true;
  }
}

export function useCompanionBridge(opts: { signedIn: boolean } & Handlers) {
  const inPanel = useRef(detectPanel()).current;
  const parentOrigin = useRef<string | null>(null);
  const handlers = useRef<Handlers>(opts);
  handlers.current = opts;
  const pending = useRef(new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>());

  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [tab, setTab] = useState<CompanionTab | null>(null);
  const [device, setDevice] = useState<{ state: DeviceState; error?: string }>({ state: "unknown" });
  const [prefs, setPrefs] = useState<{ bubbles: boolean; selectionPill: boolean }>({ bubbles: true, selectionPill: true });

  const post = useCallback((msg: Record<string, unknown>) => {
    if (!inPanel) return;
    // Before the panel's hello we don't know its exact origin yet; only the
    // `ready` handshake goes out this way, and it carries nothing personal.
    window.parent.postMessage({ __anduran: 1, ...msg }, parentOrigin.current ?? "*");
  }, [inPanel]);

  useEffect(() => {
    if (!inPanel) return;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || !EXT_ORIGIN.test(e.origin)) return;
      const m = e.data as Record<string, unknown> & { __anduran?: number; type?: string };
      if (!m || m.__anduran !== 1) return;
      parentOrigin.current = e.origin;
      switch (m.type) {
        case "hello":
          setConnected(true);
          setVersion(String(m.version ?? ""));
          setTab((m.tab as CompanionTab | null) ?? null);
          if (m.prefs) setPrefs((p) => ({ ...p, ...(m.prefs as object) }));
          if ((m.device as { paired?: boolean } | undefined)?.paired) setDevice({ state: "paired" });
          return;
        case "tab":
          setTab((m.tab as CompanionTab | null) ?? null);
          return;
        case "intent":
          handlers.current.onIntent?.(m.intent as CompanionIntent);
          return;
        case "feed":
          handlers.current.onFeed?.((m.items as FeedItem[]) ?? []);
          return;
        case "pair_code":
          setDevice({ state: "pairing" });
          handlers.current.onPairCode?.(String(m.code ?? ""));
          return;
        case "device":
          setDevice({ state: (m.state as DeviceState) ?? "unknown", error: m.error as string | undefined });
          return;
        case "response": {
          const p = pending.current.get(String(m.id));
          if (!p) return;
          pending.current.delete(String(m.id));
          window.clearTimeout(p.timer);
          if (m.ok) p.resolve(m.data);
          else p.reject(new Error(String(m.error ?? "échec")));
          return;
        }
        default:
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [inPanel]);

  // The handshake, re-sent when the session changes: signing in inside the
  // panel is what makes pairing possible.
  useEffect(() => {
    if (!inPanel) return;
    post({ type: "ready", supabaseUrl: import.meta.env.VITE_SUPABASE_URL, user: opts.signedIn });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inPanel, opts.signedIn]);

  const request = useCallback(<T,>(op: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> => {
    if (!inPanel) return Promise.reject(new Error("Disponible dans le panneau du navigateur seulement."));
    const id = Math.random().toString(36).slice(2);
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.current.delete(id);
        reject(new Error("Le navigateur n'a pas répondu."));
      }, timeoutMs);
      pending.current.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      post({ type: "request", id, op, args });
    });
  }, [inPanel, post]);

  return {
    inPanel,
    connected,
    version,
    tab,
    device,
    setDevice,
    prefs,
    setPrefs,
    post,
    capturePage: (offset?: number) => request<PageCapture>("capture_page", { offset }),
    captureSelection: () => request<string>("capture_selection"),
    pickElement: () => request<PickedElement & { ok: boolean; cancelled?: boolean }>("pick", {}, 180_000),
    highlight: (targets: Array<Record<string, string>>, agent?: string) => request("highlight", { targets, agent }),
    openTab: (url: string) => request("open_tab", { url }),
  };
}

export type CompanionBridge = ReturnType<typeof useCompanionBridge>;
