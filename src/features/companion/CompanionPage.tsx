import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useBlocker, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleNotchIcon as Loader2,
  FileTextIcon as FileText,
  PlusIcon as Plus,
  XIcon as X,
  CheckIcon as Check,
  CrosshairIcon as Crosshair,
  SparkleIcon as Sparkle,
  GearSixIcon as Gear,
  MagnifyingGlassIcon as Search,
  CaretDownIcon as ChevronDown,
  ArrowSquareOutIcon as ExternalLink,
  PlugsConnectedIcon as Plugs,
  QuotesIcon as Quote,
  CursorClickIcon as CursorClick,
  ArrowsClockwiseIcon as Swap,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChatTab } from "@/features/internal-agents/InternalAgentDetail";
import type { InternalAgent } from "@/features/internal-agents/shared";
import type { ArtifactOpenTarget } from "@/features/internal-agents/UiBlocks";
import { useCompanionBridge, type CompanionIntent, type FeedItem } from "./bridge";
import {
  formatElementBlock, formatPageBlock, formatSelectionBlock, formatUnchangedPage,
} from "./contextBlocks";
import { ANALYZE_PAGE_PROMPT, SELECTION_PROMPTS, suggestionsFor } from "./suggestions";

/**
 * The browser side panel: every collaborator, beside the page you're on.
 *
 * Rendered by the extension's side panel in an iframe (browser-recorder/
 * src/panel.html), so the chat here IS the app's chat (ChatTab): same runs,
 * same inline approvals, same deliverables. What this page adds is the page
 * itself: attached on demand or by default, a selection or an element pointed
 * at in it, and suggestions that depend on the site.
 */

const PROJECT_KEY = "anduran.companion.project";
const AGENT_KEY = "anduran.companion.agent";
const ATTACH_KEY = "anduran.companion.attachPage";
const SITES_KEY = "anduran.companion.siteAgents";
const CONSENT_KEY = "anduran.companion.pairConsent";

const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } };
const uid = () => Math.random().toString(36).slice(2);

// ───────────────────────────────────────────────────────────────────────────
// /companion : session, puis le projet à ouvrir
// ───────────────────────────────────────────────────────────────────────────

export function CompanionEntry() {
  const { session, user, loading } = useAuth();
  const location = useLocation();
  const [params] = useSearchParams();
  // The panel waits for this handshake to stop its spinner, signed in or not.
  useCompanionBridge({ signedIn: !!session });

  const { data: projects, isLoading } = useQuery({
    queryKey: ["companion_projects", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data: memberships } = await supabase
        .from("workspace_members").select("workspace_id").eq("user_id", user!.id);
      const wsIds = (memberships ?? []).map((m: { workspace_id: string }) => m.workspace_id);
      if (!wsIds.length) return [];
      const [{ data: ws }, { data: ps }] = await Promise.all([
        supabase.from("workspaces").select("id, slug, name").in("id", wsIds),
        supabase.from("projects").select("id, slug, name, workspace_id").in("workspace_id", wsIds).order("created_at"),
      ]);
      const wsById = new Map(((ws ?? []) as Array<{ id: string; slug: string; name: string }>).map((w) => [w.id, w]));
      return ((ps ?? []) as Array<{ id: string; slug: string; name: string; workspace_id: string }>)
        .filter((p) => wsById.has(p.workspace_id))
        .map((p) => ({ ws: wsById.get(p.workspace_id)!.slug, wsName: wsById.get(p.workspace_id)!.name, proj: p.slug, name: p.name }));
    },
  });

  if (loading) return <Centered><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></Centered>;
  if (!session) return <CompanionSignIn />;
  if (isLoading || !projects) return <Centered><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></Centered>;
  if (!projects.length) {
    return <Centered><p className="max-w-xs text-center text-sm text-muted-foreground">Aucun projet sur ce compte. Créez-en un dans Anduran, puis rouvrez le panneau.</p></Centered>;
  }

  const stored = (() => { try { return JSON.parse(read(PROJECT_KEY) ?? "null") as { ws: string; proj: string } | null; } catch { return null; } })();
  const wantsPicker = params.has("pick") && projects.length > 1;
  if (wantsPicker) return <ProjectPicker projects={projects} search={location.search} />;
  const target = projects.find((p) => p.ws === stored?.ws && p.proj === stored?.proj) ?? projects[0];
  const search = new URLSearchParams(location.search);
  search.delete("pick");
  const qs = search.toString();
  return <Navigate to={`/companion/${target.ws}/${target.proj}${qs ? `?${qs}` : ""}`} replace />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-screen w-full items-center justify-center bg-background p-6">{children}</div>;
}

