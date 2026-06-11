// Canonical FounderOS SDK sources, embedded server-side.
//
// WHY: the install_sdk agent tool must inject the REAL SDK, byte-for-byte — not
// whatever a small model might hallucinate (e.g. a non-existent `git clone
// founderos/sdk` or `founderos.configure(api_secret=...)`). The LLM only supplies
// configuration (host, project_id, where to initialize); the file contents come
// from here.
//
// Keep these in sync with /sdk/js/founderos.ts (the published source of truth).

/** The full JS/TS analytics SDK — identical to sdk/js/founderos.ts. */
export const SDK_JS_FOUNDEROS_TS = String.raw`/**
 * FounderOS analytics SDK — JavaScript / TypeScript.
 *
 * Works in two runtimes from one file:
 *   - Browser: event tracking + optional rrweb session replay recording.
 *   - Node / Deno / Bun (server): event tracking with batching, API-key auth.
 *
 * Endpoints (Supabase edge functions):
 *   POST {host}/functions/v1/track-event           — product events
 *   POST {host}/functions/v1/ingest-session-replay  — rrweb batches (browser)
 *
 * Browser auth uses the anon key + workspaceId. Server auth uses an \`fos_\` API
 * key (issued in Integrations → API Keys) via the Authorization header; the
 * workspace is then resolved from the key, so only projectId is required.
 */

export interface FounderOSConfig {
  /** Supabase project URL, e.g. https://xxxx.supabase.co */
  host: string;
  /** The project (cockpit) you are sending events for. */
  projectId: string;
  /** Workspace id — required in the browser; omit on the server when using apiKey. */
  workspaceId?: string;
  /** Supabase anon key — required in the browser. */
  anonKey?: string;
  /** Server API key (\`fos_...\`) — server only; never expose in the browser. */
  apiKey?: string;
  /** Flush the queue automatically every N ms (default 5000). 0 disables. */
  flushIntervalMs?: number;
  /** Max events buffered before an automatic flush (default 20). */
  batchSize?: number;
  /** Enable console diagnostics. */
  debug?: boolean;
}

export interface TrackOptions {
  /** Stable user identifier — an email or your own id. */
  distinctId?: string;
  /** Arbitrary event properties. */
  properties?: Record<string, unknown>;
  /** Override the event time (ISO string). Defaults to now. */
  occurredAt?: string;
}

interface QueuedEvent {
  event_name: string;
  distinct_id?: string;
  properties?: Record<string, unknown>;
  occurred_at?: string;
}

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

export class FounderOS {
  private cfg: Required<Pick<FounderOSConfig, "flushIntervalMs" | "batchSize">> & FounderOSConfig;
  private queue: QueuedEvent[] = [];
  private distinctId?: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private recorderStop: (() => void) | null = null;

  constructor(config: FounderOSConfig) {
    this.cfg = { flushIntervalMs: 5000, batchSize: 20, ...config };
    if (!this.cfg.host || !this.cfg.projectId) {
      throw new Error("FounderOS: host and projectId are required");
    }
    if (isBrowser && !this.cfg.anonKey) {
      this.log("warning: no anonKey set — browser ingestion will be rejected");
    }
    if (this.cfg.flushIntervalMs > 0) {
      this.timer = setInterval(() => void this.flush(), this.cfg.flushIntervalMs);
      // Don't keep a Node process alive just for the flush timer.
      (this.timer as { unref?: () => void }).unref?.();
    }
    if (isBrowser) {
      // Best-effort flush when the tab is hidden / closed.
      window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void this.flush(true);
      });
    }
  }

  /** Associate subsequent events with a user. */
  identify(distinctId: string, properties?: Record<string, unknown>): void {
    this.distinctId = distinctId;
    if (properties) this.track("$identify", { distinctId, properties });
  }

  /** Queue an event. It is sent on the next flush (or immediately if full). */
  track(eventName: string, opts: TrackOptions = {}): void {
    this.queue.push({
      event_name: eventName,
      distinct_id: opts.distinctId ?? this.distinctId,
      properties: opts.properties,
      occurred_at: opts.occurredAt,
    });
    if (this.queue.length >= this.cfg.batchSize) void this.flush();
  }

  /**
   * Browser-only: lightweight auto-capture. Tracks:
   *   - \`page_view\` on initial load and on SPA navigations (history API + popstate)
   *   - clicks on elements annotated with \`data-fos-event="name"\` (plus optional
   *     \`data-fos-*\` attributes folded into properties)
   * Returns a stop function. Safe no-op on the server.
   */
  autocapture(opts: { pageViews?: boolean; clicks?: boolean } = {}): () => void {
    if (!isBrowser) return () => {};
    const pageViews = opts.pageViews !== false;
    const clicks = opts.clicks !== false;
    const cleanups: Array<() => void> = [];

    if (pageViews) {
      const emitView = () =>
        this.track("page_view", { properties: { path: location.pathname, url: location.href, title: document.title } });
      emitView();
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      history.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
        const r = origPush.apply(this, args);
        emitView();
        return r;
      };
      history.replaceState = function (this: History, ...args: Parameters<History["replaceState"]>) {
        const r = origReplace.apply(this, args);
        emitView();
        return r;
      };
      const onPop = () => emitView();
      window.addEventListener("popstate", onPop);
      cleanups.push(() => {
        history.pushState = origPush;
        history.replaceState = origReplace;
        window.removeEventListener("popstate", onPop);
      });
    }

    if (clicks) {
      const onClick = (e: MouseEvent) => {
        const el = (e.target as Element | null)?.closest?.("[data-fos-event]") as HTMLElement | null;
        if (!el) return;
        const name = el.getAttribute("data-fos-event");
        if (!name) return;
        const props: Record<string, unknown> = {};
        for (const a of Array.from(el.attributes)) {
          if (a.name.startsWith("data-fos-") && a.name !== "data-fos-event") {
            props[a.name.slice("data-fos-".length)] = a.value;
          }
        }
        this.track(name, { properties: props });
      };
      document.addEventListener("click", onClick, true);
      cleanups.push(() => document.removeEventListener("click", onClick, true));
    }

    return () => cleanups.forEach((c) => c());
  }

  // ── Feature flags ──
  private flagsCache: Record<string, boolean> | null = null;

  /**
   * Load the project's feature flags (evaluated for the current user) and cache
   * them. Call once after identify(); then use isFeatureEnabled(key) synchronously.
   * Returns the flag map.
   */
  async loadFlags(): Promise<Record<string, boolean>> {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.cfg.apiKey) headers["Authorization"] = \`Bearer \${this.cfg.apiKey}\`;
      if (this.cfg.anonKey) headers["apikey"] = this.cfg.anonKey;
      const res = await fetch(\`\${this.cfg.host}/functions/v1/public-feature-flags\`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          workspace_id: this.cfg.workspaceId,
          project_id: this.cfg.projectId,
          distinct_id: this.distinctId,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { flags?: Record<string, boolean> };
        this.flagsCache = data.flags ?? {};
      }
    } catch (err) {
      this.log(\`loadFlags failed: \${(err as Error).message}\`);
    }
    return this.flagsCache ?? {};
  }

  /**
   * Synchronous flag check. Returns \`fallback\` (default false) until loadFlags()
   * has resolved. Call loadFlags() early (e.g. after identify) to populate.
   */
  isFeatureEnabled(flagKey: string, fallback = false): boolean {
    if (!this.flagsCache) return fallback;
    return this.flagsCache[flagKey] ?? fallback;
  }

  /** Send all queued events now. \`keepalive\` uses fetch keepalive for unloads. */
  async flush(keepalive = false): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await this.post(
        "track-event",
        { project_id: this.cfg.projectId, workspace_id: this.cfg.workspaceId, batch },
        keepalive,
      );
      this.log(\`flushed \${batch.length} events\`);
    } catch (err) {
      // Re-queue on failure so events aren't lost (bounded to avoid unbounded growth).
      this.queue = [...batch, ...this.queue].slice(0, 1000);
      this.log(\`flush failed, re-queued: \${(err as Error).message}\`);
    }
  }

  /**
   * Browser-only: start recording a session replay with rrweb. Pass the rrweb
   * \`record\` function (so the host app controls the rrweb version/bundle):
   *
   *   import { record } from "rrweb";
   *   fos.startSessionRecording(record, { maskAllInputs: true });
   *
   * Events are batched and shipped to ingest-session-replay. Returns a stop fn.
   */
  startSessionRecording(
    record: (opts: Record<string, unknown>) => (() => void) | undefined,
    rrwebOptions: Record<string, unknown> = {},
  ): () => void {
    if (!isBrowser) {
      this.log("startSessionRecording is a no-op outside the browser");
      return () => {};
    }
    const clientSessionId = this.uuid();
    let chunk = 0;
    let buffer: unknown[] = [];
    let rageWindow: number[] = [];
    let rageClicks = 0;
    let errors = 0;

    const shipChunk = (final = false) => {
      if (buffer.length === 0) return;
      const events = buffer;
      buffer = [];
      const meta =
        chunk === 0
          ? {
              entry_url: location.href,
              user_agent: navigator.userAgent,
              device: this.guessDevice(),
              user_email: this.distinctId?.includes("@") ? this.distinctId : undefined,
              customer_external_id: this.distinctId && !this.distinctId.includes("@") ? this.distinctId : undefined,
            }
          : undefined;
      void this.post(
        "ingest-session-replay",
        {
          workspace_id: this.cfg.workspaceId,
          project_id: this.cfg.projectId,
          client_session_id: clientSessionId,
          chunk: chunk++,
          events,
          meta,
          signals: { rage_clicks: rageClicks, errors, pages: 1 },
        },
        final,
      ).catch((e) => this.log(\`replay ship failed: \${(e as Error).message}\`));
      rageClicks = 0;
      errors = 0;
    };

    // rrweb emit → buffer; ship on size or interval.
    const stopRecord = record({
      emit: (event: unknown) => {
        buffer.push(event);
        if (buffer.length >= 100) shipChunk();
      },
      maskAllInputs: true,
      ...rrwebOptions,
    });

    // Rage-click heuristic: 3+ clicks within 800ms at roughly the same spot.
    const onClick = (e: MouseEvent) => {
      const now = Date.now();
      rageWindow = rageWindow.filter((t) => now - t < 800);
      rageWindow.push(now);
      if (rageWindow.length >= 3) {
        rageClicks++;
        rageWindow = [];
      }
      void e;
    };
    const onError = () => {
      errors++;
    };
    window.addEventListener("click", onClick, true);
    window.addEventListener("error", onError);

    const interval = setInterval(() => shipChunk(), 5000);
    const onHide = () => {
      if (document.visibilityState === "hidden") shipChunk(true);
    };
    window.addEventListener("visibilitychange", onHide);

    this.recorderStop = () => {
      clearInterval(interval);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("error", onError);
      window.removeEventListener("visibilitychange", onHide);
      stopRecord?.();
      shipChunk(true);
    };
    return this.recorderStop;
  }

  /** Stop recording and flush everything. Call on shutdown. */
  async shutdown(): Promise<void> {
    this.recorderStop?.();
    this.recorderStop = null;
    if (this.timer) clearInterval(this.timer);
    await this.flush(true);
  }

  // ── internals ──
  private async post(fn: string, body: unknown, keepalive = false): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.apiKey) headers["Authorization"] = \`Bearer \${this.cfg.apiKey}\`;
    if (this.cfg.anonKey) headers["apikey"] = this.cfg.anonKey;
    const res = await fetch(\`\${this.cfg.host}/functions/v1/\${fn}\`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      keepalive: keepalive && isBrowser,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(\`\${fn} \${res.status}: \${text.slice(0, 200)}\`);
    }
  }

  private guessDevice(): string {
    const ua = navigator.userAgent;
    if (/iPad|Tablet/i.test(ua)) return "tablet";
    if (/Mobi|Android|iPhone/i.test(ua)) return "mobile";
    return "desktop";
  }

  private uuid(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  private log(msg: string): void {
    if (this.cfg.debug) console.log(\`[founderos] \${msg}\`);
  }
}

/** Convenience factory. */
export function createClient(config: FounderOSConfig): FounderOS {
  return new FounderOS(config);
}
`;

