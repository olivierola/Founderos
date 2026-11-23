// Le SDK FounderOS d'un agent embarqué : ce que son conteneur appelle, avec sa
// clé d'API, pour se servir de la plateforme. Aucune dépendance au reste du
// backend : un script, un service ou le moteur du conteneur l'utilisent pareil.
//
//   const fos = new FounderOS({ url: process.env.FOUNDEROS_URL, apiKey: process.env.FOUNDEROS_API_KEY });
//   await fos.tools.list();                                  // les outils de l'agent (ses pools)
//   await fos.connectors.call("composio_SLACK_SEND_MESSAGE", { channel: "#ops", text: "…" });
//   await fos.knowledge.grep({ types: ["documents"], regexes: ["\\mfactur"], all: false, path: null, limit: 10, offset: 0 });
//   await fos.deliverables.create({ kind: "markdown", name: "Rapport", content: "…" });
//
// Les secrets des connecteurs restent dans FounderOS : la clé ne permet que
// d'agir pour CET agent, dans ses pools, sous ses garde-fous.

export interface FounderOSOptions {
  url: string;
  apiKey: string;
  /** Délai d'un appel, en millisecondes (défaut 120 s). */
  timeoutMs?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Un run du conteneur : son identifiant FounderOS et sa session locale. */
export interface RunRef { run_id: string; session_id: string }

/** Un geste que la plateforme demande dans la session : consigne, relance, modèle lourd, arrêt. */
export type RunAction =
  | { type: "steer"; text: string }
  | { type: "prompt"; text: string }
  | { type: "interrupt" }
  | { type: "escalate"; model: string };

export class FounderOSError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class FounderOS {
  readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts: FounderOSOptions) {
    if (!opts.url) throw new Error("FOUNDEROS_URL manquant");
    if (!opts.apiKey) throw new Error("FOUNDEROS_API_KEY manquant");
    this.url = opts.url.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** L'adresse compatible OpenAI du modèle, par la plateforme. */
  get llmBaseUrl(): string { return `${this.url}/embedded/v1/llm`; }
  get key(): string { return this.apiKey; }

  async request<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const res = await fetch(`${this.url}/embedded/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 300) }; }
    if (!res.ok) throw new FounderOSError(res.status, String(json.error ?? `HTTP ${res.status}`));
    return json as T;
  }

  /** L'instance s'annonce : son identifiant, la configuration à jour. */
  hello(input: { name: string; version?: number | null; manifest_sha?: string | null; info?: Record<string, unknown>; container_ref?: string }) {
    return this.request<{ instance_id: string; agent_id: string; manifest: Record<string, unknown>; sha: string }>("POST", "/hello", input);
  }

  heartbeat(input: { instance_id: string; status: "online" | "paused"; info?: Record<string, unknown>; manifest_sha?: string }) {
    return this.request<{ ok: boolean; commands: number }>("POST", "/heartbeat", input, 15_000);
  }

  manifest() {
    return this.request<{ manifest: Record<string, unknown>; sha: string }>("GET", "/manifest");
  }

  readonly tools = {
    list: () => this.request<{ agent: { name: string; is_orchestrator: boolean }; tools: ToolDefinition[] }>("GET", "/tools"),
    call: async (name: string, args: Record<string, unknown>, opts: { run_id?: string | null; conversation_id?: string | null } = {}) =>
      (await this.request<{ result: string }>("POST", "/tools/call", { name, args, ...opts }, 10 * 60_000)).result,
  };

  /** Les applications connectées (connecteurs maison, Composio, MCP) : un outil de la liste. */
  readonly connectors = {
    call: (tool: string, params: Record<string, unknown>, opts: { run_id?: string | null } = {}) => this.tools.call(tool, params, opts),
  };

  readonly deliverables = {
    create: (d: { kind: string; name: string; content: string; summary?: string }, opts: { run_id?: string | null } = {}) =>
      this.tools.call("create_deliverable", d, opts),
  };

  readonly memory = {
    save: (content: string, importance = 3, opts: { run_id?: string | null } = {}) => this.tools.call("save_memory", { content, importance }, opts),
  };

  readonly knowledge = {
    grep: async (p: { types: string[]; regexes: string[]; all: boolean; path: string | null; limit: number; offset: number }) =>
      (await this.request<{ rows: Array<Record<string, unknown>> }>("POST", "/search/grep", p)).rows,
    read: async (ids: string[], whole: boolean) =>
      (await this.request<{ rows: Array<Record<string, unknown>> }>("POST", "/search/read", { ids, whole })).rows,
    /** La connaissance embarquée à jour (JSON Lines), si l'option est active. */
    snapshot: () => this.request<{ enabled: boolean; jsonl: string; count: number; truncated: boolean }>("GET", "/knowledge/snapshot", undefined, 10 * 60_000),
  };

  /** Les écritures du moteur (runs, événements, messages, consommation). */
  store<T = unknown>(op: string, args: unknown[], instanceId?: string | null): Promise<T> {
    return this.request<{ result: T }>("POST", "/store", { op, args, ...(instanceId ? { instance_id: instanceId } : {}) }).then((r) => r.result);
  }

  /**
   * La conduite des runs par la plateforme : après chaque étape, au plafond, à
   * la fin, à une question. Rend les gestes à faire dans la session locale.
   */
  readonly runs = {
    step: (run: RunRef, info: { trail: unknown[]; steps: number; cost_usd: number; heavy: string | null }) =>
      this.request<{ actions: RunAction[] }>("POST", "/runs/step", { ...run, ...info }, 60_000),
    budget: async (run: RunRef) => (await this.request<{ reason: string | null }>("POST", "/runs/budget", run, 20_000)).reason,
    settle: (run: RunRef, outcome: Record<string, unknown>) =>
      this.request<{ next: "done" | "continue"; actions: RunAction[] }>("POST", "/runs/settle", { ...run, outcome }, 5 * 60_000),
    question: (run: RunRef, question: Record<string, unknown>) => this.request("POST", "/runs/question", { ...run, question }, 60_000),
  };

  readonly commands = {
    take: (instanceId: string) => this.request<{ command: { id: number; command: string; payload: Record<string, unknown> } | null }>("POST", "/commands/take", { instance_id: instanceId }, 20_000),
    done: (id: number) => this.request("POST", "/commands/done", { id }, 20_000),
  };
}
