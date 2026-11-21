import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  TrayIcon, ShieldCheckIcon, ChatCircleDotsIcon, LightbulbIcon, PackageIcon, WarningCircleIcon,
  CheckIcon, XIcon, PaperPlaneRightIcon, ArrowSquareOutIcon, ArrowClockwiseIcon, CaretDownIcon,
  RocketLaunchIcon, EyeIcon, SealCheckIcon, TargetIcon, CircleNotchIcon as Loader2,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { AgentIdentity } from "@/components/AgentIdentity";
import { useToast } from "@/components/ToastProvider";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { Tabs, EmptyState } from "@/features/tracker/ui";
import { DoneIllustration } from "@/features/tracker/illustrations";
import { formatRelative } from "@/features/tracker/pickers";
import { TRACKER_ACTION_LABEL } from "@/features/tracker/IssueMissions";
import { type ArtifactOpenTarget } from "@/features/internal-agents/UiBlocks";
import { ArtifactViewer } from "./RoomArtifacts";
import { postRoomMessage } from "./model";

/**
 * « À valider » : tout ce que les collaborateurs du service attendent d'un humain.
 *
 * Une autorisation, une question restée sans réponse, une mission qu'ils
 * proposent, un livrable produit sans personne devant, une mission planifiée en
 * échec. Ces moments existaient, mais dispersés dans les chats, les rooms et les
 * runs, et plusieurs n'arrivaient nulle part (0265). Ici, chaque ligne se traite
 * sur place : on autorise, on répond, on lance, on lit, on relance.
 *
 * Au clavier : j / k pour se déplacer, a pour l'action principale, x pour
 * refuser ou écarter.
 */

export type InboxKind = "approval" | "question" | "proposal" | "deliverable" | "failed" | "trust" | "goal";

export interface InboxItem {
  kind: InboxKind;
  ref_id: string;
  agent_id: string;
  agent_name: string;
  agent_avatar_url: string | null;
  agent_avatar_style: string | null;
  agent_accent: string | null;
  title: string | null;
  body: string | null;
  meta: Record<string, unknown> | null;
  conversation_id: string | null;
  run_id: string | null;
  mission_id: string | null;
  room_id: string | null;
  since: string;
}

/** Shared by the page and the navigation badge, so both read one fetch. */
export function useCollaboratorInbox(dashboardId: string | undefined) {
  return useQuery({
    queryKey: ["sd_inbox", dashboardId],
    enabled: !!dashboardId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("sd_collaborator_inbox", { p_dashboard: dashboardId });
      if (error) throw new Error(error.message);
      return (data ?? []) as InboxItem[];
    },
    // A request is born during a run; every 30 s is enough while the page is
    // open, and the badge keeps counting from the sidebar.
    refetchInterval: 30_000,
  });
}