export interface SdkFileChange {
  path: string;
  content: string;
}

export interface InstallSdkParams {
  sdk: "analytics" | "rag";
  runtime: "browser" | "server";
  host: string;
  projectId: string;
  /** Browser only. */
  workspaceId?: string;
  anonKeyExpr?: string; // e.g. "import.meta.env.VITE_SUPABASE_ANON_KEY"
  apiKeyExpr?: string; // server, e.g. "process.env.FOUNDEROS_API_KEY"
  /** Where to drop the SDK + init module (repo-relative dir). Default "src/lib". */
  libDir?: string;
  /** RAG only: the agent's public key (rag_agents.public_key). */
  agentPublicKey?: string;
  /** RAG only: greeting bubble text. */
  agentWelcome?: string;
}

/**
 * Build the real file set for an SDK install. Returns the canonical SDK file(s)
 * plus a small init module wired to the caller's config. The LLM never provides
 * the SDK body — only the config that feeds this generator.
 */
export function buildSdkInstall(p: InstallSdkParams): { files: SdkFileChange[]; notes: string } {
  const dir = (p.libDir || "src/lib").replace(/\/+$/, "");

  if (p.sdk === "rag") {
    // The RAG agent ships as a hosted widget script, not a copied SDK file.
    // The edge-served widget reads window.FounderOSAgent (key + endpoint) —
    // a bare script tag with data-* attributes would NOT boot it.
    const key = p.agentPublicKey || "<AGENT_PUBLIC_KEY — copy it from RAG Agent → Agents → Widget>";
    const welcome = (p.agentWelcome || "Hi! How can I help?").replace(/"/g, '\\"');
    const notes =
      "The RAG agent is embedded via the hosted widget script (no SDK file is copied). " +
      "Paste the snippet below into the app shell (e.g. index.html before </body>). " +
      "window.FounderOSAgent MUST be set before the script loads — key is the agent's public key, " +
      "endpoint targets the public rag-chat function. config.proactive enables the activation engine " +
      "(idle / rage-click / route-change interventions).";
    const snippet = `<!-- FounderOS RAG agent widget -->
<script>
  window.FounderOSAgent = {
    key: "${key}",
    endpoint: "${p.host}/functions/v1/rag-chat",
    welcome: "${welcome}",
    config: { proactive: true }
  };
</script>
<script src="${p.host}/functions/v1/rag-widget" defer></script>`;
    return {
      files: [{ path: `${dir}/founderos-rag-widget.html`, content: snippet + "\n" }],
      notes,
    };
  }

  // analytics
  const sdkPath = `${dir}/founderos.ts`;
  const initPath = `${dir}/analytics.ts`;

  let initContent: string;
  let notes: string;

  if (p.runtime === "browser") {
    const anon = p.anonKeyExpr || "import.meta.env.VITE_SUPABASE_ANON_KEY";
    initContent = `// FounderOS analytics — browser init. Import \`analytics\` and call
// analytics.track("event_name", { properties }) anywhere in the app.
import { createClient } from "./founderos";

export const analytics = createClient({
  host: "${p.host}",
  projectId: "${p.projectId}",
  workspaceId: "${p.workspaceId ?? "<workspace-uuid>"}",
  anonKey: ${anon},
});

// Lightweight auto-capture: page_view on every (SPA) navigation, and clicks on
// any element annotated with data-fos-event="name". Add data-fos-* attributes
// to fold extra properties in, e.g.:
//   <button data-fos-event="cta_click" data-fos-location="hero">Start</button>
analytics.autocapture();

// Load feature flags so analytics.isFeatureEnabled("flag_key") works synchronously.
// Re-call analytics.loadFlags() after identify(email) to get per-user flag state.
void analytics.loadFlags();

// Identify the signed-in user once you know who they are (call after login):
//   analytics.identify(user.email);
//   await analytics.loadFlags();
//
// Feature flagging in components:
//   if (analytics.isFeatureEnabled("new_onboarding")) { /* render new flow */ }
`;
    notes =
      "Browser analytics installed with auto-capture (page_view + [data-fos-event] clicks). " +
      `Ensure ${anon.includes("env") ? anon : "your anon key env var"} is set. ` +
      'Call analytics.identify(email) after login. Tag key buttons with data-fos-event="name" and add explicit analytics.track(...) on important business actions (signup, checkout, activation).';
  } else {
    const apiKey = p.apiKeyExpr || "process.env.FOUNDEROS_API_KEY!";
    initContent = `// FounderOS analytics — server init. Never expose the API key to the browser.
import { createClient } from "./founderos";

export const analytics = createClient({
  host: "${p.host}",
  projectId: "${p.projectId}",
  apiKey: ${apiKey},
});

// Flush on shutdown so no events are lost.
// process.on("beforeExit", () => analytics.shutdown());
`;
    notes =
      "Server analytics installed. Set FOUNDEROS_API_KEY (issued in Integrations → API Keys) " +
      "in your secret manager — never commit it. Call analytics.shutdown() on process exit.";
  }

  return {
    files: [
      { path: sdkPath, content: SDK_JS_FOUNDEROS_TS },
      { path: initPath, content: initContent },
    ],
    notes,
  };
}