function ProjectPicker({ projects, search }: { projects: Array<{ ws: string; wsName: string; proj: string; name: string }>; search: string }) {
  const navigate = useNavigate();
  const qs = new URLSearchParams(search);
  qs.delete("pick");
  return (
    <div className="flex h-screen flex-col gap-3 overflow-y-auto bg-background p-5">
      <h1 className="text-base font-semibold">Quel projet ?</h1>
      <p className="text-xs text-muted-foreground">Le panneau affiche les collaborateurs d'un projet à la fois.</p>
      <div className="flex flex-col gap-1.5">
        {projects.map((p) => (
          <button
            key={`${p.ws}/${p.proj}`}
            onClick={() => {
              write(PROJECT_KEY, JSON.stringify({ ws: p.ws, proj: p.proj }));
              navigate(`/companion/${p.ws}/${p.proj}${qs.toString() ? `?${qs}` : ""}`, { replace: true });
            }}
            className="rounded-2xl border border-border px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
          >
            <span className="block text-sm font-medium">{p.name}</span>
            <span className="block text-[11px] text-muted-foreground">{p.wsName}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Signed out, inside a frame: email sign-in works here, a Google redirect
 *  does not (Google refuses to be framed), so a full tab is offered too. */
function CompanionSignIn() {
  const navigate = useNavigate();
  return (
    <Centered>
      <div className="flex max-w-xs flex-col items-center gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Sparkle weight="fill" className="h-6 w-6" />
        </div>
        <h1 className="text-lg font-semibold">Vos collaborateurs, à côté de chaque page</h1>
        <p className="text-sm text-muted-foreground">Connectez-vous à Anduran pour leur parler depuis ce panneau.</p>
        <button
          onClick={() => navigate("/login?next=/companion")}
          className="w-full rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-teal-accent"
        >
          Se connecter
        </button>
        <button
          onClick={() => window.open("/login?next=/companion", "_blank", "noopener")}
          className="w-full rounded-full border border-border px-4 py-2.5 text-sm font-medium hover:bg-secondary"
        >
          Se connecter dans un onglet
        </button>
        <button onClick={() => window.location.reload()} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
          C'est fait, recharger
        </button>
      </div>
    </Centered>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// /companion/:workspaceSlug/:projectSlug
// ───────────────────────────────────────────────────────────────────────────

interface Attachment { id: string; kind: "selection" | "element"; label: string; block: string }

export function CompanionPage() {
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId, project, loading, notFound } = useCurrentContext();
  const { session } = useAuth();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    if (workspaceSlug && projectSlug && project) write(PROJECT_KEY, JSON.stringify({ ws: workspaceSlug, proj: projectSlug }));
  }, [workspaceSlug, projectSlug, project]);

  // Everything outside /companion opens in a normal tab: a deliverable, a
  // settings page or a room has no business squeezed into a side panel.
  const blocker = useBlocker(({ nextLocation }) => !nextLocation.pathname.startsWith("/companion"));
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const l = blocker.location;
    window.open(`${l.pathname}${l.search}${l.hash}`, "_blank", "noopener");
    blocker.reset();
  }, [blocker]);
  // Same for a plain external link without a target: inside a frame it would
  // replace the panel with a site that most likely refuses to be framed.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || e.defaultPrevented) return;
      if (a.origin !== window.location.origin) { e.preventDefault(); window.open(a.href, "_blank", "noopener"); }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // ── Collaborators ──
  const { data: agents } = useQuery({
    queryKey: ["companion_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents").select("*")
        .eq("project_id", projectId!).eq("is_archived", false)
        .order("updated_at", { ascending: false });
      return (data ?? []) as Array<InternalAgent & { is_orchestrator?: boolean; updated_at?: string; service_dashboard_id?: string | null }>;
    },
  });
  const agentIds = useMemo(() => (agents ?? []).map((a) => a.id), [agents]);
  const { data: busy } = useQuery({
    queryKey: ["companion_busy", agentIds.join(",")],
    enabled: agentIds.length > 0,
    refetchInterval: 5000,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_runs").select("agent_id")
        .in("agent_id", agentIds).in("status", ["running", "queued"])
        .gt("created_at", new Date(Date.now() - 6 * 3600_000).toISOString());
      return new Set(((data ?? []) as Array<{ agent_id: string }>).map((r) => r.agent_id));
    },
  });

  const [agentId, setAgentId] = useState<string | null>(() => searchParams.get("a") || read(AGENT_KEY));
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const agent = useMemo(() => (agents ?? []).find((a) => a.id === agentId) ?? null, [agents, agentId]);
  useEffect(() => {
    if (!agents?.length || agent) return;
    const fallback = agents.find((a) => a.is_orchestrator) ?? agents[0];
    setAgentId(fallback.id);
  }, [agents, agent]);
  useEffect(() => {
    if (!searchParams.get("a")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("a");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const selectAgent = useCallback((id: string) => {
    setAgentId(id);
    write(AGENT_KEY, id);
    setUnread((u) => { const n = new Set(u); n.delete(id); return n; });
  }, []);

  // Recently used first: a strip of twenty avatars is only useful if the two
  // you talk to every day are at the start of it.
  const ordered = useMemo(() => {
    const recent: string[] = (() => { try { return JSON.parse(read(`${AGENT_KEY}.recent`) ?? "[]"); } catch { return []; } })();
    const rank = (a: { id: string; is_orchestrator?: boolean }) => {
      const i = recent.indexOf(a.id);
      return i >= 0 ? i : a.is_orchestrator ? 50 : 100;
    };
    return [...(agents ?? [])].sort((x, y) => rank(x) - rank(y));
  }, [agents, agentId]);
  useEffect(() => {
    if (!agentId) return;
    const recent: string[] = (() => { try { return JSON.parse(read(`${AGENT_KEY}.recent`) ?? "[]"); } catch { return []; } })();
    write(`${AGENT_KEY}.recent`, JSON.stringify([agentId, ...recent.filter((x) => x !== agentId)].slice(0, 12)));
  }, [agentId]);

  // ── Context attached to the next message ──
  const [attachPage, setAttachPage] = useState(() => read(ATTACH_KEY) !== "0");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sendRequest, setSendRequest] = useState<{ id: string; text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [picking, setPicking] = useState(false);

  const onFeed = useCallback((items: FeedItem[]) => {
    for (const it of items) {
      qc.invalidateQueries({ queryKey: ["internal_agent_messages", it.conversation_id] });
      qc.invalidateQueries({ queryKey: ["internal_agent_conversations", it.agent.id] });
    }
    setUnread((u) => {
      const n = new Set(u);
      for (const it of items) if (it.agent.id !== agentIdRef.current && !it.interim) n.add(it.agent.id);
      return n;
    });
  }, [qc]);

  const intentRef = useRef<(i: CompanionIntent) => void>(() => {});
  const bridge = useCompanionBridge({
    signedIn: !!session,
    onIntent: (i) => intentRef.current(i),
    onFeed,
    onPairCode: (code) => setPairCode(code),
  });

  const agentIdRef = useRef(agentId); agentIdRef.current = agentId;
  const tabRef = useRef(bridge.tab); tabRef.current = bridge.tab;
  const attachPageRef = useRef(attachPage); attachPageRef.current = attachPage;
  const attachmentsRef = useRef(attachments); attachmentsRef.current = attachments;
  const forcePageRef = useRef(false);
  const convoRef = useRef<string | null>(null);
  // Per conversation, the page last sent: the same page twice goes out as a
  // one-line reference, not twenty thousand characters again.
  const sentPages = useRef(new Map<string, string>());

  // The collaborator the panel talks to: the selection pill and the context
  // menu say its name, and a question asked from a bubble goes to it.
  useEffect(() => {
    if (agent && bridge.connected) bridge.post({ type: "agent", agent: { id: agent.id, name: agent.name } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, bridge.connected]);

  const send = useCallback((text: string) => setSendRequest({ id: uid(), text }), []);
  const focusComposer = () => requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>("[data-companion-chat] textarea")?.focus();
  });
  const addAttachment = (a: Omit<Attachment, "id">) => setAttachments((list) => [...list.slice(-3), { ...a, id: uid() }]);

  const prepareMessage = useCallback(async (text: string) => {
    const parts = [text];
    const tab = tabRef.current;
    const force = forcePageRef.current;
    forcePageRef.current = false;
    if (bridge.inPanel && tab?.injectable && (attachPageRef.current || force)) {
      try {
        const cap = await bridge.capturePage();
        const key = `${agentIdRef.current}:${convoRef.current ?? "new"}`;
        const sig = `${cap.url}#${cap.hash}`;
        parts.push(sentPages.current.get(key) === sig ? formatUnchangedPage(cap) : formatPageBlock(cap));
        sentPages.current.set(key, sig);
      } catch (e) {
        setNotice(`Page non jointe : ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const a of attachmentsRef.current) parts.push(a.block);
    setAttachments([]);
    // Remember who you work with on this site, to offer them next time.
    if (tab?.host && agentIdRef.current) {
      try {
        const map = JSON.parse(read(SITES_KEY) ?? "{}") as Record<string, string>;
        map[tab.host] = agentIdRef.current;
        write(SITES_KEY, JSON.stringify(map));
      } catch { /* mémoire de confort */ }
    }
    return parts.filter(Boolean).join("\n\n");
  }, [bridge]);

  const onConversationChange = useCallback((id: string | null) => {
    const prev = convoRef.current;
    if (!prev && id) {
      const from = `${agentIdRef.current}:new`;
      const sig = sentPages.current.get(from);
      if (sig) { sentPages.current.set(`${agentIdRef.current}:${id}`, sig); sentPages.current.delete(from); }
    }
    convoRef.current = id;
  }, []);

  const pick = useCallback(async () => {
    if (!bridge.inPanel) return;
    setPicking(true);
    setNotice(null);
    try {
      const el = await bridge.pickElement();
      if (el?.ok) {
        addAttachment({ kind: "element", label: el.label || el.text.slice(0, 40) || el.tag, block: formatElementBlock(el) });
        focusComposer();
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  }, [bridge]);

  intentRef.current = (intent: CompanionIntent) => {
    switch (intent.kind) {
      case "send_page":
        forcePageRef.current = true;
        send(ANALYZE_PAGE_PROMPT);
        return;
      case "selection": {
        if (!intent.text?.trim()) { focusComposer(); return; }
        addAttachment({ kind: "selection", label: intent.text.slice(0, 48), block: formatSelectionBlock(intent) });
        if (intent.action && intent.action !== "ask") send(SELECTION_PROMPTS[intent.action]);
        else focusComposer();
        return;
      }
      case "link":
        send(`Que contient ce lien, et qu'est-ce qui mérite mon attention ? ${intent.url}`);
        return;
      case "pick":
        void pick();
        return;
      case "focus":
        focusComposer();
        return;
      case "open_conversation":
        if (intent.agent_id) selectAgent(intent.agent_id);
        if (intent.conversation_id) {
          const next = new URLSearchParams(searchParams);
          next.set("c", intent.conversation_id);
          setSearchParams(next, { replace: true });
        }
        return;
      default:
    }
  };

  // ── Pairing: one click, never a code to copy ──
  const pairNow = useCallback(async () => {
    if (!pairCode || !workspaceId || !projectId) return;
    setPairing(true);
    try {
      const { error } = await supabase.functions.invoke("test-run-orchestrate", {
        body: { action: "pair_recorder", workspace_id: workspaceId, project_id: projectId, code: pairCode },
      });
      if (error) throw error;
      write(CONSENT_KEY, "1");
      setPairCode(null);
      bridge.post({ type: "paired" });
    } catch (e) {
      setNotice(`Liaison impossible : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPairing(false);
    }
  }, [pairCode, workspaceId, projectId, bridge]);
  // Already said yes once (another browser, a reinstall): no second question.
  useEffect(() => {
    if (pairCode && read(CONSENT_KEY) === "1" && workspaceId && projectId && !pairing) void pairNow();
  }, [pairCode, workspaceId, projectId, pairing, pairNow]);

  const suggestions = useMemo(() => suggestionsFor(bridge.tab), [bridge.tab]);
  const siteAgent = useMemo(() => {
    if (!bridge.tab?.host) return null;
    try {
      const id = (JSON.parse(read(SITES_KEY) ?? "{}") as Record<string, string>)[bridge.tab.host];
      return id && id !== agentId ? (agents ?? []).find((a) => a.id === id) ?? null : null;
    } catch { return null; }
  }, [bridge.tab?.host, agentId, agents]);

  const openInTab = (target: ArtifactOpenTarget) => {
    if (!target.id) return;
    const base = `/app/${workspaceSlug}/${projectSlug}`;
    const kind = ["document", "spreadsheet", "presentation"].includes(target.kind) ? target.kind : "document";
    const url = target.table === "office_documents"
      ? `${base}/artifact/${kind}/${target.id}`
      : target.agentId && agent?.service_dashboard_id
        ? `${base}/service/${agent.service_dashboard_id}/agent/${target.agentId}`
        : base;
    window.open(url, "_blank", "noopener");
  };

  if (loading) return <Centered><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></Centered>;
  if (notFound) return <Navigate to="/companion?pick=1" replace />;

  const tab = bridge.tab;
  const pageChip = bridge.inPanel ? (
    tab?.injectable ? (
      <button
        type="button"
        onClick={() => { const v = !attachPage; setAttachPage(v); write(ATTACH_KEY, v ? "1" : "0"); }}
        title={attachPage ? "La page sera jointe à votre message. Cliquez pour ne plus la joindre." : "Joindre la page à votre message"}
        className={cn(
          "inline-flex max-w-[220px] items-center gap-1.5 rounded-full border py-1 pl-2 pr-2.5 text-xs transition-colors",
          attachPage
            ? "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
            : "border-foreground/10 bg-foreground/[0.06] text-foreground/70 hover:text-foreground",
        )}
      >
        {tab.favIconUrl
          ? <img src={tab.favIconUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm" />
          : <FileText className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">{attachPage ? tab.title || tab.host : "Joindre la page"}</span>
        {attachPage ? <Check weight="bold" className="h-3 w-3 shrink-0" /> : <Plus className="h-3 w-3 shrink-0" />}
      </button>
    ) : (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-foreground/15 px-2.5 py-1 text-xs text-foreground/45">
        <FileText className="h-3.5 w-3.5" /> Page non lisible
      </span>
    )
  ) : null;

  const chips = (pageChip || attachments.length > 0) ? (
    <>
      {pageChip}
      {attachments.map((a) => (
        <span key={a.id} className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-foreground/10 bg-foreground/[0.06] py-1 pl-2.5 pr-1 text-xs text-foreground/75">
          {a.kind === "selection" ? <Quote className="h-3.5 w-3.5 shrink-0" /> : <CursorClick className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{a.kind === "selection" ? `« ${a.label} »` : a.label}</span>
          <button
            type="button"
            onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
            className="rounded-full p-0.5 hover:bg-foreground/10"
            aria-label="Retirer"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </>
  ) : undefined;

  const quickRow = bridge.inPanel && (suggestions.length > 0 || tab?.injectable) ? (
    <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
      {tab?.injectable && (
        <button
          type="button"
          onClick={() => void pick()}
          disabled={picking}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs text-foreground/80 backdrop-blur hover:border-primary/40 hover:text-foreground disabled:opacity-60"
        >
          <Crosshair className="h-3.5 w-3.5" /> {picking ? "Cliquez dans la page…" : "Pointer"}
        </button>
      )}
      {suggestions.slice(0, 3).map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => { forcePageRef.current = true; send(s.prompt); }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs text-foreground/80 backdrop-blur hover:border-primary/40 hover:text-foreground"
        >
          <Sparkle className="h-3.5 w-3.5 text-primary" /> {s.label}
        </button>
      ))}
    </div>
  ) : undefined;

  const emptyExtras = bridge.inPanel ? (
    <div className="mt-4 w-full space-y-2">
      {tab?.injectable && (
        <div className="flex items-center gap-2.5 rounded-2xl border border-border/70 bg-card/60 px-3 py-2.5">
          {tab.favIconUrl
            ? <img src={tab.favIconUrl} alt="" className="h-5 w-5 shrink-0 rounded" />
            : <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{tab.title}</div>
            <div className="truncate text-[11px] text-muted-foreground">{tab.host}</div>
          </div>
          <button
            type="button"
            onClick={() => void pick()}
            disabled={picking}
            title="Pointer un élément de la page"
            aria-label="Pointer un élément de la page"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/70 text-foreground/70 hover:border-primary/40 hover:text-foreground disabled:opacity-60"
          >
            <Crosshair className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => { forcePageRef.current = true; send(ANALYZE_PAGE_PROMPT); }}
            className="shrink-0 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-teal-accent"
          >
            Analyser
          </button>
        </div>
      )}
      <div className="grid gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => { forcePageRef.current = true; send(s.prompt); }}
            className="flex items-center gap-2.5 rounded-2xl border border-border/60 px-3 py-2 text-left text-xs transition-colors hover:border-primary/40 hover:bg-primary/5"
          >
            <Sparkle className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
          </button>
        ))}
      </div>
      <p className="pt-1 text-center text-[10.5px] leading-relaxed text-muted-foreground">
        <kbd className="rounded border border-border px-1">Alt+Shift+P</kbd> envoie la page,{" "}
        <kbd className="rounded border border-border px-1">Alt+Shift+S</kbd> la sélection,{" "}
        <kbd className="rounded border border-border px-1">Alt+Shift+E</kbd> pointe un élément.
      </p>
    </div>
  ) : (
    <p className="mt-4 text-center text-[11px] text-muted-foreground">
      Ouvert hors du panneau du navigateur : installez l'extension Anduran pour joindre vos pages.
    </p>
  );

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background text-foreground">
      {/* Roster: every collaborator of the project, recent ones first. */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {ordered.map((a) => {
            const selected = a.id === agentId;
            const working = busy?.has(a.id) ?? false;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => selectAgent(a.id)}
                title={`${a.name}${working ? ", au travail" : ""}`}
                aria-label={a.name}
                aria-pressed={selected}
                className={cn(
                  "relative shrink-0 rounded-full p-[3px] transition-shadow",
                  selected ? "ring-2 ring-primary" : "ring-1 ring-transparent hover:ring-border",
                )}
              >
                <AgentIdentity
                  style={a.avatar_style}
                  url={a.avatar_url}
                  seed={a.name}
                  size={28}
                  accentColor={a.accent_color}
                  state={working ? "working" : "default"}
                  interactive={false}
                  paused={!working && !selected}
                  rounded="rounded-full"
                />
                {unread.has(a.id) && <span className="absolute right-0 top-0 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-background" />}
              </button>
            );
          })}
        </div>
        <AllCollaboratorsMenu agents={ordered} busy={busy} onSelect={selectAgent} />
        <SettingsMenu
          bridge={bridge}
          attachPage={attachPage}
          onAttachPage={(v) => { setAttachPage(v); write(ATTACH_KEY, v ? "1" : "0"); }}
          appUrl={`/app/${workspaceSlug}/${projectSlug}`}
        />
      </header>

      {pairCode && bridge.device.state === "pairing" && read(CONSENT_KEY) !== "1" && (
        <div className="flex shrink-0 items-start gap-2.5 border-b border-border/60 bg-primary/5 px-3 py-2.5">
          <Plugs className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1 text-xs">
            <p className="font-medium">Relier ce navigateur à votre compte ?</p>
            <p className="mt-0.5 text-muted-foreground">Vos collaborateurs pourront surligner la page et vous répondre dans une bulle quand le panneau est fermé.</p>
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => void pairNow()}
                disabled={pairing}
                className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-teal-accent disabled:opacity-60"
              >
                {pairing ? "Liaison…" : "Relier"}
              </button>
              <button type="button" onClick={() => setPairCode(null)} className="rounded-full px-3 py-1 text-xs text-muted-foreground hover:bg-secondary">
                Plus tard
              </button>
            </div>
          </div>
        </div>
      )}
      {bridge.device.state === "other_project" && (
        <p className="shrink-0 border-b border-border/60 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          L'extension est reliée à un autre espace Anduran : les surlignages et les bulles passent par celui-là.
        </p>
      )}
      {siteAgent && (
        <button
          type="button"
          onClick={() => selectAgent(siteAgent.id)}
          className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2 text-left text-[11.5px] text-muted-foreground transition-colors hover:bg-secondary"
        >
          <Swap className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">
            Sur {tab?.host}, vous travaillez d'habitude avec <strong className="text-foreground">{siteAgent.name}</strong>
          </span>
          <span className="shrink-0 text-primary">Basculer</span>
        </button>
      )}
      {notice && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[11.5px] text-muted-foreground">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Fermer"><X className="h-3 w-3" /></button>
        </div>
      )}

      <div className="relative min-h-0 flex-1" data-companion-chat>
        {!agents ? (
          <Centered><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></Centered>
        ) : !agent ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Aucun collaborateur dans ce projet pour l'instant.
          </div>
        ) : (
          <ChatTab
            key={agent.id}
            agent={agent}
            workspaceId={workspaceId}
            projectId={projectId}
            compact
            conversationOrigin="companion"
            prepareMessage={prepareMessage}
            composerChips={chips}
            composerAbove={quickRow}
            emptyExtras={emptyExtras}
            sendRequest={sendRequest}
            onSendRequestHandled={() => setSendRequest(null)}
            onConversationChange={onConversationChange}
            onOpenInPanel={openInTab}
          />
        )}
      </div>
    </div>
  );
}

function AllCollaboratorsMenu({ agents, busy, onSelect }: {
  agents: InternalAgent[];
  busy?: Set<string>;
  onSelect: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const list = agents.filter((a) => !q || `${a.name} ${a.role ?? ""} ${a.description ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <DropdownMenu onOpenChange={(o) => { if (!o) setQ(""); }}>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground" title="Tous les collaborateurs" aria-label="Tous les collaborateurs">
          <ChevronDown className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 rounded-2xl p-1.5">
        <div className="flex items-center gap-2 px-2 pb-1.5 pt-1">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Chercher un collaborateur"
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
        <DropdownMenuSeparator />
        <div className="max-h-80 overflow-y-auto">
          {list.map((a) => (
            <DropdownMenuItem key={a.id} onClick={() => onSelect(a.id)} className="gap-2.5 rounded-xl">
              <AgentIdentity style={a.avatar_style} url={a.avatar_url} seed={a.name} size={24} accentColor={a.accent_color} interactive={false} paused rounded="rounded-full" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{a.name}</span>
                <span className="block truncate text-[10.5px] text-muted-foreground">{a.role || a.description || "Collaborateur"}</span>
              </span>
              {busy?.has(a.id) && <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" title="Au travail" />}
            </DropdownMenuItem>
          ))}
          {!list.length && <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">Aucun résultat.</p>}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SettingsMenu({ bridge, attachPage, onAttachPage, appUrl }: {
  bridge: ReturnType<typeof useCompanionBridge>;
  attachPage: boolean;
  onAttachPage: (v: boolean) => void;
  appUrl: string;
}) {
  const navigate = useNavigate();
  const toggle = (label: string, on: boolean, set: (v: boolean) => void, hint: string) => (
    <DropdownMenuItem onSelect={(e) => { e.preventDefault(); set(!on); }} className="items-start gap-2.5 rounded-xl">
      <span className={cn("mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors", on ? "bg-primary" : "bg-foreground/15")}>
        <span className={cn("h-3 w-3 rounded-full bg-white transition-transform", on && "translate-x-3")} />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[10.5px] leading-snug text-muted-foreground">{hint}</span>
      </span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground" title="Réglages" aria-label="Réglages">
          <Gear className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 rounded-2xl p-1.5">
        {bridge.inPanel && (
          <>
            <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">Panneau</DropdownMenuLabel>
            {toggle("Joindre la page par défaut", attachPage, onAttachPage, "La page en cours part avec chaque message ; inchangée, elle n'est pas renvoyée.")}
            {toggle("Bulles panneau fermé", bridge.prefs.bubbles, (v) => { bridge.setPrefs((p) => ({ ...p, bubbles: v })); bridge.post({ type: "prefs", bubbles: v }); },
              "Une réponse ou une validation arrive dans une bulle sur la page.")}
            {toggle("Pastille sur la sélection", bridge.prefs.selectionPill, (v) => { bridge.setPrefs((p) => ({ ...p, selectionPill: v })); bridge.post({ type: "prefs", selectionPill: v }); },
              "Sélectionnez un passage pour le demander, l'expliquer ou le traduire.")}
            <DropdownMenuItem onClick={() => bridge.post({ type: "open_settings" })} className="rounded-xl text-xs">
              <Gear className="mr-2 h-3.5 w-3.5" /> Réglages de l'extension
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => navigate("/companion?pick=1")} className="rounded-xl text-xs">
          <Swap className="mr-2 h-3.5 w-3.5" /> Changer de projet
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => window.open(appUrl, "_blank", "noopener")} className="rounded-xl text-xs">
          <ExternalLink className="mr-2 h-3.5 w-3.5" /> Ouvrir Anduran
        </DropdownMenuItem>
        {bridge.version && (
          <p className="px-2 pb-1 pt-1.5 text-[10px] text-muted-foreground">Extension {bridge.version}</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
