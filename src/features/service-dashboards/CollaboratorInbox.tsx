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

const KIND_META: Record<InboxKind, { label: string; icon: PhosphorIcon; tone: string }> = {
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
const KIND_ORDER: InboxKind[] = ["approval", "question", "failed", "goal", "trust", "proposal", "deliverable"];

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
function approvalLabel(item: InboxItem): string {
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

export function CollaboratorInbox({ dashboardId }: { dashboardId: string }) {
  const { workspaceSlug, projectSlug } = useParams();
  const sbase = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { workspaceId, projectId } = useCurrentContext();
  const { data, isLoading, error } = useCollaboratorInbox(dashboardId);

  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [viewing, setViewing] = useState<ArtifactOpenTarget | null>(null);
  const answerRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const all = useMemo(() => {
    const rank = (k: InboxKind) => KIND_ORDER.indexOf(k);
    return [...(data ?? [])].sort((a, b) => rank(a.kind) - rank(b.kind) || b.since.localeCompare(a.since));
  }, [data]);
  const shown = filter === "all" ? all : all.filter((i) => i.kind === filter);
  const count = (k: InboxKind) => all.filter((i) => i.kind === k).length;
  const keyOf = (i: InboxItem) => `${i.kind}:${i.ref_id}`;

  useEffect(() => { setSelected((s) => Math.min(s, Math.max(0, shown.length - 1))); }, [shown.length]);

  const drop = (item: InboxItem) => {
    qc.setQueryData<InboxItem[]>(["sd_inbox", dashboardId], (old) =>
      (old ?? []).filter((x) => !(x.kind === item.kind && x.ref_id === item.ref_id)));
  };

  async function act(item: InboxItem, op: () => Promise<void>) {
    setBusy(keyOf(item));
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

  const decide = (item: InboxItem, decision: "approve" | "approve_all" | "reject") => act(item, async () => {
    const res = await callEdge<{ ok?: boolean; status?: string; detail?: string }>(
      "internal-agent-approve", { approval_id: item.ref_id, decision, source: "inbox" },
    );
    drop(item);
    if (decision === "reject") toast.info("Refusé", `${item.agent_name} en sera informé.`);
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

  function primary(item: InboxItem) {
    if (item.kind === "approval") void decide(item, "approve");
    else if (item.kind === "question") answerRefs.current.get(keyOf(item))?.focus();
    else if (item.kind === "proposal") void launch(item);
    else if (item.kind === "deliverable") openDeliverable(item);
    else if (item.kind === "trust") void trust(item);
    else if (item.kind === "goal") navigate(`${sbase}/agent-config/${item.agent_id}?t=automations`);
    else void retry(item);
  }
  function secondary(item: InboxItem) {
    if (item.kind === "approval") void decide(item, "reject");
    else if (item.kind === "proposal") void discard(item);
    else void act(item, () => dismiss(item));
  }

  // j / k / a / x — skipped while typing an answer.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || busy) return;
      const item = shown[selected];
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

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
          <TrayIcon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-14 font-medium">À valider</h2>
          <Tabs className="ml-3 hidden md:inline-flex" value={filter} onChange={(v) => { setFilter(v); setSelected(0); }} options={FILTERS} />
          <span className="ml-auto hidden text-11 text-muted-foreground lg:block">
            <kbd className="rounded border border-border px-1">j</kbd> <kbd className="rounded border border-border px-1">k</kbd> naviguer ·{" "}
            <kbd className="rounded border border-border px-1">a</kbd> valider · <kbd className="rounded border border-border px-1">x</kbd> refuser
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto max-w-3xl">
            {isLoading ? (
              <p className="py-10 text-center text-14 text-muted-foreground">Chargement…</p>
            ) : error ? (
              <p className="py-10 text-center text-13 text-destructive">
                Impossible de charger la boîte : {error instanceof Error ? error.message : "erreur inconnue"}
              </p>
            ) : !shown.length ? (
              <EmptyState
                illustration={<DoneIllustration className="w-full" />}
                title={filter === "all" ? "Rien ne vous attend" : "Rien dans cette catégorie"}
                hint="Quand un collaborateur aura besoin d'une autorisation, d'une réponse ou d'un regard sur ce qu'il a produit, ce sera ici."
              />
            ) : (
              <ul className="space-y-2.5">
                {shown.map((item, idx) => (
                  <InboxRow
                    key={keyOf(item)}
                    rowRef={(el) => { if (el) rowRefs.current.set(keyOf(item), el); else rowRefs.current.delete(keyOf(item)); }}
                    item={item}
                    sbase={sbase}
                    selected={idx === selected}
                    busy={busy === keyOf(item)}
                    disabled={busy !== null}
                    onSelect={() => setSelected(idx)}
                    onOpenAgent={() => navigate(`${sbase}/agent/${item.agent_id}`)}
                    onNavigate={(href) => navigate(href)}
                    answerRef={(el) => { if (el) answerRefs.current.set(keyOf(item), el); else answerRefs.current.delete(keyOf(item)); }}
                    onDecide={(d) => void decide(item, d)}
                    onAnswer={(t) => void answer(item, t)}
                    onLaunch={() => void launch(item)}
                    onDiscard={() => void discard(item)}
                    onRetry={() => void retry(item)}
                    onOpenDeliverable={() => openDeliverable(item)}
                    onTrust={() => void trust(item)}
                    onOpenGoal={() => navigate(`${sbase}/agent-config/${item.agent_id}?t=automations`)}
                    onDismiss={() => void act(item, () => dismiss(item))}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* A deliverable reads beside the list, so triage never loses its place. */}
      {viewing && (
        <aside className="hidden w-[min(560px,45%)] shrink-0 border-l border-border bg-card/40 lg:block">
          <ArtifactViewer key={viewing.id} target={viewing} onBack={() => setViewing(null)} dense />
        </aside>
      )}
    </div>
  );
}

interface RowProps {
  item: InboxItem;
  sbase: string;
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  onSelect: () => void;
  onOpenAgent: () => void;
  onNavigate: (href: string) => void;
  answerRef: (el: HTMLTextAreaElement | null) => void;
  onDecide: (d: "approve" | "approve_all" | "reject") => void;
  onAnswer: (text: string) => void;
  onLaunch: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onOpenDeliverable: () => void;
  onTrust: () => void;
  onOpenGoal: () => void;
  onDismiss: () => void;
}

function InboxRow({ rowRef, ...p }: RowProps & { rowRef: (el: HTMLLIElement | null) => void }) {
  const { item } = p;
  const kind = KIND_META[item.kind];
  const source = sourceOf(item, p.sbase);
  const [reply, setReply] = useState("");
  const [showDetail, setShowDetail] = useState(false);
  const options = Array.isArray(item.meta?.options) ? (item.meta!.options as unknown[]).map(String).slice(0, 6) : [];
  const brief = item.kind === "proposal" ? splitBrief(item.body) : null;
  const detail = item.kind === "approval" ? approvalDetail(item) : null;
  const proposer = item.kind === "proposal" && item.meta?.self === false && item.meta?.proposed_by_name
    ? String(item.meta.proposed_by_name) : null;

  const approved = Number(item.meta?.approved ?? 0);
  const title = item.kind === "approval" ? approvalLabel(item)
    : item.kind === "failed" ? `« ${item.title ?? "Mission"} » a échoué`
    : item.kind === "trust" ? `Laisser passer seul : ${actionLabel(item.meta?.tool, item.meta?.action)}`
    : item.kind === "goal" ? `Objectif en écart : ${item.title ?? ""}`
    : item.title ?? "";
  const body = item.kind === "approval" ? item.body
    : item.kind === "failed" ? (item.body ?? "").split("\n")[0]
    : item.kind === "proposal" ? brief!.text
    : item.kind === "deliverable" ? item.body
    : item.kind === "goal" ? goalBody(item)
    : item.kind === "trust"
      ? `Vous l'avez validé ${approved} fois sans jamais refuser. Jev continuera de noter le risque de chaque action : une action irréversible vous sera toujours demandée.`
    : null;

  return (
    <li
      ref={rowRef}
      onClick={p.onSelect}
      className={cn(
        "rounded-xl border bg-card p-3.5 transition-shadow",
        p.selected ? "border-primary/40 ring-2 ring-primary/15" : "border-border/70",
      )}
    >
      <div className="flex items-start gap-3">
        <button type="button" onClick={p.onOpenAgent} title={`Ouvrir ${item.agent_name}`} className="shrink-0">
          <AgentIdentity
            style={(item.agent_avatar_style as "avatar" | "orb" | null) ?? "orb"}
            url={item.agent_avatar_url} seed={item.agent_name} size={30}
            rounded="rounded-full" accentColor={item.agent_accent}
          />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-11">
            <span className="font-medium text-foreground">{item.agent_name}</span>
            <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium", kind.tone)}>
              <kind.icon weight="fill" className="h-3 w-3" /> {kind.label}
            </span>
            {proposer && <span className="text-muted-foreground">déléguée par {proposer}</span>}
            {source.href ? (
              <button type="button" onClick={() => p.onNavigate(source.href!)} className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline">
                {source.label} <ArrowSquareOutIcon className="h-3 w-3" />
              </button>
            ) : item.kind !== "proposal" && item.kind !== "deliverable" && item.kind !== "trust" && item.kind !== "goal" ? (
              <span className="text-muted-foreground">{source.label}</span>
            ) : null}
            <span className="ml-auto text-muted-foreground">{formatRelative(item.since)}</span>
          </div>

          <p className={cn("mt-1.5 text-13 font-medium leading-snug", item.kind === "question" && "whitespace-pre-line font-normal")}>
            {title}
          </p>

          {brief?.value && (
            <p className="mt-1 text-12 text-violet-700 dark:text-violet-400">Valeur attendue : {brief.value}</p>
          )}
          {body && (
            <p className="mt-1 line-clamp-3 whitespace-pre-line text-12 text-muted-foreground">
              {item.kind === "approval" ? `Motif : ${body}` : body}
            </p>
          )}

          {detail && (
            <div className="mt-1.5">
              <button
                type="button" onClick={(e) => { e.stopPropagation(); setShowDetail((v) => !v); }}
                className="inline-flex items-center gap-1 text-11 text-muted-foreground hover:text-foreground"
              >
                <CaretDownIcon className={cn("h-3 w-3 transition-transform", showDetail && "rotate-180")} />
                {showDetail ? "Masquer le détail" : "Voir le détail"}
              </button>
              {showDetail && (
                <pre className="mt-1.5 max-h-56 overflow-auto rounded-lg bg-muted/60 p-2.5 text-[11px] leading-relaxed">{detail}</pre>
              )}
            </div>
          )}

          {item.kind === "question" && (
            <div className="mt-2.5 space-y-2" onClick={(e) => e.stopPropagation()}>
              {options.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {options.map((o) => (
                    <button
                      key={o} type="button" disabled={p.disabled} onClick={() => p.onAnswer(o)}
                      className="rounded-full border border-border px-2.5 py-1 text-12 transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:opacity-50"
                    >
                      {o}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <textarea
                  ref={p.answerRef}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && reply.trim()) { e.preventDefault(); p.onAnswer(reply); }
                    if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
                  }}
                  rows={1}
                  placeholder={`Répondre à ${item.agent_name}…`}
                  className="min-h-[34px] flex-1 resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-13 focus:outline-none focus:ring-2 focus:ring-ring/20"
                />
                <Button size="sm" className="h-[34px]" disabled={p.disabled || !reply.trim()} onClick={() => p.onAnswer(reply)}>
                  {p.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PaperPlaneRightIcon className="h-3.5 w-3.5" />}
                </Button>
                <Button size="sm" variant="ghost" className="h-[34px] text-12" disabled={p.disabled} onClick={p.onDismiss} title="Retirer de ma boîte">
                  Ignorer
                </Button>
              </div>
            </div>
          )}

          {item.kind !== "question" && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              {item.kind === "approval" && (
                <>
                  <Button size="sm" className="h-7 text-12" disabled={p.disabled} onClick={() => p.onDecide("approve")}>
                    {p.busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckIcon className="mr-1 h-3.5 w-3.5" />} Autoriser
                  </Button>
                  {/* A grant covers the rest of ONE conversation: without one,
                      there is nothing for "everything of this kind" to cover. */}
                  {item.conversation_id && (
                    <Button size="sm" variant="outline" className="h-7 text-12" disabled={p.disabled} onClick={() => p.onDecide("approve_all")}>
                      Tout autoriser pour cette conversation
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-7 text-12" disabled={p.disabled} onClick={() => p.onDecide("reject")}>
                    <XIcon className="mr-1 h-3.5 w-3.5" /> Refuser
                  </Button>
                </>
              )}
              {item.kind === "proposal" && (
                <>
                  <Button size="sm" className="h-7 text-12" disabled={p.disabled} onClick={p.onLaunch}>
                    {p.busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RocketLaunchIcon className="mr-1 h-3.5 w-3.5" />} Lancer
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-12" disabled={p.disabled} onClick={p.onDiscard}>
                    Écarter
                  </Button>
                </>
              )}
              {item.kind === "deliverable" && (
                <>
                  <Button size="sm" variant="outline" className="h-7 text-12" onClick={p.onOpenDeliverable}>
                    <EyeIcon className="mr-1 h-3.5 w-3.5" /> Ouvrir
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-12" disabled={p.disabled} onClick={p.onDismiss}>
                    <CheckIcon className="mr-1 h-3.5 w-3.5" /> Marquer comme vu
                  </Button>
                </>
              )}
              {item.kind === "goal" && (
                <>
                  <Button size="sm" className="h-7 text-12" onClick={p.onOpenGoal}>
                    <TargetIcon className="mr-1 h-3.5 w-3.5" /> Voir l'objectif
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-12" onClick={p.onOpenAgent}>
                    Parler au collaborateur
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-12" disabled={p.disabled} onClick={p.onDismiss}>
                    Ignorer
                  </Button>
                </>
              )}
              {item.kind === "trust" && (
                <>
                  <Button size="sm" className="h-7 text-12" disabled={p.disabled} onClick={p.onTrust}>
                    {p.busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <SealCheckIcon className="mr-1 h-3.5 w-3.5" />} Accorder la confiance
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-12" disabled={p.disabled} onClick={p.onDismiss}>
                    Plus tard
                  </Button>
                </>
              )}
              {item.kind === "failed" && (
                <>
                  <Button size="sm" className="h-7 text-12" disabled={p.disabled} onClick={p.onRetry}>
                    {p.busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ArrowClockwiseIcon className="mr-1 h-3.5 w-3.5" />} Relancer
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-12" onClick={p.onOpenAgent}>
                    Voir le collaborateur
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-12" disabled={p.disabled} onClick={p.onDismiss}>
                    Ignorer
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
