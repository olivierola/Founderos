import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChatCircleDotsIcon } from "@phosphor-icons/react";
import {
  CircleNotchIcon as Loader2,
  RobotIcon as Bot,
  XIcon as X,
  PlusIcon as Plus,
  ClockCounterClockwiseIcon as History,
  CaretDownIcon as ChevronDown,
  FileTextIcon as FileText,
  ChartBarIcon as BarChart3,
  ArrowRightIcon as ArrowRight,
  SparkleIcon as Sparkles,
  UsersThreeIcon as Team,
} from "@phosphor-icons/react";
import { AgentMarkdown } from "@/components/AgentMarkdown";
import { InlineUiProvider } from "@/features/internal-agents/UiBlocks";
import { ChatComposer } from "@/components/ui/chat-composer";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { ASSISTANT_MAX_W, ASSISTANT_MIN_W, ASSISTANT_NAV_SLOT_ID, useAssistant } from "@/lib/assistant-context";
import { capturePageSnapshot, snapshotToText } from "@/lib/page-snapshot";
import { DocumentCanvas } from "./DocumentCanvas";
import { MessageArtifacts, type AiArtifact } from "./Artifacts";
import { AgentSetupDeck } from "./AgentSetupDeck";

const MIN_W = ASSISTANT_MIN_W;
const MAX_W = ASSISTANT_MAX_W;


// Quick-start actions shown on the empty state as actionable cards.
const QUICK_ACTIONS = [
  { icon: Sparkles, title: "Explique cette page", subtitle: "Ce que je regarde, en clair", prompt: "Explique cette page" },
  { icon: BarChart3, title: "Résume les chiffres clés", subtitle: "Les métriques à l'écran", prompt: "Résume les chiffres clés à l'écran" },
  { icon: FileText, title: "Que dois-je faire ensuite ?", subtitle: "Prochaines actions recommandées", prompt: "Que dois-je faire ensuite ?" },
  // Teamz (0298) : une équipe entière d'une phrase — conçue, montrée, déployée.
  { icon: Team, title: "Crée-moi une équipe d'agents", subtitle: "En une phrase", prompt: "Crée-moi une équipe d'agents qui gère notre support client de bout en bout : tri, réponses sourcées, escalade technique et documentation." },
] as const;

interface AiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: { provider?: string; model?: string };
  created_at: string;
}

interface Convo { id: string; title: string | null; updated_at: string }

/**
 * L'assistant de l'app.
 *
 *  · « docked » (tableaux de service, AI Workforce) : il PARTAGE la zone de
 *    contenu, comme le panneau de réglages d'un agent — le contenu se divise,
 *    rien ne flotte par-dessus. Son en-tête (conversation, historique,
 *    fermeture) monte dans la barre du haut, au-dessus de lui, quand la page
 *    en a une (ASSISTANT_NAV_SLOT_ID) ; sinon il reste en tête du panneau.
 *  · « floating » : l'ancienne fenêtre pleine hauteur, gardée pour les pages
 *    sans rangée où se loger.
 */
