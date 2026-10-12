// McpServers — workspace-level registry of remote MCP (Model Context Protocol)
// servers. Add / configure / test servers here; attach them to individual agents
// from the agent's Personnaliser → MCP tab. Reached from the AI Workforce sidebar.
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PlusIcon as Plus,
  CircleNotchIcon as Loader2,
  TrashIcon as Trash2,
  PencilSimpleIcon as Pencil,
  ArrowsClockwiseIcon as RefreshCw,
  CheckCircleIcon as CheckCircle2,
  XCircleIcon as XCircle,
  PlugIcon as Plug,
  WrenchIcon as Wrench,
  CaretDownIcon as ChevronDown,
  XIcon as X,
  SignInIcon as LogIn,
  GridFourIcon as LayoutGrid,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { MCP_CATALOG, catalogReadyCount, type McpCatalogEntry } from "./mcpCatalog";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";

interface McpTool { name: string; description?: string }
type AuthMode = "none" | "header" | "oauth" | "token_exchange" | "signed_context" | "api_token";
const identityMode = (m: AuthMode) => m === "token_exchange" || m === "signed_context";
interface McpServer {
  id: string;
  name: string;
  description: string | null;
  transport: "http" | "sse";
  url: string;
  /** En-têtes statiques (0280) : leurs noms et un aperçu, jamais les valeurs. */
  header_hints?: Record<string, string> | null;
  enabled: boolean;
  cached_tools: McpTool[];
  status: "ok" | "error" | null;
  last_error: string | null;
  last_checked_at: string | null;
  auth_mode: AuthMode;
  /** token_exchange : client Keycloak du serveur et cluster qui l'héberge. */
  auth_config?: { audience?: string; cluster?: string; provider?: string } | null;
  /** Joint par le relais du client (G2). */
  relay_id?: string | null;
  environment?: "development" | "staging" | "production" | null;
  /** Jeton d'API enregistré (0278) : son indice seulement, jamais le jeton. */
  token_hint?: string | null;
  /** Jeton tournant (0285) : quand le jeton a été reçu, et s'il a été saisi ou livré par le serveur. */
  token_received_at?: string | null;
  token_origin?: "manual" | "push" | null;
  oauth: { status?: "connecting" | "connected" | "disconnected" | "error"; connected_at?: string } & Record<string, unknown>;
  created_by?: string | null;
}

