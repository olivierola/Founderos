import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock3, Plug, Loader2, Search as SearchIcon, ShieldCheck, Ban, Wrench, Zap, KeyRound, Copy, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

export type ComposioAuthMode = "oauth" | "oauth_custom" | "api_key" | "none" | "unsupported";

/** Credential fields Composio wants to create an auth config for one mode. */
interface AuthConfigField {
  name: string;
  displayName: string;
  description?: string;
  type?: string;
  required?: boolean;
  default?: string | null;
  is_secret?: boolean;
}
interface ToolkitAuthFields {
  slug: string;
  name: string;
  authGuideUrl: string | null;
  callbackUrl: string;
  modes: Array<{ mode: string; name: string; authHintUrl: string | null; required: AuthConfigField[]; optional: AuthConfigField[] }>;
}

export interface ComposioToolkit {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  authMode: ComposioAuthMode;
  authScheme: string;
  authSchemes?: string[];
  managedSchemes?: string[];
  toolsCount?: number;
  triggersCount?: number;
  version?: string;
}

const CONNECT_FILTERS: Array<{ key: "all" | "connected" | "available"; label: string }> = [
  { key: "all", label: "Tous" },
  { key: "connected", label: "Connectés" },
  { key: "available", label: "Disponibles" },
];

// One chip per auth scheme the toolkit accepts, colour-coded by family so the
// grid is scannable (OAuth = violet, clé = vert, secret partagé = rose…).
const SCHEME_STYLES: Record<string, { label: string; className: string }> = {
  OAUTH2: { label: "OAuth2", className: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300" },
  OAUTH1: { label: "OAuth1", className: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300" },
  GOOGLE_SERVICE_ACCOUNT: { label: "Google Service Account", className: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300" },
  API_KEY: { label: "API Key", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" },
  BEARER_TOKEN: { label: "Bearer Token", className: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300" },
  BASIC: { label: "Basic", className: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300" },
  BASIC_WITH_JWT: { label: "Basic + JWT", className: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300" },
  NO_AUTH: { label: "Sans auth", className: "border-border bg-muted text-muted-foreground" },
};

function schemeStyle(scheme: string) {
  return (
    SCHEME_STYLES[scheme] ?? {
      label: scheme.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
      className: "border-border bg-muted text-muted-foreground",
    }
  );
}

// New default connector experience — replaces the in-house Catalog page for
// the Admin "Connecteurs" tab. Browses Composio's full toolkit catalogue
// (~1000 apps) and connects via Composio's own hosted connect link for any
// scheme that needs a credential (OAuth AND API_KEY/BEARER_TOKEN/BASIC) —
// Composio's page adapts itself and collects whatever it needs; we never
// render our own credential form (popup + poll, same as OAuth always was).
// NO_AUTH toolkits have nothing to collect and connect instantly. A handful
// of toolkits only support OAuth WITHOUT Composio-managed auth (e.g.
// Twitter) — those need a custom registered OAuth app we don't support yet,
// shown as "Non supporté". The in-house Catalog/ConnectorDialog/providers.ts
// path is left untouched and simply no longer linked here.
export function ComposioCatalog() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "connected" | "available">("all");
  const [connecting, setConnecting] = useState<ComposioToolkit | null>(null);

  const { data: toolkits, isLoading } = useQuery({
    queryKey: ["composio_toolkits"],
    queryFn: async () => {
      const res = await callEdge<{ toolkits: ComposioToolkit[] }>("composio-catalog", {});
      return res.toolkits;
    },
  });

  const { data: connectors } = useQuery({
    queryKey: ["composio_connectors", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("provider, status")
        .eq("project_id", projectId!)
        .eq("source", "composio");
      return (data ?? []) as Array<{ provider: string; status: string }>;
    },
  });
  const statusByToolkit = useMemo(
    () => new Map((connectors ?? []).map((c) => [c.provider, c.status])),
    [connectors],
  );

  // Deep link from ServiceBadge etc: /admin/connectors?connect=<slug>
  useEffect(() => {
    const slug = searchParams.get("connect");
    if (!slug || !toolkits) return;
    const t = toolkits.find((x) => x.slug === slug);
    if (t && t.authMode !== "unsupported") setConnecting(t);
    searchParams.delete("connect");
    setSearchParams(searchParams, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolkits]);

  // Fetch the full catalogue once, then filter/search client-side — instant,
  // and avoids a fresh ~2s Composio round-trip on every keystroke.
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byCategory = new Map<string, ComposioToolkit[]>();
    for (const t of toolkits ?? []) {
      const status = statusByToolkit.get(t.slug);
      if (filter === "connected" && status !== "connected") continue;
      if (filter === "available" && status === "connected") continue;
      if (q && !(t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))) continue;
      const cat = t.categories[0] || "Autres";
      const arr = byCategory.get(cat) ?? [];
      arr.push(t);
      byCategory.set(cat, arr);
    }
    return [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [toolkits, statusByToolkit, filter, search]);

  return (
    <div>
      <PageHeader
        title="Connecteurs"
        description="Connectez les applications qui alimentent vos agents — via Composio."
      />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher un connecteur" className="pl-9" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {CONNECT_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-full border px-4 py-1.5 text-sm transition-colors",
                filter === f.key
                  ? "border-border bg-secondary text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6">
        {isLoading ? (
          <EmptyState icon={Loader2} title="Chargement du catalogue…" />
        ) : groups.length === 0 ? (
          <EmptyState icon={Plug} title="Aucun connecteur trouvé" description="Essayez une autre recherche ou un autre filtre." />
        ) : (
          <div className="space-y-8">
            {groups.map(([category, items]) => (
              <section key={category}>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{category}</h2>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {items.map((t) => (
                    <ToolkitCard
                      key={t.slug}
                      toolkit={t}
                      status={statusByToolkit.get(t.slug)}
                      onConnect={() => setConnecting(t)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <ComposioConnectDialog
        toolkit={connecting}
        workspaceId={workspaceId}
        projectId={projectId}
        onOpenChange={(o) => !o && setConnecting(null)}
        onConnected={() => queryClient.invalidateQueries({ queryKey: ["composio_connectors", projectId] })}
      />
    </div>
  );
}

// Catalogue tile: logo plate on top, then the toolkit's identity card —
// tool/trigger counts, the auth schemes it accepts, and its Composio version.
// Fallback ComposioToolkit when the catalogue hasn't resolved a slug yet, so
// the shared card still renders (logo → Plug, counts → 0).
export function synthToolkit(slug: string, name: string, description: string | null): ComposioToolkit {
  return {
    slug, name, description: description ?? "", logo: null, categories: [],
    authMode: "oauth", authScheme: "", authSchemes: [], managedSchemes: [],
    toolsCount: 0, triggersCount: 0, version: "",
  };
}

export function ToolkitCard({
  toolkit: t, status, onConnect, active, onToggle,
}: {
  toolkit: ComposioToolkit;
  status: string | undefined;
  onConnect: () => void;
  /** When defined, the card shows an "Activer/Activé" control (agent contexts). */
  active?: boolean;
  onToggle?: () => void;
}) {
  const unsupported = t.authMode === "unsupported";
  const customOAuth = t.authMode === "oauth_custom";
  const schemes = t.authSchemes?.length ? t.authSchemes : t.authScheme ? [t.authScheme] : [];
  const managed = (t.managedSchemes?.length ?? 0) > 0;

  return (
    <div
      role="button"
      aria-disabled={unsupported}
      onClick={() => !unsupported && onConnect()}
      title={
        unsupported
          ? "Schéma d'authentification non supporté"
          : customOAuth
            ? "Nécessite votre propre app OAuth — client id/secret demandés à la connexion"
            : t.description || undefined
      }
      className={cn(
        "group flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors",
        unsupported ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-primary/40 hover:bg-secondary/30",
        active && "border-primary/50 ring-1 ring-primary/30",
      )}
    >
      <div className="relative flex h-28 shrink-0 items-center justify-center border-b border-border bg-muted/40">
        {t.logo ? (
          <img src={t.logo} alt="" loading="lazy" className="h-12 w-12 rounded-md object-contain" />
        ) : (
          <Plug className="h-8 w-8 text-muted-foreground" />
        )}
        {status === "connected" ? (
          <Badge variant="success" className="absolute right-2 top-2 text-[10px]">
            <CheckCircle2 className="mr-1 h-3 w-3" /> connecté
          </Badge>
        ) : status === "pending" ? (
          <Badge variant="warning" className="absolute right-2 top-2 text-[10px]">
            <Clock3 className="mr-1 h-3 w-3" /> en attente
          </Badge>
        ) : unsupported ? (
          <Badge variant="secondary" className="absolute right-2 top-2 text-[10px]">
            <Ban className="mr-1 h-3 w-3" /> non supporté
          </Badge>
        ) : customOAuth ? (
          <Badge variant="secondary" className="absolute right-2 top-2 text-[10px]">
            <KeyRound className="mr-1 h-3 w-3" /> votre app OAuth
          </Badge>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <span className="truncate text-[15px] font-semibold leading-tight">{t.name}</span>

        <div className="flex items-center gap-4 font-mono text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5" title="Outils disponibles">
            <Wrench className="h-3.5 w-3.5" />
            {t.toolsCount ?? 0}
          </span>
          <span className="inline-flex items-center gap-1.5" title="Déclencheurs disponibles">
            <Zap className="h-3.5 w-3.5" />
            {t.triggersCount ? t.triggersCount : "-"}
          </span>
        </div>

        <div className="mt-auto flex items-center gap-1.5 pt-1">
          {schemes.slice(0, 2).map((s) => {
            const { label, className } = schemeStyle(s);
            return (
              <span
                key={s}
                title={label}
                className={cn("max-w-[6.5rem] truncate rounded border px-1.5 py-0.5 font-mono text-[10px]", className)}
              >
                {label}
              </span>
            );
          })}
          {schemes.length > 2 && (
            <span className="font-mono text-[10px] text-muted-foreground" title={schemes.slice(2).map((s) => schemeStyle(s).label).join(", ")}>
              +{schemes.length - 2}
            </span>
          )}
          {managed && (
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Authentification gérée par Composio">
              <title>Authentification gérée par Composio — aucune app à créer</title>
            </ShieldCheck>
          )}
          {t.version && (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">v{t.version}</span>
          )}
        </div>

        {/* Agent contexts: activate the toolkit for the agent (only meaningful
            once connected). Stops propagation so it doesn't trigger the card's
            connect click. */}
        {onToggle && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            disabled={status !== "connected"}
            title={status !== "connected" ? "Connectez d'abord ce toolkit" : undefined}
            className={cn(
              "mt-1 w-full rounded-lg px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
              active ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground hover:bg-secondary/70",
            )}
          >
            {active ? "Activé pour l'agent" : "Activer pour l'agent"}
          </button>
        )}
      </div>
    </div>
  );
}

export function ComposioConnectDialog({
  toolkit, workspaceId, projectId, onOpenChange, onConnected,
}: {
  toolkit: ComposioToolkit | null;
  workspaceId: string | null | undefined;
  projectId: string | null | undefined;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  // Toolkits with no Composio-managed app pause on a credentials form first;
  // everything else goes straight to Composio's hosted page.
  const needsOwnApp = toolkit?.authMode === "oauth_custom";
  const [phase, setPhase] = useState<"credentials" | "connecting" | "waiting" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string> | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    setCredentials(null);
    setRedirectUrl(null);
    setPopupBlocked(false);
    setPhase(needsOwnApp ? "credentials" : "connecting");
  }, [toolkit?.slug, needsOwnApp]);

  useEffect(() => {
    if (!toolkit || !workspaceId || !projectId) return;
    if (needsOwnApp && !credentials) return;
    let cancelled = false;
    setError(null);
    setPhase("connecting");

    (async () => {
      try {
        // NO_AUTH resolves instantly (nothing to collect); every other mode
        // opens Composio's own hosted page, which adapts to whatever the
        // toolkit needs (OAuth consent screen, or a credential form) — we
        // never render our own form, except for the client id/secret of a
        // custom OAuth app, which Composio needs BEFORE it can build a page.
        const res = await callEdge<{ ok: boolean; redirect_url?: string; status?: string }>("composio-connect", {
          workspace_id: workspaceId, project_id: projectId, toolkit: toolkit.slug, auth_scheme: toolkit.authScheme,
          ...(credentials ? { credentials } : {}),
        });
        if (cancelled) return;
        if (!res.redirect_url) {
          onConnected();
          onOpenChange(false);
          return;
        }
        // Best-effort auto-open: this runs after an await, so it's outside the
        // click's user-gesture window and most browsers block it silently.
        // The link rendered below is the reliable path — window.open returns
        // null when blocked, which is what we surface.
        const popup = window.open(res.redirect_url, "_blank", "noopener,noreferrer");
        setRedirectUrl(res.redirect_url);
        setPopupBlocked(!popup);
        setPhase("waiting");
        pollRef.current = window.setInterval(async () => {
          try {
            const s = await callEdge<{ status: string }>("composio-connection-status", {
              workspace_id: workspaceId, project_id: projectId, toolkit: toolkit.slug,
            });
            if (s.status === "connected") {
              if (pollRef.current) clearInterval(pollRef.current);
              onConnected();
              onOpenChange(false);
            }
          } catch {
            // keep polling — a transient error shouldn't abort the wait
          }
        }, 2000);
      } catch (e) {
        if (!cancelled) { setPhase("error"); setError(e instanceof Error ? e.message : String(e)); }
      }
    })();

    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolkit?.slug, workspaceId, projectId, credentials]);

  return (
    <Dialog open={!!toolkit} onOpenChange={onOpenChange}>
      <DialogContent className={phase === "credentials" ? "max-w-lg" : "max-w-sm"}>
        <DialogHeader><DialogTitle>Connecter {toolkit?.name}</DialogTitle></DialogHeader>
        {phase === "error" ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : phase === "credentials" && toolkit ? (
          <OwnOAuthAppForm toolkit={toolkit} onSubmit={setCredentials} />
        ) : phase === "waiting" && redirectUrl ? (
          <div className="space-y-4 py-2">
            <Button asChild className="w-full">
              <a href={redirectUrl} target="_blank" rel="noopener noreferrer">
                Ouvrir la page d'autorisation <ExternalLink className="ml-2 h-3.5 w-3.5" />
              </a>
            </Button>
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {popupBlocked
                ? "Le navigateur a bloqué l'ouverture automatique — ouvrez la page ci-dessus."
                : "En attente de l'autorisation dans l'onglet ouvert…"}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Préparation de la connexion…</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Composio has no shared OAuth app for these toolkits, so the workspace has to
// register its own with the provider (Azure AD for Power BI, etc.) and paste
// its credentials here. Which fields exactly is up to the toolkit — Composio
// declares them, so we render whatever it asks for rather than hard-coding
// client_id/client_secret.
function OwnOAuthAppForm({
  toolkit, onSubmit,
}: {
  toolkit: ComposioToolkit;
  onSubmit: (credentials: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["composio_toolkit_fields", toolkit.slug],
    queryFn: () => callEdge<ToolkitAuthFields>("composio-catalog", { toolkit_slug: toolkit.slug }),
  });

  const mode = useMemo(() => {
    const wanted = toolkit.authScheme.toLowerCase();
    return (
      data?.modes.find((m) => m.mode.toLowerCase() === wanted) ??
      data?.modes.find((m) => m.mode.toLowerCase().startsWith("oauth")) ??
      data?.modes[0]
    );
  }, [data, toolkit.authScheme]);

  const fields = useMemo(
    () => [...(mode?.required ?? []), ...(mode?.optional ?? [])],
    [mode],
  );
  const missing = (mode?.required ?? []).some((f) => !(values[f.name] ?? f.default ?? "").trim());

  // Several toolkits declare their own redirect-URI field with a default that
  // differs from Composio's documented callback (Power BI still points at
  // /api/v1/auth-apps/add). The declared value is the one the provider will
  // be handed at authorize time, so it wins over our constant — otherwise the
  // app is registered with a URI that never matches and OAuth dies on
  // redirect_uri_mismatch. It also follows the field if the user edits it.
  const redirectField = fields.find((f) => /redirect/i.test(f.name) || /redirect/i.test(f.displayName ?? ""));
  const callbackUrl =
    (redirectField && (values[redirectField.name] ?? redirectField.default)) || data?.callbackUrl || "";

  if (isLoading) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Champs requis par {toolkit.name}…</p>
      </div>
    );
  }
  if (error || !data || !mode) {
    return <p className="text-sm text-destructive">Impossible de charger les champs d'authentification de {toolkit.name}.</p>;
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const payload: Record<string, string> = {};
        for (const f of fields) {
          const v = (values[f.name] ?? f.default ?? "").trim();
          if (v) payload[f.name] = v;
        }
        onSubmit(payload);
      }}
    >
      <p className="text-sm text-muted-foreground">
        Composio n'héberge pas d'app OAuth partagée pour {toolkit.name} : créez la vôtre chez le
        fournisseur, puis collez ses identifiants ici.
      </p>

      <div className="rounded-lg border border-border bg-muted/40 p-3">
        <div className="text-xs font-medium">URL de redirection à déclarer dans votre app</div>
        <div className="mt-1.5 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-[11px]" title={callbackUrl}>{callbackUrl}</code>
          <Button
            type="button" size="sm" variant="ghost"
            onClick={() => { navigator.clipboard.writeText(callbackUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          >
            {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
        {(mode.authHintUrl || data.authGuideUrl) && (
          <a
            href={(mode.authHintUrl ?? data.authGuideUrl)!}
            target="_blank" rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Guide de création de l'app <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <div className="space-y-3">
        {fields.map((f) => (
          <div key={f.name} className="space-y-1.5">
            <label htmlFor={f.name} className="block text-xs text-muted-foreground">
              {f.displayName || f.name}
              {f.required ? <span className="ml-1 text-destructive">*</span> : <span className="ml-1">(optionnel)</span>}
            </label>
            <Input
              id={f.name}
              type={f.is_secret ? "password" : "text"}
              autoComplete="off"
              value={values[f.name] ?? f.default ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            />
            {f.description && <p className="text-[11px] leading-snug text-muted-foreground">{f.description}</p>}
          </div>
        ))}
      </div>

      <Button type="submit" disabled={missing} className="w-full">Continuer vers l'autorisation</Button>
    </form>
  );
}
