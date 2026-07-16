// McpServers — workspace-level registry of remote MCP (Model Context Protocol)
// servers. Add / configure / test servers here; attach them to individual agents
// from the agent's Personnaliser → MCP tab. Reached from the AI Workforce sidebar.
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Loader2, Trash2, Pencil, RefreshCw, CheckCircle2, XCircle,
  Plug, Wrench, ChevronDown, X, LogIn, LayoutGrid,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { MCP_CATALOG, catalogReadyCount, type McpCatalogEntry } from "./mcpCatalog";

interface McpTool { name: string; description?: string }
type AuthMode = "none" | "header" | "oauth";
interface McpServer {
  id: string;
  name: string;
  description: string | null;
  transport: "http" | "sse";
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  cached_tools: McpTool[];
  status: "ok" | "error" | null;
  last_error: string | null;
  last_checked_at: string | null;
  auth_mode: AuthMode;
  oauth: { status?: "connecting" | "connected" | "error"; connected_at?: string } & Record<string, unknown>;
}

export function McpServersPage() {
  const { workspaceId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<McpServer | null | "new">(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [preset, setPreset] = useState<McpCatalogEntry | null>(null);

  const { data: servers, isLoading } = useQuery({
    queryKey: ["mcp_servers", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase.from("mcp_servers").select("*")
        .eq("workspace_id", workspaceId).order("created_at", { ascending: false });
      return (data ?? []) as McpServer[];
    },
  });

  async function remove(s: McpServer) {
    if (!confirm(`Supprimer le serveur MCP « ${s.name} » ? Il sera retiré de tous les agents.`)) return;
    await supabase.from("mcp_servers").delete().eq("id", s.id);
    queryClient.invalidateQueries({ queryKey: ["mcp_servers", workspaceId] });
  }

  async function toggleEnabled(s: McpServer) {
    await supabase.from("mcp_servers").update({ enabled: !s.enabled }).eq("id", s.id);
    queryClient.invalidateQueries({ queryKey: ["mcp_servers", workspaceId] });
  }

  async function test(s: McpServer) {
    setTesting(s.id);
    try {
      const res = await callEdge<{ ok: boolean; error?: string; count?: number }>("mcp-gateway", { action: "discover", server_id: s.id });
      queryClient.invalidateQueries({ queryKey: ["mcp_servers", workspaceId] });
      if (!res.ok) alert(`Échec de la connexion : ${res.error ?? "inconnu"}`);
      else setExpanded(s.id);
    } catch (e) {
      alert(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(null);
    }
  }

  // OAuth 2.1: start the flow → open the authorization server in a popup, then
  // refetch when the /mcp/callback page posts back its result.
  async function connect(s: McpServer) {
    try {
      const redirectUri = `${window.location.origin}/mcp/callback`;
      const res = await callEdge<{ ok: boolean; authorize_url?: string; error?: string }>("mcp-oauth", { action: "start", server_id: s.id, redirect_uri: redirectUri });
      if (!res.ok || !res.authorize_url) { alert(`Échec : ${res.error ?? "impossible de démarrer OAuth"}`); return; }
      const popup = window.open(res.authorize_url, "mcp-oauth", "width=520,height=700");
      if (!popup) { alert("Le popup a été bloqué — autorisez les popups pour ce site."); return; }
      const onMsg = (e: MessageEvent) => {
        if (e.origin !== window.location.origin || (e.data as { type?: string })?.type !== "mcp-oauth") return;
        window.removeEventListener("message", onMsg);
        queryClient.invalidateQueries({ queryKey: ["mcp_servers", workspaceId] });
        const d = e.data as { ok?: boolean; error?: string };
        if (!d.ok) alert(`Connexion échouée : ${d.error ?? ""}`);
      };
      window.addEventListener("message", onMsg);
    } catch (e) {
      alert(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const list = servers ?? [];

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-col gap-4 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">MCP Servers</h2>
          <p className="mt-1 max-w-lg text-sm text-muted-foreground">
            Branchez des serveurs MCP distants (Streamable HTTP / SSE) : leurs outils deviennent
            disponibles pour vos agents une fois attachés depuis Personnaliser → MCP.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => setCatalogOpen(true)}>
            <LayoutGrid className="mr-1 h-4 w-4" /> Catalogue
          </Button>
          <Button size="sm" className="rounded-full" onClick={() => { setPreset(null); setEditing("new"); }}>
            <Plus className="mr-1 h-4 w-4" /> Ajouter un serveur
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Plug className="h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">Aucun serveur MCP pour le moment.</p>
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => setEditing("new")}>
            <Plus className="mr-1 h-4 w-4" /> Ajouter votre premier serveur
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((s) => {
            const isOpen = expanded === s.id;
            return (
              <div key={s.id} className={cn("rounded-xl border bg-card/40 p-4", s.enabled ? "border-border" : "border-dashed border-border/70 opacity-70")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-medium text-foreground">{s.name}</h3>
                      <Badge variant="outline" className="text-[9px] uppercase">{s.transport}</Badge>
                      {s.auth_mode === "oauth" && (
                        s.oauth?.status === "connected"
                          ? <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400"><LogIn className="h-3 w-3" /> OAuth connecté</span>
                          : <span className="text-[10px] text-amber-600 dark:text-amber-400">OAuth · non connecté</span>
                      )}
                      {s.status === "ok" && <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3 w-3" /> OK</span>}
                      {s.status === "error" && <span className="inline-flex items-center gap-1 text-[10px] text-destructive"><XCircle className="h-3 w-3" /> Erreur</span>}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{s.url}</p>
                    {s.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{s.description}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {s.auth_mode === "oauth" && (
                      <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 text-xs" onClick={() => connect(s)}>
                        <LogIn className="h-3 w-3" />
                        <span className="ml-1">{s.oauth?.status === "connected" ? "Reconnecter" : "Se connecter"}</span>
                      </Button>
                    )}
                    <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 text-xs" onClick={() => test(s)} disabled={testing === s.id}>
                      {testing === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      <span className="ml-1">Tester</span>
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground" aria-label="Actions">
                          <ChevronDown className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditing(s)}><Pencil className="mr-2 h-3.5 w-3.5" /> Modifier</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toggleEnabled(s)}>{s.enabled ? "Désactiver" : "Activer"}</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => remove(s)}><Trash2 className="mr-2 h-3.5 w-3.5" /> Supprimer</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {s.status === "error" && s.last_error && (
                  <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">{s.last_error}</p>
                )}

                {/* Discovered tools */}
                {(s.cached_tools?.length ?? 0) > 0 && (
                  <div className="mt-2.5">
                    <button onClick={() => setExpanded(isOpen ? null : s.id)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                      <Wrench className="h-3.5 w-3.5" />
                      {s.cached_tools.length} outil{s.cached_tools.length > 1 ? "s" : ""} découvert{s.cached_tools.length > 1 ? "s" : ""}
                      <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-180")} />
                    </button>
                    {isOpen && (
                      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                        {s.cached_tools.map((t) => (
                          <div key={t.name} className="rounded-md border border-border/60 bg-background/40 px-2 py-1.5">
                            <div className="font-mono text-[11px] text-foreground">{t.name}</div>
                            {t.description && <div className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">{t.description}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {catalogOpen && (
        <McpCatalogDrawer
          onClose={() => setCatalogOpen(false)}
          onPick={(entry) => { setPreset(entry); setCatalogOpen(false); setEditing("new"); }}
        />
      )}

      {editing !== null && (
        <McpServerDialog
          server={editing === "new" ? null : editing}
          preset={editing === "new" ? preset : null}
          workspaceId={workspaceId}
          onClose={() => { setEditing(null); setPreset(null); }}
          onSaved={() => { setEditing(null); setPreset(null); queryClient.invalidateQueries({ queryKey: ["mcp_servers", workspaceId] }); }}
        />
      )}
    </div>
  );
}

// Browsable, searchable catalog of preconfigured MCP servers grouped by category.
function McpCatalogDrawer({ onClose, onPick }: { onClose: () => void; onPick: (e: McpCatalogEntry) => void }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const cats = MCP_CATALOG
    .map((c) => ({ ...c, servers: c.servers.filter((s) => !query || s.name.toLowerCase().includes(query) || c.label.toLowerCase().includes(query)) }))
    .filter((c) => c.servers.length > 0);

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/30" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-border bg-card shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div>
            <h3 className="text-sm font-semibold">Catalogue MCP</h3>
            <p className="text-[11px] text-muted-foreground">{catalogReadyCount()} serveurs prêts à connecter · le reste local / à configurer</p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </header>
        <div className="border-b border-border px-5 py-2.5">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un serveur…" className="h-9" />
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {cats.map((c) => (
            <div key={c.label}>
              <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{c.label}</div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {c.servers.map((s) => {
                  const ready = !!s.url;
                  return (
                    <button
                      key={s.name}
                      disabled={s.local}
                      onClick={() => { if (!s.local) onPick(s); }}
                      title={s.note}
                      className={cn(
                        "flex items-start gap-2 rounded-lg border p-2.5 text-left transition-colors",
                        s.local
                          ? "cursor-not-allowed border-dashed border-border/60 opacity-60"
                          : "border-border hover:border-primary/40 hover:bg-secondary/40",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{s.name}</span>
                          {ready ? (
                            <span className="shrink-0 rounded bg-emerald-500/15 px-1 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">
                              {s.auth === "oauth" ? "OAuth" : s.auth === "header" ? "Token" : "Prêt"}
                            </span>
                          ) : s.local ? (
                            <span className="shrink-0 rounded bg-secondary px-1 text-[9px] text-muted-foreground">local</span>
                          ) : (
                            <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] font-medium text-amber-600 dark:text-amber-400">URL</span>
                          )}
                        </div>
                        {s.note && <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground">{s.note}</p>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {cats.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">Aucun serveur pour « {q} ».</p>}
        </div>
      </aside>
    </>
  );
}

// OAuth redirect target (opened in a popup). Exchanges code+state via mcp-oauth,
// posts the result back to the opener window, then closes.
// Module-level guard: an OAuth authorization code is single-use, but React
// StrictMode (dev) double-invokes effects — without this the 2nd exchange fails
// with "Invalid authorization code" even though the 1st already connected.
const handledOAuthStates = new Set<string>();
export function McpOAuthCallbackPage() {
  const [msg, setMsg] = useState("Connexion en cours…");
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const code = p.get("code");
    const state = p.get("state");
    const err = p.get("error_description") || p.get("error");
    if (state) {
      if (handledOAuthStates.has(state)) return; // already exchanged (double-mount)
      handledOAuthStates.add(state);
    }
    const finish = (ok: boolean, error?: string) => {
      setMsg(ok ? "Connecté ! Vous pouvez fermer cette fenêtre." : `Échec : ${error ?? "inconnu"}`);
      try { window.opener?.postMessage({ type: "mcp-oauth", ok, error }, window.location.origin); } catch { /* ignore */ }
      if (window.opener) setTimeout(() => window.close(), 900);
    };
    (async () => {
      if (err) return finish(false, err);
      if (!code || !state) return finish(false, "paramètres manquants");
      try {
        const res = await callEdge<{ ok: boolean; error?: string }>("mcp-oauth", { action: "callback", code, state });
        finish(res.ok, res.error);
      } catch (e) {
        finish(false, e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
      <LogIn className="h-6 w-6 text-primary" />
      <p>{msg}</p>
    </div>
  );
}

function McpServerDialog({
  server, preset, workspaceId, onClose, onSaved,
}: {
  server: McpServer | null;
  preset?: McpCatalogEntry | null;
  workspaceId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(server?.name ?? preset?.name ?? "");
  const [description, setDescription] = useState(server?.description ?? "");
  const [transport, setTransport] = useState<"http" | "sse">(server?.transport ?? preset?.transport ?? "http");
  const [authMode, setAuthMode] = useState<AuthMode>(server?.auth_mode ?? (preset?.auth as AuthMode | undefined) ?? "header");
  const [oauthClientId, setOauthClientId] = useState<string>((server?.oauth?.client_id as string) ?? "");
  const [oauthClientSecret, setOauthClientSecret] = useState<string>("");
  const [oauthScope, setOauthScope] = useState<string>((server?.oauth?.scope as string) ?? "");
  const [oauthClientName, setOauthClientName] = useState<string>((server?.oauth?.client_name as string) ?? preset?.clientName ?? "");
  const [url, setUrl] = useState(server?.url ?? preset?.url ?? "");
  const [headers, setHeaders] = useState<Array<{ k: string; v: string }>>(
    server?.headers ? Object.entries(server.headers).map(([k, v]) => ({ k, v: String(v) })) : [],
  );
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const headersObj = () => {
    const o: Record<string, string> = {};
    for (const { k, v } of headers) if (k.trim()) o[k.trim()] = v;
    return o;
  };
  const urlValid = /^https?:\/\//i.test(url.trim());

  async function testDraft() {
    setTesting(true); setTestResult(null);
    try {
      const res = await callEdge<{ ok: boolean; error?: string; count?: number }>("mcp-gateway", {
        action: "test", url: url.trim(), headers: headersObj(), transport,
      });
      setTestResult(res.ok
        ? { ok: true, msg: `Connexion OK — ${res.count ?? 0} outil(s) découvert(s).` }
        : { ok: false, msg: res.error ?? "Échec de la connexion." });
    } catch (e) {
      setTestResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!name.trim() || !urlValid || !workspaceId) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        transport,
        auth_mode: authMode,
        url: url.trim(),
        headers: headersObj(),
        updated_at: new Date().toISOString(),
      };
      let serverId = server?.id;
      if (server) {
        const { error } = await supabase.from("mcp_servers").update(payload).eq("id", server.id);
        if (error) { alert(error.message); return; }
      } else {
        const { data, error } = await supabase.from("mcp_servers")
          .insert({ ...payload, workspace_id: workspaceId }).select("id").single();
        if (error) { alert(error.message); return; }
        serverId = (data as { id: string }).id;
      }
      if (serverId) {
        if (authMode === "oauth") {
          // Persist any manual OAuth config (client_id/secret/scope) for servers
          // without Dynamic Client Registration. Discovery happens on connect.
          await callEdge("mcp-oauth", {
            action: "config", server_id: serverId,
            client_id: oauthClientId.trim(), scope: oauthScope.trim(), client_name: oauthClientName.trim(),
            ...(oauthClientSecret.trim() ? { client_secret: oauthClientSecret.trim() } : {}),
          }).catch(() => {});
        } else {
          // Discover tools right away so the server is usable without a manual test.
          await callEdge("mcp-gateway", { action: "discover", server_id: serverId }).catch(() => {});
        }
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

  return (
    <>
      {/* Right, full-height drawer (not a centered modal). */}
      <div className="fixed inset-0 z-50 bg-black/30" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-card shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h3 className="text-sm font-semibold">{server ? "Modifier le serveur MCP" : "Ajouter un serveur MCP"}</h3>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {preset?.note && (
            <p className="rounded-md border border-border bg-secondary/30 px-2.5 py-2 text-[11px] text-muted-foreground">{preset.note}</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Nom</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. GitHub MCP" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Transport</label>
              <select value={transport} onChange={(e) => setTransport(e.target.value as "http" | "sse")} className={inputCls}>
                <option value="http">Streamable HTTP</option>
                <option value="sse">SSE</option>
              </select>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">URL du serveur</label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.exemple.com/mcp" />
            {url && !urlValid && <p className="mt-1 text-[10px] text-destructive">L'URL doit commencer par http(s)://</p>}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Description (optionnel)</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="À quoi sert ce serveur…" />
          </div>

          {/* Authentication mode */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Authentification</label>
            <select value={authMode} onChange={(e) => setAuthMode(e.target.value as AuthMode)} className={inputCls}>
              <option value="none">Aucune (serveur ouvert)</option>
              <option value="header">Header statique (token / clé d'API)</option>
              <option value="oauth">OAuth 2.1 (connexion interactive)</option>
            </select>
          </div>

          {/* Static headers — only for header auth */}
          {authMode === "header" && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Headers (auth)</label>
                <button onClick={() => setHeaders((h) => [...h, { k: "", v: "" }])} className="text-[11px] text-primary hover:underline">
                  + Ajouter
                </button>
              </div>
              {headers.length === 0 && <p className="text-[10px] text-muted-foreground">ex. Authorization : Bearer &lt;token&gt;</p>}
              <div className="space-y-1.5">
                {headers.map((h, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <Input value={h.k} onChange={(e) => setHeaders((hs) => hs.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} placeholder="Header" className="h-8 flex-1" />
                    <Input value={h.v} onChange={(e) => setHeaders((hs) => hs.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} placeholder="Valeur" className="h-8 flex-1" />
                    <button onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))} className="rounded p-1 text-muted-foreground hover:text-destructive">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* OAuth guidance + manual client (fallback when DCR is refused) */}
          {authMode === "oauth" && (
            <div className="space-y-2.5 rounded-lg border border-border bg-secondary/30 p-3">
              <div className="text-[11px] text-muted-foreground">
                <p className="flex items-center gap-1.5 font-medium text-foreground"><LogIn className="h-3.5 w-3.5" /> OAuth 2.1</p>
                <p className="mt-1">
                  {server
                    ? "Enregistrez, puis cliquez « Se connecter » sur la carte pour lancer l'autorisation (découverte + PKCE automatiques)."
                    : "Enregistrez d'abord ; le bouton « Se connecter » apparaîtra ensuite sur la carte du serveur."}
                </p>
              </div>
              <details className="text-[11px]">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Client OAuth manuel (si l'enregistrement dynamique est refusé — erreur 403)</summary>
                <div className="mt-2 space-y-2">
                  <div>
                    <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Client name (DCR)</label>
                    <Input value={oauthClientName} onChange={(e) => setOauthClientName(e.target.value)} placeholder="nom envoyé à l'enregistrement dynamique" className="h-8" />
                    <p className="mt-0.5 text-[10px] text-muted-foreground">Certains serveurs (Figma) n'acceptent qu'une liste de noms de clients.</p>
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Client ID</label>
                    <Input value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} placeholder="client_id de l'app OAuth" className="h-8" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Client secret (optionnel)</label>
                    <Input type="password" value={oauthClientSecret} onChange={(e) => setOauthClientSecret(e.target.value)} placeholder={server ? "•••••••• (laisser vide = inchangé)" : "si l'app est confidentielle"} className="h-8" />
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Scope (optionnel)</label>
                    <Input value={oauthScope} onChange={(e) => setOauthScope(e.target.value)} placeholder="ex. read write" className="h-8" />
                  </div>
                  <p className="text-[10px] text-muted-foreground">Créez une app OAuth chez le fournisseur avec l'URL de redirection : <span className="font-mono">{`${window.location.origin}/mcp/callback`}</span></p>
                </div>
              </details>
            </div>
          )}

          {testResult && (
            <p className={cn("rounded-md px-2 py-1.5 text-[11px]", testResult.ok ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-destructive/10 text-destructive")}>
              {testResult.msg}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" size="sm" onClick={testDraft} disabled={testing || !urlValid}>
            {testing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />} Tester la connexion
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Annuler</Button>
            <Button size="sm" onClick={save} disabled={saving || !name.trim() || !urlValid}>
              {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              {server ? "Enregistrer" : "Ajouter"}
            </Button>
          </div>
        </footer>
      </aside>
    </>
  );
}