export const KIND_META: Record<InboxKind, { label: string; icon: PhosphorIcon; tone: string }> = {
  approval: { label: "Autorisation", icon: ShieldCheckIcon, tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  question: { label: "Question", icon: ChatCircleDotsIcon, tone: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  proposal: { label: "Proposition", icon: LightbulbIcon, tone: "bg-violet-500/10 text-violet-700 dark:text-violet-400" },
  deliverable: { label: "Livrable", icon: PackageIcon, tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  failed: { label: "Échec", icon: WarningCircleIcon, tone: "bg-red-500/10 text-red-700 dark:text-red-400" },
  trust: { label: "Confiance", icon: SealCheckIcon, tone: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  goal: { label: "Objectif en écart", icon: TargetIcon, tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
};

// Urgency first: an approval blocks a live run, a question blocks the work, a
// failure will repeat; trust, proposals and deliverables can wait for a calm
// moment.
export const KIND_ORDER: InboxKind[] = ["approval", "question", "failed", "goal", "trust", "proposal", "deliverable"];

type Filter = "all" | InboxKind;

const words = (s: unknown) => String(s ?? "").replace(/[_.-]+/g, " ").trim().toLowerCase();
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * An action as PolicyGuard sees it (tool + action), in words: « Gmail : send
 * email », « CRM : update deal », « Créer un work item ». Shared by approvals,
 * earned trust and the decision log, so one action reads the same everywhere.
 */
export function actionLabel(tool: unknown, action: unknown): string {
  const t = String(tool ?? "");
  let a = String(action ?? "");
  if (t.toLowerCase() === "tracker") return capitalize(TRACKER_ACTION_LABEL[a] ?? words(a));
  if (t.toLowerCase() === "crm") return `CRM : ${words(a)}`;
  // Composio slugs repeat the toolkit (GMAIL_SEND_EMAIL for gmail).
  if (t && a.toUpperCase().startsWith(`${t.toUpperCase()}_`)) a = a.slice(t.length + 1);
  return t ? `${capitalize(words(t))} : ${words(a)}` : capitalize(words(a)) || "Une action";
}

/** The approved action, in words. Mirrors the summaries the runtime writes
 *  (internal-agent-tools awaitInlineApproval), which the row does not store. */
export function approvalLabel(item: InboxItem): string {
  const kind = String(item.meta?.action_kind ?? "");
  const p = (item.meta?.payload ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "composio_action": return actionLabel(p.toolkit, p.tool_slug);
    case "connector_action": return actionLabel(p.provider, p.action);
    case "crm_write": return actionLabel("crm", p.action);
    case "tracker_write": return actionLabel("tracker", p.action);
    case "edge_function": return capitalize(words(p.slug));
    case "custom_connector": return `${actionLabel(p.connector_name, p.operation)}${p.risk === "destructive" ? " (irréversible)" : ""}`;
    default: return capitalize(words(item.title)) || "Une action";
  }
}

/** An objective off target, in one sentence (the gap is computed by the measure tool, 0269). */
function goalBody(item: InboxItem): string {
  const m = item.meta ?? {};
  const unit = m.unit ? ` ${m.unit}` : "";
  const dir = m.direction === "decrease" ? "au plus" : m.direction === "maintain" ? "autour de" : "au moins";
  const head = `${m.metric ?? "Valeur"} : ${m.current ?? "?"}${unit} pour une cible ${dir} ${m.target ?? "?"}${unit}.`;
  const tail = m.watched ? " Le collaborateur veille dessus et agit dans les limites de son autonomie." : " Aucune veille : activez-la pour qu'il agisse seul.";
  return `${head}${item.body ? ` ${item.body}` : ""}${tail}`;
}

/** What the collaborator would send, for the "détail" fold. */
function approvalDetail(item: InboxItem): string | null {
  const p = (item.meta?.payload ?? {}) as Record<string, unknown>;
  const shown = p.params ?? p.args ?? p;
  try {
    const s = JSON.stringify(shown, null, 2);
    return s && s !== "{}" ? s : null;
  } catch {
    return null;
  }
}

/** A proposal's brief carries a footer written by the runtime; its value line
 *  deserves to be read first, the rest is the brief proper. */
function splitBrief(brief: string | null): { text: string; value: string | null } {
  const raw = brief ?? "";
  const i = raw.lastIndexOf("\n---\n");
  const text = (i >= 0 ? raw.slice(0, i) : raw).trim();
  const footer = i >= 0 ? raw.slice(i + 5) : "";
  const m = footer.match(/Valeur attendue\s*:\s*([\s\S]+)$/);
  return { text, value: m ? m[1].trim() : null };
}

function sourceOf(item: InboxItem, sbase: string): { label: string; href?: string } {
  const via = String(item.meta?.triggered_via ?? "");
  if (item.room_id) return { label: "Dans une room", href: `${sbase}/room/${item.room_id}` };
  if (item.conversation_id) return { label: "Dans une conversation", href: `${sbase}/agent/${item.agent_id}?c=${item.conversation_id}` };
  if (via === "schedule") return { label: "Mission planifiée" };
  if (item.mission_id) return { label: "Pendant une mission" };
  if (via === "manual") return { label: "Workflow ou procédure" };
  return { label: "Hors conversation" };
}

export const inboxKey = (i: InboxItem) => `${i.kind}:${i.ref_id}`;

/**
 * Everything one can do on an inbox item, shared by the « À valider » page and
 * the home cockpit, so an item is handled the same way wherever it is opened.
 */
export function useInboxActions(dashboardId: string) {
  const { workspaceSlug, projectSlug } = useParams();
  const sbase = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { workspaceId, projectId } = useCurrentContext();

  const [busy, setBusy] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ArtifactOpenTarget | null>(null);
  const answerRefs = useRef(new Map<string, HTMLTextAreaElement>());

  const drop = (item: InboxItem) => {
    qc.setQueryData<InboxItem[]>(["sd_inbox", dashboardId], (old) =>
      (old ?? []).filter((x) => !(x.kind === item.kind && x.ref_id === item.ref_id)));
  };

  async function act(item: InboxItem, op: () => Promise<void>) {
    setBusy(inboxKey(item));
    try {
      await op();
    } catch (e) {
      toast.error("Action impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ["sd_inbox", dashboardId] });
    }
  }

  async function dismiss(item: InboxItem) {
    if (!user) return;
    const { error: err } = await supabase.from("sd_inbox_dismissals")
      .upsert({ user_id: user.id, kind: item.kind, ref_id: item.ref_id }, { onConflict: "user_id,kind,ref_id", ignoreDuplicates: true });
    if (err) throw new Error(err.message);
    drop(item);
  }

  const decide = (item: InboxItem, decision: "approve" | "approve_all" | "reject", note?: string) => act(item, async () => {
    const res = await callEdge<{ ok?: boolean; status?: string; detail?: string }>(
      "internal-agent-approve", {
        approval_id: item.ref_id, decision, source: "inbox",
        // Refus avec consigne : l'agent la reçoit comme résultat de l'action refusée.
        ...(decision === "reject" && note?.trim() ? { note: note.trim() } : {}),
      },
    );
    drop(item);
    if (decision === "reject") toast.info("Refusé", note?.trim() ? `${item.agent_name} reçoit ta consigne.` : `${item.agent_name} en sera informé.`);
    else if (res?.ok === false) toast.error("Autorisé, mais l'exécution a échoué", res.detail?.slice(0, 200));
    else toast.success("Autorisé et exécuté");
  });

  const answer = (item: InboxItem, text: string) => act(item, async () => {
    const reply = text.trim();
    if (!reply || !user || !workspaceId || !projectId) return;
    if (item.room_id) {
      // The room resumes with a new turn; mentioning the collaborator makes it
      // the one who answers.
      await postRoomMessage(item.room_id, reply, [item.agent_id]);
    } else if (item.conversation_id) {
      const { error: err } = await supabase.from("internal_agent_messages").insert({
        conversation_id: item.conversation_id, agent_id: item.agent_id, role: "user", content: reply,
      });
      if (err) throw new Error(err.message);
      await callEdge("internal-agent-run", { agent_id: item.agent_id, mode: "chat", conversation_id: item.conversation_id });
    } else {
      // Asked during a workflow or a mission: there is no thread to answer in.
      // Open one, seeded with the question, so the answer has its context.
      const { data: convo, error: cErr } = await supabase.from("internal_agent_conversations").insert({
        agent_id: item.agent_id, workspace_id: workspaceId, project_id: projectId, user_id: user.id,
        title: `Réponse : ${(item.title ?? "").slice(0, 50)}`,
      }).select("id").single();
      if (cErr || !convo) throw new Error(cErr?.message ?? "Conversation impossible à créer");
      const where = sourceOf(item, sbase).label.toLowerCase();
      const { error: mErr } = await supabase.from("internal_agent_messages").insert([
        { conversation_id: convo.id, agent_id: item.agent_id, role: "assistant", run_id: item.run_id,
          content: `(Question posée ${where === "hors conversation" ? "hors conversation" : `pendant : ${where}`})\n\n${item.title ?? ""}` },
        { conversation_id: convo.id, agent_id: item.agent_id, role: "user", content: reply },
      ]);
      if (mErr) throw new Error(mErr.message);
      await callEdge("internal-agent-run", { agent_id: item.agent_id, mode: "chat", conversation_id: convo.id });
      // The original run stays « question posée » for ever: hide it here.
      await dismiss(item);
    }
    drop(item);
    toast.success(`Réponse envoyée à ${item.agent_name}`);
  });

  async function startRun(agentId: string, missionId: string) {
    const { data: run, error: err } = await supabase.from("internal_agent_runs").insert({
      mission_id: missionId, agent_id: agentId, workspace_id: workspaceId, project_id: projectId,
      status: "queued", triggered_by: user?.id ?? null,
    }).select("id").single();
    if (err || !run) throw new Error(err?.message ?? "Exécution impossible à créer");
    // Fire and forget: the scheduler picks the run up if this call fails.
    try { await callEdge("internal-agent-run", { agent_id: agentId, mode: "mission", run_id: run.id }); } catch { /* rescued */ }
  }

  const launch = (item: InboxItem) => act(item, async () => {
    if (!item.mission_id) return;
    const { error: err } = await supabase.from("internal_agent_missions")
      .update({ status: "active", board_column: "todo", updated_at: new Date().toISOString() })
      .eq("id", item.mission_id);
    if (err) throw new Error(err.message);
    await startRun(item.agent_id, item.mission_id);
    drop(item);
    toast.success("Mission lancée", `${item.agent_name} s'y met.`);
  });

  const discard = (item: InboxItem) => act(item, async () => {
    if (!item.mission_id) return;
    const { error: err } = await supabase.from("internal_agent_missions")
      .update({ status: "archived", updated_at: new Date().toISOString() })
      .eq("id", item.mission_id);
    if (err) throw new Error(err.message);
    drop(item);
  });

  const retry = (item: InboxItem) => act(item, async () => {
    if (!item.mission_id) return;
    await startRun(item.agent_id, item.mission_id);
    await dismiss(item);
    toast.success("Mission relancée");
  });

  const openDeliverable = (item: InboxItem) => setViewing({
    id: item.ref_id, table: "deliverable", kind: String(item.meta?.kind ?? "document"),
    title: item.title ?? "Livrable", agentId: item.agent_id,
  });

  // Earned trust: from now on PolicyGuard lets this action type through for
  // this collaborator, under the team's ceiling, when Jev has judged its risk.
  const trust = (item: InboxItem) => act(item, async () => {
    const m = item.meta ?? {};
    const { error: err } = await supabase.from("agent_trust_grants").insert({
      agent_id: item.agent_id, scope: String(m.scope ?? item.title ?? ""),
      tool: String(m.tool ?? ""), action: String(m.action ?? ""), approvals_seen: Number(m.approved ?? 0),
    });
    if (err) throw new Error(err.message);
    drop(item);
    qc.invalidateQueries({ queryKey: ["agent_trust_grants", item.agent_id] });
    toast.success("Confiance accordée", `${item.agent_name} : ${actionLabel(m.tool, m.action)}`);
  });

  const ignore = (item: InboxItem) => act(item, () => dismiss(item));

  return {
    sbase, busy, viewing, setViewing, answerRefs,
    decide, answer, launch, discard, retry, openDeliverable, trust, ignore,
  };
}

export type InboxActions = ReturnType<typeof useInboxActions>;

/** The right-hand drawer, shared with the home page. */
export const SIDE_PANEL_CLASS = "absolute inset-y-0 right-0 z-20 flex w-full max-w-[480px] flex-col border-l border-border bg-background shadow-xl animate-in slide-in-from-right duration-200 xl:static xl:shadow-none";

/**
 * The right-hand panel: one item in full, with its actions, or the deliverable
 * it opened. It slides over the page on narrow screens and sits beside it from
 * xl up, so triage never loses its place.
 */
export function InboxSidePanel({ actions, item, onClose }: {
  actions: InboxActions;
  item: InboxItem | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { viewing, setViewing, busy, sbase, answerRefs } = actions;
  if (!viewing && !item) return null;
  return (
    <aside className={cn(SIDE_PANEL_CLASS, viewing && "max-w-[560px]")}>
      {viewing ? (
        <ArtifactViewer key={viewing.id} target={viewing} onBack={() => setViewing(null)} dense />
      ) : item ? (
        <InboxDetail
          key={inboxKey(item)}
          item={item}
          sbase={sbase}
          busy={busy === inboxKey(item)}
          disabled={busy !== null}
          onClose={onClose}
          onOpenAgent={() => navigate(`${sbase}/agent/${item.agent_id}`)}
          onNavigate={(href) => navigate(href)}
          answerRef={(el) => { if (el) answerRefs.current.set(inboxKey(item), el); else answerRefs.current.delete(inboxKey(item)); }}
          onDecide={(d, note) => void actions.decide(item, d, note)}
          onAnswer={(t) => void actions.answer(item, t)}
          onLaunch={() => void actions.launch(item)}
          onDiscard={() => void actions.discard(item)}
          onRetry={() => void actions.retry(item)}
          onOpenDeliverable={() => actions.openDeliverable(item)}
          onTrust={() => void actions.trust(item)}
          onOpenGoal={() => navigate(`${sbase}/agent-config/${item.agent_id}?t=automations`)}
          onDismiss={() => void actions.ignore(item)}
        />
      ) : null}
    </aside>
  );
}

export function CollaboratorInbox({ dashboardId }: { dashboardId: string }) {
  const navigate = useNavigate();
  const { data, isLoading, error } = useCollaboratorInbox(dashboardId);
  const actions = useInboxActions(dashboardId);
  const { sbase, busy, viewing, setViewing, answerRefs } = actions;

  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState(0);
  // The card shown in the right panel, by key (it closes when the item leaves).
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const all = useMemo(() => {
    const rank = (k: InboxKind) => KIND_ORDER.indexOf(k);
    return [...(data ?? [])].sort((a, b) => rank(a.kind) - rank(b.kind) || b.since.localeCompare(a.since));
  }, [data]);
  const shown = filter === "all" ? all : all.filter((i) => i.kind === filter);
  const count = (k: InboxKind) => all.filter((i) => i.kind === k).length;
  const keyOf = inboxKey;

  useEffect(() => { setSelected((s) => Math.min(s, Math.max(0, shown.length - 1))); }, [shown.length]);

  function primary(item: InboxItem) {
    if (item.kind === "approval") void actions.decide(item, "approve");
    else if (item.kind === "question") {
      // The answer box lives in the panel: open it, then focus once rendered.
      setViewing(null);
      setOpenKey(keyOf(item));
      requestAnimationFrame(() => answerRefs.current.get(keyOf(item))?.focus());
    }
    else if (item.kind === "proposal") void actions.launch(item);
    else if (item.kind === "deliverable") actions.openDeliverable(item);
    else if (item.kind === "trust") void actions.trust(item);
    else if (item.kind === "goal") navigate(`${sbase}/agent-config/${item.agent_id}?t=automations`);
    else void actions.retry(item);
  }
  function secondary(item: InboxItem) {
    if (item.kind === "approval") void actions.decide(item, "reject");
    else if (item.kind === "proposal") void actions.discard(item);
    else void actions.ignore(item);
  }

  // j / k / a / x — skipped while typing an answer.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || busy) return;
      const item = shown[selected];
      if (e.key === "Escape" && (openKey || viewing)) { e.preventDefault(); setOpenKey(null); setViewing(null); return; }
      if (e.key === "Enter" && item && t?.tagName !== "BUTTON") { e.preventDefault(); setViewing(null); setOpenKey(keyOf(item)); return; }
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, shown.length - 1)); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
      else if (e.key === "a" && item) { e.preventDefault(); primary(item); }
      else if (e.key === "x" && item) { e.preventDefault(); secondary(item); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    const item = shown[selected];
    if (item) rowRefs.current.get(keyOf(item))?.scrollIntoView({ block: "nearest" });
    // With the panel open, j / k walk through the details too.
    if (item && openKey) setOpenKey(keyOf(item));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const FILTERS: { key: Filter; label: string; count?: number }[] = [
    { key: "all", label: "Tout", count: all.length },
    { key: "approval", label: "Autorisations", count: count("approval") },
    { key: "question", label: "Questions", count: count("question") },
    { key: "failed", label: "Échecs", count: count("failed") },
    { key: "goal", label: "Objectifs", count: count("goal") },
    { key: "proposal", label: "Propositions", count: count("proposal") },
    { key: "deliverable", label: "Livrables", count: count("deliverable") },
    { key: "trust", label: "Confiance", count: count("trust") },
  ];

  const opened = openKey ? all.find((i) => keyOf(i) === openKey) ?? null : null;

  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-header shrink-0 items-center gap-2 px-3">
          <TrayIcon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-14 font-medium">À valider</h2>
          <Tabs className="ml-3 hidden md:inline-flex" value={filter} onChange={(v) => { setFilter(v); setSelected(0); }} options={FILTERS} />
          <span className="ml-auto hidden text-11 text-muted-foreground lg:block">
            <kbd className="rounded border border-border px-1">j</kbd> <kbd className="rounded border border-border px-1">k</kbd> naviguer ·{" "}
            <kbd className="rounded border border-border px-1">↵</kbd> ouvrir ·{" "}
            <kbd className="rounded border border-border px-1">a</kbd> valider · <kbd className="rounded border border-border px-1">x</kbd> refuser
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {isLoading ? (
            <p className="py-10 text-center text-14 text-muted-foreground">Chargement…</p>
          ) : error ? (
            <p className="py-10 text-center text-13 text-destructive">
              Impossible de charger la boîte : {error instanceof Error ? error.message : "erreur inconnue"}
            </p>
          ) : !shown.length ? (
            <div className="mx-auto max-w-3xl">
              <EmptyState
                illustration={<DoneIllustration className="w-full" />}
                title={filter === "all" ? "Rien ne vous attend" : "Rien dans cette catégorie"}
                hint="Quand un collaborateur aura besoin d'une autorisation, d'une réponse ou d'un regard sur ce qu'il a produit, ce sera ici."
              />
            </div>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2">
              {shown.map((item, idx) => (
                <InboxCard
                  key={keyOf(item)}
                  rowRef={(el) => { if (el) rowRefs.current.set(keyOf(item), el); else rowRefs.current.delete(keyOf(item)); }}
                  item={item}
                  sbase={sbase}
                  selected={idx === selected}
                  open={openKey === keyOf(item)}
                  onOpen={() => { setSelected(idx); setViewing(null); setOpenKey(keyOf(item)); }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <InboxSidePanel actions={actions} item={opened} onClose={() => setOpenKey(null)} />
    </div>
  );
}

/** Title and body of an item, as both the card and the panel show them. */
function describe(item: InboxItem) {
  const brief = item.kind === "proposal" ? splitBrief(item.body) : null;
  const approved = Number(item.meta?.approved ?? 0);
  const title = item.kind === "approval" ? approvalLabel(item)
    : item.kind === "failed" ? `« ${item.title ?? "Mission"} » a échoué`
    : item.kind === "trust" ? `Laisser passer seul : ${actionLabel(item.meta?.tool, item.meta?.action)}`
    : item.kind === "goal" ? `Objectif en écart : ${item.title ?? ""}`
    : item.title ?? "";
  const body = item.kind === "approval" ? (item.body ? `Motif : ${item.body}` : null)
    : item.kind === "failed" ? item.body ?? ""
    : item.kind === "proposal" ? brief!.text
    : item.kind === "deliverable" ? item.body
    : item.kind === "goal" ? goalBody(item)
    : item.kind === "trust"
      ? `Vous l'avez validé ${approved} fois sans jamais refuser. Jev continuera de noter le risque de chaque action : une action irréversible vous sera toujours demandée.`
    : null;
  return { title, body, value: brief?.value ?? null };
}

function KindBadge({ kind }: { kind: InboxKind }) {
  const k = KIND_META[kind];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-11 font-medium", k.tone)}>
      <k.icon weight="fill" className="h-3 w-3" /> {k.label}
    </span>
  );
}

export function InboxCard({ rowRef, item, sbase, selected = false, open, onOpen }: {
  rowRef?: (el: HTMLLIElement | null) => void;
  item: InboxItem;
  sbase: string;
  selected?: boolean;
  open: boolean;
  onOpen: () => void;
}) {
  const { title, body } = describe(item);
  const source = sourceOf(item, sbase);
  return (
    <li ref={rowRef}>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex h-full w-full flex-col rounded-md border bg-card p-3 text-left transition-colors hover:border-foreground/20",
          open ? "border-primary/60" : selected ? "border-foreground/25" : "border-border/70",
        )}
      >
        <div className="flex w-full items-center gap-2">
          <AgentIdentity
            style={(item.agent_avatar_style as "avatar" | "orb" | null) ?? "orb"}
            url={item.agent_avatar_url} seed={item.agent_name} size={20}
            rounded="rounded-full"
          />
          <span className="min-w-0 truncate text-12 font-medium">{item.agent_name}</span>
          <span className="ml-auto shrink-0 text-11 text-muted-foreground">{formatRelative(item.since)}</span>
        </div>
        <p className="mt-2 line-clamp-2 text-13 font-medium leading-snug">{title}</p>
        {body && <p className="mt-1 line-clamp-2 text-12 text-muted-foreground">{body.split("\n")[0]}</p>}
        <div className="mt-auto flex w-full items-center gap-2 pt-3">
          <KindBadge kind={item.kind} />
          <span className="min-w-0 truncate text-11 text-muted-foreground">{source.label}</span>
        </div>
      </button>
    </li>
  );
}

interface DetailProps {
  item: InboxItem;
  sbase: string;
  busy: boolean;
  disabled: boolean;
  onClose: () => void;
  onOpenAgent: () => void;
  onNavigate: (href: string) => void;
  answerRef: (el: HTMLTextAreaElement | null) => void;
  onDecide: (d: "approve" | "approve_all" | "reject", note?: string) => void;
  onAnswer: (text: string) => void;
  onLaunch: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onOpenDeliverable: () => void;
  onTrust: () => void;
  onOpenGoal: () => void;
  onDismiss: () => void;
}

function InboxDetail(p: DetailProps) {
  const { item } = p;
  const source = sourceOf(item, p.sbase);
  const [reply, setReply] = useState("");
  const options = Array.isArray(item.meta?.options) ? (item.meta!.options as unknown[]).map(String).slice(0, 6) : [];
  const { title, body, value } = describe(item);
  const detail = item.kind === "approval" ? approvalDetail(item) : null;
  const proposer = item.kind === "proposal" && item.meta?.self === false && item.meta?.proposed_by_name
    ? String(item.meta.proposed_by_name) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
        <KindBadge kind={item.kind} />
        <span className="text-11 text-muted-foreground">{formatRelative(item.since)}</span>
        <button
          type="button" onClick={p.onClose} title="Fermer (Échap)"
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <button type="button" onClick={p.onOpenAgent} className="flex items-center gap-2.5 text-left" title={`Ouvrir ${item.agent_name}`}>
          <AgentIdentity
            style={(item.agent_avatar_style as "avatar" | "orb" | null) ?? "orb"}
            url={item.agent_avatar_url} seed={item.agent_name} size={32}
            rounded="rounded-full"
          />
          <span className="min-w-0">
            <span className="block text-13 font-medium">{item.agent_name}</span>
            <span className="block text-11 text-muted-foreground">
              {proposer ? `Déléguée par ${proposer}` : source.label}
            </span>
          </span>
        </button>

        <h3 className={cn("mt-4 text-15 font-medium leading-snug", item.kind === "question" && "whitespace-pre-line")}>{title}</h3>

        {value && <p className="mt-2 text-12 text-violet-700 dark:text-violet-400">Valeur attendue : {value}</p>}
        {body && <p className="mt-2 whitespace-pre-line break-words text-13 leading-relaxed text-muted-foreground">{body}</p>}

        {source.href && (
          <button type="button" onClick={() => p.onNavigate(source.href!)} className="mt-3 inline-flex items-center gap-1 text-12 text-muted-foreground hover:text-foreground hover:underline">
            {source.label} <ArrowSquareOutIcon className="h-3 w-3" />
          </button>
        )}

        {detail && (
          <div className="mt-4">
            <p className="mb-1.5 text-11 font-medium uppercase tracking-wide text-muted-foreground">Détail de l'action</p>
            <pre className="max-h-80 overflow-auto rounded-md bg-muted/60 p-2.5 text-[11px] leading-relaxed">{detail}</pre>
          </div>
        )}

        {item.kind === "question" && (
          <div className="mt-4 space-y-2">
            {options.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {options.map((o) => (
                  <button
                    key={o} type="button" disabled={p.disabled} onClick={() => p.onAnswer(o)}
                    className="rounded-md border border-border px-2.5 py-1 text-12 transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:opacity-50"
                  >
                    {o}
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={p.answerRef}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && reply.trim()) { e.preventDefault(); p.onAnswer(reply); }
                if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
              }}
              rows={3}
              placeholder={`Répondre à ${item.agent_name}…`}
              className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-13 focus:outline-none focus:ring-2 focus:ring-ring/20"
            />
          </div>
        )}
      </div>

      {item.kind === "approval" && (
        <div className="shrink-0 px-4 pb-2">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur(); }}
            rows={2}
            maxLength={2000}
            placeholder={`Consigne pour ${item.agent_name} si tu refuses (facultatif) : quoi faire à la place`}
            className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-13 focus:outline-none focus:ring-2 focus:ring-ring/20"
          />
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-4 py-3">
        {item.kind === "question" && (
          <>
            <Button size="sm" className="h-8 text-12" disabled={p.disabled || !reply.trim()} onClick={() => p.onAnswer(reply)}>
              {p.busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <PaperPlaneRightIcon className="mr-1 h-3.5 w-3.5" />} Répondre
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-12" disabled={p.disabled} onClick={p.onDismiss}>Ignorer</Button>
          </>
        )}
        {item.kind === "approval" && (
          <>
            <Button size="sm" className="h-8 text-12" disabled={p.disabled} onClick={() => p.onDecide("approve")}>
              {p.busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckIcon className="mr-1 h-3.5 w-3.5" />} Autoriser
            </Button>
            {/* A grant covers the rest of ONE conversation: without one,
                there is nothing for "everything of this kind" to cover. */}
            {item.conversation_id && (
              <Button size="sm" variant="outline" className="h-8 text-12" disabled={p.disabled} onClick={() => p.onDecide("approve_all")}>
                Tout autoriser pour cette conversation
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-8 text-12" disabled={p.disabled} onClick={() => p.onDecide("reject", reply)}>
              <XIcon className="mr-1 h-3.5 w-3.5" /> {reply.trim() ? "Refuser avec la consigne" : "Refuser"}
            </Button>
          </>
        )}
        {item.kind === "proposal" && (
          <>
            <Button size="sm" className="h-8 text-12" disabled={p.disabled} onClick={p.onLaunch}>
              {p.busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RocketLaunchIcon className="mr-1 h-3.5 w-3.5" />} Lancer
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-12" disabled={p.disabled} onClick={p.onDiscard}>Écarter</Button>
          </>
        )}
        {item.kind === "deliverable" && (
          <>
            <Button size="sm" className="h-8 text-12" onClick={p.onOpenDeliverable}>
              <EyeIcon className="mr-1 h-3.5 w-3.5" /> Ouvrir
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-12" disabled={p.disabled} onClick={p.onDismiss}>
              <CheckIcon className="mr-1 h-3.5 w-3.5" /> Marquer comme vu
            </Button>
          </>
        )}
        {item.kind === "goal" && (
          <>
            <Button size="sm" className="h-8 text-12" onClick={p.onOpenGoal}>
              <TargetIcon className="mr-1 h-3.5 w-3.5" /> Voir l'objectif
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-12" onClick={p.onOpenAgent}>Parler au collaborateur</Button>
            <Button size="sm" variant="ghost" className="h-8 text-12" disabled={p.disabled} onClick={p.onDismiss}>Ignorer</Button>
          </>
        )}
        {item.kind === "trust" && (
          <>
            <Button size="sm" className="h-8 text-12" disabled={p.disabled} onClick={p.onTrust}>
              {p.busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <SealCheckIcon className="mr-1 h-3.5 w-3.5" />} Accorder la confiance
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-12" disabled={p.disabled} onClick={p.onDismiss}>Plus tard</Button>
          </>
        )}
        {item.kind === "failed" && (
          <>
            <Button size="sm" className="h-8 text-12" disabled={p.disabled} onClick={p.onRetry}>
              {p.busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ArrowClockwiseIcon className="mr-1 h-3.5 w-3.5" />} Relancer
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-12" onClick={p.onOpenAgent}>Voir le collaborateur</Button>
            <Button size="sm" variant="ghost" className="h-8 text-12" disabled={p.disabled} onClick={p.onDismiss}>Ignorer</Button>
          </>
        )}
      </div>
    </div>
  );
}