export function McpServersPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const { workspaceId, role } = useCurrentContext();
  const { user } = useAuth();
  // Mêmes règles que la RLS (0279) : les membres ajoutent des serveurs et
  // modifient les leurs ; les admins, tous ; les lecteurs, aucun.
  const isAdmin = role === "owner" || role === "admin";
  const canCreate = isAdmin || role === "member";
  const canEdit = (s: McpServer) => isAdmin || (role === "member" && !!user && s.created_by === user.id);
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
    if (!(await confirm(`Supprimer le serveur MCP « ${s.name} » ? Il sera retiré de tous les agents.`))) return;
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
      if (!res.ok) toast.error(`Échec de la connexion : ${res.error ?? "inconnu"}`);
      else setExpanded(s.id);
    } catch (e) {
      toast.error(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
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
      if (!res.ok || !res.authorize_url) { toast.error(`Échec : ${res.error ?? "impossible de démarrer OAuth"}`); return; }
      const popup = window.open(res.authorize_url, "mcp-oauth", "width=520,height=700");
      if (!popup) { toast.error("Le popup a été bloqué, autorisez les popups pour ce site."); return; }
      const onMsg = (e: MessageEvent) => {
        if (e.origin !== window.location.origin || (e.data as { type?: string })?.type !== "mcp-oauth") return;
        window.removeEventListener("message", onMsg);
        queryClient.invalidateQueries({ queryKey: ["mcp_servers", workspaceId] });
        const d = e.data as { ok?: boolean; error?: string };
        if (!d.ok) toast.error(`Connexion échouée : ${d.error ?? ""}`);
      };
      window.addEventListener("message", onMsg);
    } catch (e) {
      toast.error(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
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
          {role && !isAdmin && (
            <p className="mt-1.5 max-w-lg text-[11px] text-muted-foreground">
              {canCreate
                ? "Vous modifiez les serveurs que vous avez ajoutés ; les autres sont gérés par les admins de l'espace."
                : "Lecture seule : les serveurs sont gérés par les membres qui les ont ajoutés et par les admins de l'espace."}
            </p>
          )}
        </div>
        {canCreate && (
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => setCatalogOpen(true)}>
            <LayoutGrid className="mr-1 h-4 w-4" /> Catalogue
          </Button>
          <Button size="sm" className="rounded-full" onClick={() => { setPreset(null); setEditing("new"); }}>
            <Plus className="mr-1 h-4 w-4" /> Ajouter un serveur
          </Button>
        </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Plug className="h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">Aucun serveur MCP pour le moment.</p>
          {canCreate && (
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => setEditing("new")}>
              <Plus className="mr-1 h-4 w-4" /> Ajouter votre premier serveur
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((s) => {
            const isOpen = expanded === s.id;
            const editable = canEdit(s);
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
                      {identityMode(s.auth_mode) && (
                        <span className="text-[10px] text-sky-600 dark:text-sky-400" title={s.auth_mode === "signed_context" ? "Contexte signé par FounderOS à chaque appel : la personne et l'agent" : "Jeton d'appel émis par l'IdP de l'entreprise à chaque appel, au nom de la personne et de l'agent"}>
                          {s.auth_mode === "signed_context" ? "Contexte signé" : "Identité déléguée"} · {s.auth_config?.audience}
                        </span>
                      )}
                      {s.auth_mode === "api_token" && (
                        <span className={s.token_hint ? "text-[10px] text-sky-600 dark:text-sky-400" : "text-[10px] text-amber-600 dark:text-amber-400"}>
                          Jeton d'API · {s.token_hint ?? "à saisir"}{s.token_origin === "push" ? " · tournant" : ""}
                        </span>
                      )}
                      {s.relay_id && <span className="text-[10px] text-violet-600 dark:text-violet-400">par relais</span>}
                      {s.environment === "production" && <span className="text-[10px] text-red-600 dark:text-red-400">production</span>}
                      {s.status === "ok" && <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3 w-3" /> OK</span>}
                      {s.status === "error" && <span className="inline-flex items-center gap-1 text-[10px] text-destructive"><XCircle className="h-3 w-3" /> Erreur</span>}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{s.url}</p>
                    {s.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{s.description}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {s.auth_mode === "oauth" && editable && (
                      <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 text-xs" onClick={() => connect(s)}>
                        <LogIn className="h-3 w-3" />
                        <span className="ml-1">{s.oauth?.status === "connected" ? "Reconnecter" : "Se connecter"}</span>
                      </Button>
                    )}
                    <Button variant="outline" size="sm" className="h-7 rounded-full px-2.5 text-xs" onClick={() => test(s)} disabled={testing === s.id}>
                      {testing === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      <span className="ml-1">Tester</span>
                    </Button>
                    {editable && (
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
                    )}
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
  const toast = useToast();
  const [name, setName] = useState(server?.name ?? preset?.name ?? "");
  const [description, setDescription] = useState(server?.description ?? "");
  const [transport, setTransport] = useState<"http" | "sse">(server?.transport ?? preset?.transport ?? "http");
  const [authMode, setAuthMode] = useState<AuthMode>(server?.auth_mode ?? (preset?.auth as AuthMode | undefined) ?? "header");
  const [oauthClientId, setOauthClientId] = useState<string>((server?.oauth?.client_id as string) ?? "");
  const [oauthClientSecret, setOauthClientSecret] = useState<string>("");
  const [oauthScope, setOauthScope] = useState<string>((server?.oauth?.scope as string) ?? "");
  const [oauthClientName, setOauthClientName] = useState<string>((server?.oauth?.client_name as string) ?? preset?.clientName ?? "");
  const [url, setUrl] = useState(server?.url ?? preset?.url ?? "");
  const [teAudience, setTeAudience] = useState<string>(server?.auth_config?.audience ?? "");
  const [teCluster, setTeCluster] = useState<string>(server?.auth_config?.cluster ?? "");
  const [teProvider, setTeProvider] = useState<string>(server?.auth_config?.provider ?? "");
  const [relayId, setRelayId] = useState<string>(server?.relay_id ?? "");
  const [environment, setEnvironment] = useState<string>(server?.environment ?? "");
  const { data: relays } = useQuery({
    queryKey: ["connector-relays", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase.from("connector_relays").select("id, name, status, last_seen_at")
        .eq("workspace_id", workspaceId!).eq("status", "active").order("name");
      return (data ?? []) as Array<{ id: string; name: string; status: string; last_seen_at: string | null }>;
    },
  });
  // En-têtes : les enregistrés arrivent sans valeur (seulement l'aperçu) ; une
  // valeur laissée vide garde l'enregistrée, tant que la destination ne change pas.
  const storedHints = server?.header_hints ?? {};
  const [headers, setHeaders] = useState<Array<{ k: string; v: string; orig?: string }>>(
    Object.keys(storedHints).map((k) => ({ k, v: "", orig: k })),
  );
  const [saving, setSaving] = useState(false);
  // Jeton d'API : saisi ici, envoyé une fois au serveur, jamais relu.
  const [apiToken, setApiToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const headersObj = () => {
    const o: Record<string, string> = {};
    for (const { k, v } of headers) if (k.trim()) o[k.trim()] = v;
    return o;
  };
  const headersDirty = headers.length !== Object.keys(storedHints).length
    || headers.some((h) => h.v !== "" || h.k.trim() !== h.orig);
  const urlValid = /^https?:\/\//i.test(url.trim());
  const authConfig = () => identityMode(authMode)
    ? { audience: teAudience.trim(), ...(teCluster.trim() ? { cluster: teCluster.trim() } : {}), ...(teProvider.trim() ? { provider: teProvider.trim() } : {}) }
    : authMode === "api_token"
      ? { ...(teAudience.trim() ? { audience: teAudience.trim() } : {}), ...(teCluster.trim() ? { cluster: teCluster.trim() } : {}) }
      : {};
  // Le jeton enregistré est lié à sa destination (garde de la migration 0278) :
  // autre origine d'URL ou autre relais, il est effacé et doit être ressaisi.
  const originOf = (u: string) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+/.exec(u.trim())?.[0] ?? "").toLowerCase();
  const keptToken = !!server?.token_hint && server.auth_mode === "api_token"
    && originOf(url) === originOf(server.url) && relayId === (server.relay_id ?? "");
  // Les en-têtes enregistrés sont liés à leur destination, comme le jeton (0280).
  const keptHeaders = !!server && originOf(url) === originOf(server.url) && relayId === (server.relay_id ?? "");
  const headerIssue = authMode !== "header" ? null
    : headers.some((h) => h.k.trim() && !h.v && !(h.orig === h.k.trim() && keptHeaders))
      ? (headers.some((h) => h.orig && !h.v) && !keptHeaders
        ? "L'adresse ou le relais a changé : les valeurs enregistrées seront effacées. Ressaisissez-les."
        : "Saisissez la valeur de chaque nouvel en-tête.")
      : null;
  const tokenValid = authMode !== "api_token"
    ? true
    : apiToken.trim() ? /^[A-Za-z0-9._~+/=-]{16,4096}$/.test(apiToken.trim()) : keptToken;
  // Mêmes formes que la contrainte de la migration 0276 (audience Entra : api://…).
  const teValid = authMode === "api_token"
    ? tokenValid && (!teAudience.trim() || /^[A-Za-z0-9._:/-]{1,200}$/.test(teAudience.trim())) && (!teCluster.trim() || /^[a-z0-9-]{1,30}$/.test(teCluster.trim()))
    : !identityMode(authMode) || (
    /^[A-Za-z0-9._:/-]{1,200}$/.test(teAudience.trim())
    && (!teCluster.trim() || /^[a-z0-9-]{1,30}$/.test(teCluster.trim()))
    && (!teProvider.trim() || /^custom:[a-z0-9][a-z0-9-]{0,40}$/.test(teProvider.trim()))
  );

  async function testDraft() {
    setTesting(true); setTestResult(null);
    try {
      // Hors mode « en-têtes », les en-têtes enregistrés servent encore, mais ne
      // suivent pas une autre destination : le test les omet alors.
      const draftHeaders = authMode === "header" ? headersObj() : keptHeaders ? headersObj() : {};
      const res = await callEdge<{ ok: boolean; error?: string; count?: number }>("mcp-gateway", {
        action: "test", url: url.trim(), headers: draftHeaders, transport,
        ...(server ? { draft_of: server.id } : {}),
        ...(identityMode(authMode) ? { auth_mode: authMode, auth_config: authConfig() } : {}),
        ...(authMode === "api_token" ? { auth_mode: authMode, api_token: apiToken.trim() } : {}),
        ...(relayId ? { relay_id: relayId } : {}),
        // Serveur déjà enregistré, jeton non ressaisi : le test utilise le jeton enregistré.
        ...(authMode === "api_token" && !apiToken.trim() && keptToken && server ? { server_id: server.id } : {}),
      });
      setTestResult(res.ok
        ? { ok: true, msg: `Connexion OK, ${res.count ?? 0} outil(s) découvert(s).` }
        : { ok: false, msg: res.error ?? "Échec de la connexion." });
    } catch (e) {
      setTestResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!name.trim() || !urlValid || !teValid || headerIssue || !workspaceId) return;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        transport,
        auth_mode: authMode,
        auth_config: authConfig(),
        url: url.trim(),
        relay_id: relayId || null,
        environment: environment || null,
        updated_at: new Date().toISOString(),
      };
      let serverId = server?.id;
      if (server) {
        const { error } = await supabase.from("mcp_servers").update(payload).eq("id", server.id);
        if (error) { toast.error(error.message); return; }
      } else {
        const { data, error } = await supabase.from("mcp_servers")
          .insert({ ...payload, workspace_id: workspaceId }).select("id").single();
        if (error) { toast.error(error.message); return; }
        serverId = (data as { id: string }).id;
      }
      // En-têtes : envoyés une fois, chiffrés côté serveur, jamais relus (0280).
      if (serverId && authMode === "header" && headersDirty) {
        const set = await callEdge<{ ok: boolean; error?: string }>("mcp-gateway", { action: "set_headers", server_id: serverId, headers: headersObj() });
        if (!set.ok) { toast.error(set.error ?? "En-têtes refusés"); return; }
      }
      if (serverId && authMode === "api_token" && apiToken.trim()) {
        const set = await callEdge<{ ok: boolean; error?: string }>("mcp-gateway", { action: "set_token", server_id: serverId, token: apiToken.trim() });
        if (!set.ok) { toast.error(set.error ?? "Jeton refusé"); return; }
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
            {urlValid && !relayId && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/i.test(url.trim()) && (
              <p className="mt-1 text-[10px] text-destructive">
                Une adresse en boucle locale ne se joint que par le relais de la passerelle d'entreprise : choisissez-le dans « Accès ».
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Description (optionnel)</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="À quoi sert ce serveur…" />
          </div>

          {/* Authentication mode */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Authentification</label>
            <select value={authMode} onChange={(e) => setAuthMode(e.target.value as AuthMode)} className={inputCls}>
              <option value="api_token">Jeton d'API du serveur (recommandé pour vos serveurs internes)</option>
              <option value="none">Aucune (serveur ouvert)</option>
              <option value="header">Header statique (token / clé d'API)</option>
              <option value="oauth">OAuth 2.1 (connexion interactive)</option>
              <option value="token_exchange">Identité déléguée par l'IdP de l'entreprise (serveur interne)</option>
              <option value="signed_context">Contexte signé par FounderOS (serveur interne)</option>
            </select>
          </div>

          {/* Installation dédiée : jeton d'appel au nom de la personne et de l'agent */}
          {authMode === "api_token" && (
            <div className="space-y-2.5 rounded-lg border border-border bg-secondary/30 p-3">
              <p className="text-[11px] text-muted-foreground">
                À l'installation du serveur MCP :{" "}
                <code className="rounded bg-muted px-1">npm run token -- seed</code> affiche le jeton de la période. Collez-le ici une
                fois : ensuite, le serveur change de jeton chaque jour et livre lui-même le nouveau à FounderOS. Un jeton fixe
                (<code className="rounded bg-muted px-1">npm run token -- generate</code>) se colle de la même façon. FounderOS le garde
                chiffré et le présente à chaque appel d'un agent, avec la personne et l'agent pour l'audit. Le modèle ne le voit jamais.
              </p>
              <div>
                <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Jeton d'API</label>
                <Input type="password" autoComplete="off" value={apiToken} onChange={(e) => setApiToken(e.target.value)}
                  placeholder={keptToken ? `Enregistré : ${server!.token_hint} — laisser vide pour le conserver` : server?.token_hint ? "Nouvelle adresse ou nouveau relais : ressaisissez le jeton" : "mcpt_…"} className="h-8 font-mono" />
                {keptToken && server?.token_received_at && (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {server.token_origin === "push" ? "Dernier jeton livré par le serveur" : "Jeton saisi"} le {new Date(server.token_received_at).toLocaleString()}.
                    {server.token_origin === "push" ? " Les suivants arrivent seuls." : ""}
                  </p>
                )}
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Serveur qui ne reconnaît plus le jeton (FounderOS arrêté plus de 7 jours) :{" "}
                  <code className="rounded bg-muted px-1">npm run token -- current</code> sur le serveur, puis collez le jeton affiché.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Audience (pour les approbations)</label>
                  <Input value={teAudience} onChange={(e) => setTeAudience(e.target.value)} placeholder="mcp-prd" className="h-8" />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Cluster (catalogue des tools)</label>
                  <Input value={teCluster} onChange={(e) => setTeCluster(e.target.value)} placeholder="prd" list="mcp-cluster-hints" className="h-8" />
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground">L'audience est le MCP_AUDIENCE du serveur : elle n'est requise que si des tools demandent une approbation (actions en production).</p>
              {!teValid && <p className="text-[10px] text-destructive">{tokenValid ? "Audience ou cluster invalide."
                : server?.token_hint && !keptToken && !apiToken.trim()
                  ? "L'adresse ou le relais a changé : le jeton enregistré sera effacé à l'enregistrement. Ressaisissez-le."
                  : "Saisissez le jeton (16 caractères au moins, sans espace)."}</p>}
            </div>
          )}

          {identityMode(authMode) && (
            <div className="space-y-2.5 rounded-lg border border-border bg-secondary/30 p-3">
              <p className="text-[11px] text-muted-foreground">
                {authMode === "signed_context"
                  ? "À chaque appel, FounderOS signe un contexte court (personne, agent, rôles) pour ce seul serveur. Le serveur le vérifie avec le JWKS de FounderOS (IDP_ISSUER = l'émetteur des approbations, IDP_JWKS_URL = /functions/v1/approval-jwks)."
                  : "À chaque appel, FounderOS demande à l'IdP de l'entreprise un jeton court pour ce seul serveur, au nom de la personne pour qui l'agent agit et de l'agent lui-même (échange de jeton, ou On-Behalf-Of chez Entra ID)."}
                {" "}En direct, le serveur doit être interne (https, hôte de MCP_INTERNAL_HOSTS) ; par un relais, c'est sa liste blanche qui décide.
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Audience du serveur</label>
                  <Input value={teAudience} onChange={(e) => setTeAudience(e.target.value)} placeholder="mcp-prd ou api://mcp-prd" className="h-8" />
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Cluster ou environnement</label>
                  <Input value={teCluster} onChange={(e) => setTeCluster(e.target.value)} placeholder="prd" list="mcp-cluster-hints" className="h-8" />
                  <datalist id="mcp-cluster-hints">
                    {["dev", "recette", "prd", "hub", "ips", "sdb", "npr"].map((c) => <option key={c} value={c} />)}
                  </datalist>
                </div>
                {authMode === "token_exchange" && (
                  <div>
                    <label className="mb-1 block text-[10px] font-medium text-muted-foreground">Fournisseur (si plusieurs délèguent)</label>
                    <Input value={teProvider} onChange={(e) => setTeProvider(e.target.value)} placeholder="custom:entra" className="h-8" />
                  </div>
                )}
              </div>
              {teAudience && !teValid && <p className="text-[10px] text-destructive">Audience, cluster ou fournisseur invalide.</p>}
            </div>
          )}

          {/* Accès réseau et environnement (G2) */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Accès</label>
              <select value={relayId} onChange={(e) => setRelayId(e.target.value)} className={inputCls}>
                <option value="">En direct</option>
                {(relays ?? []).map((r) => <option key={r.id} value={r.id}>Par le relais « {r.name} »</option>)}
              </select>
              {relayId && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Ajoutez l'hôte du serveur à RELAY_ALLOWED_HOSTS, et à RELAY_CLIENT_CERT_HOSTS s'il exige un certificat client.
                  Serveur MCP de la passerelle d'entreprise : <code className="rounded bg-muted px-1">http://127.0.0.1:8443/mcp</code>, déjà autorisé.
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Environnement</label>
              <select value={environment} onChange={(e) => setEnvironment(e.target.value)} className={inputCls}>
                <option value="">Non précisé</option>
                <option value="development">Développement</option>
                <option value="staging">Recette</option>
                <option value="production">Production</option>
              </select>
            </div>
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
                    <Input
                      type="password" autoComplete="off" value={h.v}
                      onChange={(e) => setHeaders((hs) => hs.map((x, j) => j === i ? { ...x, v: e.target.value } : x))}
                      placeholder={h.orig && h.orig === h.k.trim() && keptHeaders ? `${storedHints[h.orig]} — vide : conservé` : "Valeur"}
                      className="h-8 flex-1 font-mono"
                    />
                    <button onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))} className="rounded p-1 text-muted-foreground hover:text-destructive">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">Les valeurs sont chiffrées et ne se relisent plus, même pour vous : seul un aperçu reste visible.</p>
              {headerIssue && <p className="mt-1 text-[10px] text-destructive">{headerIssue}</p>}
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
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Client OAuth manuel (si l'enregistrement dynamique est refusé, erreur 403)</summary>
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
            <Button size="sm" onClick={save} disabled={saving || !name.trim() || !urlValid || !teValid || !!headerIssue}>
              {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              {server ? "Enregistrer" : "Ajouter"}
            </Button>
          </div>
        </footer>
      </aside>
    </>
  );
}