export function AssistantPanel({ variant = "floating" }: { variant?: "floating" | "docked" }) {
  const { open, setOpen, request, clearRequest, agent, setAgent, width, setWidth } = useAssistant();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const docked = variant === "docked";

  // Resizable width (persisted in the context), dragged from the left edge.
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      setWidth(Math.min(MAX_W, Math.max(MIN_W, startW + (startX - ev.clientX))));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width, setWidth]);

  // La place de l'en-tête dans la barre du haut, quand elle existe.
  const [navSlot, setNavSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!docked || !open) { setNavSlot(null); return; }
    // Masquée (écran étroit), la place ne compte pas : l'en-tête reste en tête
    // du panneau, qui repasse alors au-dessus de la page.
    const find = () => {
      const el = document.getElementById(ASSISTANT_NAV_SLOT_ID);
      setNavSlot(el && el.offsetParent !== null ? el : null);
    };
    find();
    window.addEventListener("resize", find);
    return () => window.removeEventListener("resize", find);
  }, [docked, open]);

  const [convoId, setConvoId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docMarkdown, setDocMarkdown] = useState<string | null>(null);
  const [docTitle, setDocTitle] = useState<string | undefined>(undefined);

  const { data: conversations } = useQuery({
    queryKey: ["assistant_convos", projectId],
    enabled: open && !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_conversations")
        .select("id, title, updated_at")
        .eq("project_id", projectId!)
        .order("updated_at", { ascending: false })
        .limit(30);
      return (data ?? []) as Convo[];
    },
  });

  const { data: messages } = useQuery({
    queryKey: ["ai_messages", convoId],
    enabled: !!convoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_messages").select("*")
        .eq("conversation_id", convoId!)
        .order("created_at", { ascending: true });
      return (data ?? []) as AiMessage[];
    },
  });

  const { data: artifacts } = useQuery({
    queryKey: ["ai_artifacts", convoId],
    enabled: !!convoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_artifacts")
        .select("id, message_id, kind, title, content, data, language, created_at")
        .eq("conversation_id", convoId!)
        .order("created_at", { ascending: true });
      return (data ?? []) as AiArtifact[];
    },
  });

  const artifactsByMessage = useMemo(() => {
    const map: Record<string, AiArtifact[]> = {};
    for (const a of artifacts ?? []) (map[a.message_id] ??= []).push(a);
    return map;
  }, [artifacts]);

  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages?.length, sending]);

  async function handleSend(text?: string, opts?: { freshChat?: boolean; model?: string }) {
    const content = (text ?? input).trim();
    if (!content || !workspaceId || !projectId || sending) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setSending(true);
    setError(null);
    setInput("");
    try {
      // Capture what the user is looking at right now as primary context.
      const snapshot = snapshotToText(capturePageSnapshot());
      const res = await callEdge<{
        conversation_id: string;
        assistant_message?: { metadata?: { tool_calls?: string[] } };
      }>("ai-agent-chat", {
        workspace_id: workspaceId,
        project_id: projectId,
        // A hand-off ("configure this agent") opens its own thread, so it never
        // lands in the middle of an unrelated conversation.
        conversation_id: opts?.freshChat ? null : convoId,
        message: content,
        page_context: snapshot,
        ...(opts?.model ? { model: opts.model } : {}),
      }, controller.signal);
      if (!convoId || opts?.freshChat) setConvoId(res.conversation_id);
      await queryClient.invalidateQueries({ queryKey: ["assistant_convos", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["ai_messages", res.conversation_id] });
      await queryClient.invalidateQueries({ queryKey: ["ai_artifacts", res.conversation_id] });
      // When the assistant actually reconfigured an agent, refresh the setup
      // cards and the page behind them, so what's shown is what was written.
      const called = res.assistant_message?.metadata?.tool_calls ?? [];
      // The assistant now BUILDS workflows, into the very canvas that may be
      // open behind this panel. Refresh it on the spot rather than leaving the
      // user in front of a page that shows none of what was just written.
      if (called.some((t) => t.startsWith("workflow_"))) {
        await queryClient.invalidateQueries({ queryKey: ["workflow"] });
        await queryClient.invalidateQueries({ queryKey: ["workflows"] });
      }
      const AGENT_WRITES = ["configure_agent_tool", "add_agent_tool", "update_agent_profile", "set_agent_skills"];
      if (called.some((t) => AGENT_WRITES.includes(t))) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["assistant_agent_setup"] }),
          queryClient.invalidateQueries({ queryKey: ["agent_tools_setup"] }),
          queryClient.invalidateQueries({ queryKey: ["internal_agent_tools"] }),
          queryClient.invalidateQueries({ queryKey: ["internal_agent"] }),
          queryClient.invalidateQueries({ queryKey: ["agent_skill_activations"] }),
        ]);
      }
    } catch (e) {
      // An aborted request is the user pressing stop, not a failure.
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  }

  /** Stop the turn in flight. The server-side call may still finish (an edge
   *  function can't be recalled); we stop waiting on it and reload the thread,
   *  so whatever it did persist still shows up. */
  function stopSending() {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    if (convoId) {
      queryClient.invalidateQueries({ queryKey: ["ai_messages", convoId] });
      queryClient.invalidateQueries({ queryKey: ["ai_artifacts", convoId] });
    }
  }

  // A page can hand a prompt over to the assistant (agent configuration, "explain
  // this"…). We wait for the workspace/project context to resolve before firing,
  // otherwise the send is dropped on a cold page load.
  useEffect(() => {
    if (!request) return;
    if (!request.autoSend) {
      if (request.newChat) setConvoId(null);
      setInput(request.prompt);
      clearRequest();
      return;
    }
    if (!workspaceId || !projectId || sending) return;
    clearRequest();
    void handleSend(request.prompt, { freshChat: request.newChat });
    // `sending` is a dep so a hand-off arriving mid-send fires once the current
    // exchange finishes instead of being dropped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, workspaceId, projectId, sending]);

  // Escape closes the floating panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const isEmpty = !convoId || !messages || messages.length === 0;
  const currentConvo = conversations?.find((c) => c.id === convoId);

  // L'en-tête : qui parle, quelle conversation, une nouvelle, fermer. Ancré, il
  // monte dans la barre du haut et en prend le rythme (h-8, onglets).
  const inNav = docked && !!navSlot;
  const header = (
    <div className={cn("flex items-center gap-1.5", inNav ? "h-full w-full" : "h-12 border-b border-border px-3")}>
      <span className={cn("flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium", inNav && "bg-muted/80")}>
        <ChatCircleDotsIcon weight="fill" className="h-4 w-4 text-[hsl(var(--primary-soft))]" />
        Assistant
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex h-8 min-w-0 max-w-[220px] items-center gap-1 rounded-lg px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
            <History className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{currentConvo?.title ?? "Nouvelle conversation"}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 rounded-xl p-1.5">
          <DropdownMenuItem className="rounded-lg" onClick={() => { setConvoId(null); setError(null); }}>
            <Plus className="mr-2 h-3.5 w-3.5" /> Nouvelle conversation
          </DropdownMenuItem>
          {(conversations ?? []).map((c) => (
            <DropdownMenuItem key={c.id} className="rounded-lg" onClick={() => setConvoId(c.id)}>
              <span className="truncate">{c.title || "Sans titre"}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex-1" />
      <button
        type="button" title="Nouvelle conversation" aria-label="Nouvelle conversation"
        onClick={() => { setConvoId(null); setError(null); }}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
      >
        <Plus className="h-4 w-4" />
      </button>
      <button
        type="button" title="Fermer l'assistant" aria-label="Fermer l'assistant"
        onClick={() => setOpen(false)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  return (
    <aside
      className={docked
        // Ancré : une surface de plus dans la rangée, comme le panneau de
        // droite — le contenu se divise au lieu d'être recouvert. Sous `lg`,
        // faute de place, il repasse au-dessus de la page.
        ? "relative flex shrink-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-background text-foreground duration-200 animate-in fade-in max-lg:fixed max-lg:inset-2 max-lg:z-50 max-lg:!w-auto max-lg:shadow-2xl"
        : "fixed inset-y-2 right-2 z-50 flex max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl shadow-black/40 duration-200 animate-in slide-in-from-right-6 fade-in"}
      style={{ width }}
      role={docked ? "complementary" : "dialog"}
      aria-label="Assistant IA"
    >
      {/* Resize handle (left edge). */}
      <div
        onMouseDown={startResize}
        className="absolute left-0 top-0 z-20 h-full w-1.5 cursor-col-resize transition-colors hover:bg-primary/30"
        title="Glisser pour redimensionner"
      />
      {inNav ? createPortal(header, navSlot!) : header}

      {/* Messages */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-3">
        {/* Configuring an agent: its setup areas as cards, each handing that one
            step to the assistant. Stays above the thread so the user can move to
            the next card once a step is done. */}
        {agent && (
          <AgentSetupDeck
            agentId={agent.id}
            busy={sending}
            onConfigure={(prompt) => handleSend(prompt)}
            onDismiss={() => setAgent(null)}
          />
        )}
        {isEmpty && agent ? (
          <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">
            Choisissez une carte à configurer, ou demandez-moi directement ce que vous voulez changer.
          </p>
        ) : isEmpty ? (
          <div className="flex h-full flex-col justify-end gap-1 px-1 pb-4">
            <p className="px-2 text-[15px] font-medium text-foreground">Que puis-je faire pour vous ?</p>
            <p className="mb-3 px-2 text-[12.5px] text-muted-foreground">
              Je vois la page ouverte : je l'explique, je l'analyse, ou j'agis dessus.
            </p>
            <div className="grid w-full gap-0.5 text-left">
              {QUICK_ACTIONS.map((a) => (
                <button
                  key={a.prompt}
                  onClick={() => handleSend(a.prompt)}
                  disabled={sending}
                  className="group flex items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60 disabled:opacity-50"
                >
                  <a.icon className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-foreground">{a.title}</span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">{a.subtitle}</span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3 py-3">
            {messages!.map((m, i) => (
              <Bubble
                key={m.id}
                m={m}
                artifacts={artifactsByMessage[m.id] ?? []}
                onOpenDoc={(md, title) => { setDocTitle(title); setDocMarkdown(md); }}
                // Les choix cliquables (bloc ```ui options) ne valent que pour
                // la dernière réponse.
                onPick={(t) => void handleSend(t)}
                optionsDisabled={sending || i !== messages!.length - 1}
              />
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
              </div>
            )}
          </div>
        )}
      </div>

      {/* Composer — no top separator, blends into the dark panel. */}
      <div className="px-3 py-2.5">
        <ChatComposer
          value={input}
          onValueChange={setInput}
          onSubmit={({ message, model }) => handleSend(message, { model })}
          loading={sending}
          running={sending}
          onStop={sending ? stopSending : undefined}
          placeholder="Demandez ou décrivez une tâche…"
        />
        {error && <p className="mt-1.5 text-center text-[11px] text-destructive">{error}</p>}
      </div>

      <DocumentCanvas
        open={docMarkdown !== null}
        onOpenChange={(o) => { if (!o) { setDocMarkdown(null); setDocTitle(undefined); } }}
        initialMarkdown={docMarkdown ?? ""}
        title={docTitle}
      />
    </aside>
  );
}

// A friendly gradient robot avatar shown on the empty state.
function AssistantAvatar() {
  return (
    <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 shadow-lg shadow-violet-500/30">
      <Bot className="h-7 w-7 text-white" />
      <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-400 ring-2 ring-background">
        <span className="h-1.5 w-1.5 rounded-full bg-white" />
      </span>
    </div>
  );
}

function Bubble({
  m, artifacts, onOpenDoc, onPick, optionsDisabled,
}: {
  m: AiMessage;
  artifacts: AiArtifact[];
  onOpenDoc: (md: string, title?: string) => void;
  onPick?: (text: string) => void;
  optionsDisabled?: boolean;
}) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] whitespace-pre-wrap rounded-2xl bg-primary/15 px-3 py-2 text-sm leading-relaxed text-foreground">{m.content}</div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-500 text-white">
        <Bot className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {/* Le rendu partagé des agents : tableaux triables, code, blocs ```ui
            (indicateurs, graphiques, choix cliquables). */}
        <InlineUiProvider onPick={onPick} optionsDisabled={optionsDisabled}>
          <div className="chat-prose break-words">
            <AgentMarkdown content={m.content ?? ""} />
          </div>
        </InlineUiProvider>
        {artifacts.length > 0 && <MessageArtifacts artifacts={artifacts} onOpenDocument={onOpenDoc} />}
      </div>
    </div>
  );
}
