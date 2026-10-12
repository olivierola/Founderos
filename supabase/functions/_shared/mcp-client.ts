// Minimal MCP (Model Context Protocol) client over Streamable HTTP / SSE, for
// Deno edge functions. Remote transport only (no stdio). Handles the initialize
// handshake, the Mcp-Session-Id, and JSON-or-SSE response parsing — enough to
// discover tools (tools/list) and invoke them (tools/call) on a remote server.

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-06-18";

function baseHeaders(headers: Record<string, string>, sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...headers,
  };
  if (sessionId) h["Mcp-Session-Id"] = sessionId;
  return h;
}

// Extract the JSON-RPC response object from a body that may be plain JSON or an
// SSE stream (Streamable HTTP servers may answer either way).
function parseRpcBody(text: string, contentType: string): any {
  const t = text.trim();
  if (!t) return null;
  if (contentType.includes("text/event-stream") || t.startsWith("event:") || t.startsWith("data:")) {
    let last: any = null;
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (!m) continue;
      try {
        const obj = JSON.parse(m[1]);
        if (obj && (obj.result !== undefined || obj.error !== undefined || obj.id !== undefined)) last = obj;
      } catch { /* skip keepalive / non-JSON data lines */ }
    }
    return last;
  }
  try { return JSON.parse(t); } catch { return null; }
}

async function rpc(
  url: string, headers: Record<string, string>, sessionId: string | undefined,
  method: string, params: Record<string, unknown> | undefined, id: number,
): Promise<{ result?: any; error?: any; sessionId?: string; httpStatus: number }> {
  const res = await fetch(url, {
    method: "POST",
    headers: baseHeaders(headers, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
  });
  const newSession = res.headers.get("mcp-session-id") || sessionId;
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!res.ok) {
    return { error: { code: res.status, message: text.slice(0, 300) || `HTTP ${res.status}` }, sessionId: newSession ?? undefined, httpStatus: res.status };
  }
  const obj = parseRpcBody(text, ct);
  if (!obj) return { error: { message: "empty or unparseable MCP response" }, sessionId: newSession ?? undefined, httpStatus: res.status };
  return { result: obj.result, error: obj.error, sessionId: newSession ?? undefined, httpStatus: res.status };
}

async function notify(url: string, headers: Record<string, string>, sessionId: string | undefined, method: string): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: baseHeaders(headers, sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", method }),
    });
  } catch { /* notifications are best-effort */ }
}

// initialize + notifications/initialized → returns the session id (if the server
// is stateful and issues one).
async function handshake(url: string, headers: Record<string, string>): Promise<{ sessionId?: string; error?: any }> {
  const init = await rpc(url, headers, undefined, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "founderos", version: "1.0" },
  }, 1);
  if (init.error) return { error: init.error };
  await notify(url, headers, init.sessionId, "notifications/initialized");
  return { sessionId: init.sessionId };
}

// Some servers moved their MCP endpoint between the legacy SSE path and the
// Streamable-HTTP path (e.g. Notion /sse → /mcp). On a 404 we retry the sibling.
export function siblingMcpUrl(url: string): string | null {
  if (/\/sse\/?$/.test(url)) return url.replace(/\/sse\/?$/, "/mcp");
  if (/\/mcp\/?$/.test(url)) return url.replace(/\/mcp\/?$/, "/sse");
  return null;
}

async function discoverOnce(
  url: string, headers: Record<string, string>,
): Promise<{ tools: McpTool[]; error?: string; is404?: boolean }> {
  const hs = await handshake(url, headers);
  if (hs.error) {
    const msg = typeof hs.error === "string" ? hs.error : (hs.error?.message ?? "initialize failed");
    return { tools: [], error: msg, is404: hs.error?.code === 404 || /not found|\b404\b/i.test(msg) };
  }
  const list = await rpc(url, headers, hs.sessionId, "tools/list", {}, 2);
  if (list.error) {
    const msg = list.error?.message ?? "tools/list failed";
    return { tools: [], error: msg, is404: list.error?.code === 404 || /not found|\b404\b/i.test(msg) };
  }
  const raw = Array.isArray(list.result?.tools) ? list.result.tools : [];
  return {
    tools: raw.map((t: any) => ({
      name: String(t.name ?? ""),
      description: typeof t.description === "string" ? t.description : "",
      inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : undefined,
    })).filter((t: McpTool) => t.name),
  };
}

// Returns the discovered tools + the URL that actually worked (so the caller can
// heal a stale /sse-vs-/mcp URL in the DB).
export async function mcpDiscoverTools(
  url: string, headers: Record<string, string>,
): Promise<{ tools: McpTool[]; error?: string; usedUrl: string }> {
  try {
    let r = await discoverOnce(url, headers);
    let used = url;
    if (r.error && r.is404) {
      const sib = siblingMcpUrl(url);
      if (sib) {
        const r2 = await discoverOnce(sib, headers);
        if (!r2.error) { r = r2; used = sib; }
      }
    }
    return { tools: r.tools, error: r.error, usedUrl: used };
  } catch (e) {
    return { tools: [], error: e instanceof Error ? e.message : String(e), usedUrl: url };
  }
}

// Invoke a tool. `session` is an optional reusable cache so multiple calls within
// one run share a single MCP session instead of re-handshaking each time. Retries
// once (fresh handshake) if a cached session was rejected.
export async function mcpCallTool(
  url: string, headers: Record<string, string>, name: string, args: Record<string, unknown>,
  session?: { id?: string },
): Promise<string> {
  const ensureSession = async (): Promise<{ sessionId?: string; error?: string }> => {
    if (session?.id) return { sessionId: session.id };
    const hs = await handshake(url, headers);
    if (hs.error) return { error: typeof hs.error === "string" ? hs.error : (hs.error?.message ?? "initialize failed") };
    if (session) session.id = hs.sessionId;
    return { sessionId: hs.sessionId };
  };

  const s1 = await ensureSession();
  if (s1.error) return `ERROR: MCP initialize failed — ${s1.error}`;
  let call = await rpc(url, headers, s1.sessionId, "tools/call", { name, arguments: args ?? {} }, (Date.now() % 100000) + 3);

  // Stale session (404 / "session") → drop it and retry once with a fresh handshake.
  if (call.error && (call.httpStatus === 404 || /session/i.test(String(call.error?.message ?? "")))) {
    if (session) session.id = undefined;
    const s2 = await ensureSession();
    if (!s2.error) {
      call = await rpc(url, headers, s2.sessionId, "tools/call", { name, arguments: args ?? {} }, (Date.now() % 100000) + 4);
    }
  }

  if (call.error) return `ERROR: ${call.error?.message ?? "tools/call failed"}`;
  const content = call.result?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((c: any) => (c?.type === "text" ? c.text : (c?.text ?? JSON.stringify(c))))
      .join("\n");
    return (call.result?.isError ? "ERROR: " : "") + String(text).slice(0, 12000);
  }
  return JSON.stringify(call.result ?? {}).slice(0, 12000);
}
