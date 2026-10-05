import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CircleNotchIcon as Loader2,
  ClockIcon as Clock,
  WarningIcon as Warning,
  EyeIcon as Eye,
  UserIcon as UserIco,
  CheckIcon as Check,
  ArrowCounterClockwiseIcon as Reopen,
  PlusIcon as Plus,
  TrashIcon as Trash,
  TrayIcon as Tray,
  XIcon as X,
} from "@phosphor-icons/react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { useCategorical } from "@/features/crm/overview/vizPalette";
import { StatTile, compact } from "@/features/governance/aiops/StatTile";
import type { Agent } from "../AgentBuilder";
import {
  DEFAULT_SUPPORT_CONFIG, PRIORITY_META, STATUS_META, intentKey, normalizeSupportConfig,
  type IntentDef, type SupportConfig,
} from "./supportConfig";

// L'onglet « Demandes » d'un agent public — la face visible de ResolveAI.
//
//   queue    — la file : ce qui attend une personne, par priorité et échéance
//   insights — ce que les clients demandent, et ce que l'agent a pu traiter seul
//   setup    — les intentions, le routage, les délais et le message de relais
//
// Les demandes sont écrites par rag-chat, message après message ; cet écran les
// lit et les fait avancer. Le tri s'allume dans Gouvernance IA → Jugement
// rapide (usage « ResolveAI — tri des demandes ») : sans lui, la file reste vide.

export type SupportSubtab = "queue" | "insights" | "setup";

interface Ticket {
  id: string; conversation_id: string; source: string;
  intent: string; intent_label: string; intent_confidence: number | null;
  urgency: number; priority: string; route: string | null;
  needs_human: boolean; handoff_reason: string | null;
  status: string; sla_due_at: string | null; assignee: string | null;
  notes: Array<{ at: string; by: string; text: string }>;
  mode: "shadow" | "on"; first_message: string | null; last_message: string | null;
  turn_count: number; created_at: string; updated_at: string; closed_at: string | null;
}

const since30 = () => new Date(Date.now() - 30 * 86400_000).toISOString();

const when = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** « dans 3 h » / « en retard de 40 min » — l'échéance lue comme une personne la lit. */
function slaText(due: string | null, status: string): { text: string; late: boolean } | null {
  if (!due || (status !== "open" && status !== "in_progress")) return null;
  const ms = Date.parse(due) - Date.now();
  const abs = Math.abs(ms);
  const span = abs < 3600_000 ? `${Math.max(1, Math.round(abs / 60_000))} min`
    : abs < 48 * 3600_000 ? `${Math.round(abs / 3600_000)} h`
    : `${Math.round(abs / 86400_000)} j`;
  return ms >= 0 ? { text: `échéance dans ${span}`, late: false } : { text: `en retard de ${span}`, late: true };
}

export function SupportTab({ agent, sub }: { agent: Agent; sub: SupportSubtab }) {
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      {sub === "queue" && <QueuePage agent={agent} />}
      {sub === "insights" && <InsightsPage agent={agent} />}
      {sub === "setup" && <SetupPage agent={agent} />}
    </div>
  );
}

function useTickets(agentId: string, includeTests: boolean) {
  return useQuery({
    queryKey: ["resolve_tickets", agentId, includeTests],
    refetchInterval: 30_000,
    queryFn: async () => {
      let q = supabase.from("resolve_tickets").select("*")
        .eq("agent_id", agentId).gte("created_at", since30())
        .order("updated_at", { ascending: false }).limit(1000);
      if (!includeTests) q = q.eq("source", "widget");
      const { data } = await q;
      return (data ?? []) as Ticket[];
    },
  });
}

function EmptyNote() {
  return (
    <Card className="border-dashed">
      <CardContent className="flex items-start gap-3 p-5 text-[12.5px] leading-relaxed text-muted-foreground">
        <Tray className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Aucune demande sur 30 jours. Le tri s'active dans <strong className="text-foreground">Admin → Gouvernance IA → Jugement rapide</strong>,
          usage « ResolveAI, tri des demandes ». En <strong className="text-foreground">Observation</strong>, chaque message est classé et
          la file se remplit sans rien changer aux réponses de l'agent ; en <strong className="text-foreground">Actif</strong>, les demandes qui
          relèvent de l'équipe reçoivent une réponse prudente qui annonce le relais.
        </span>
      </CardContent>
    </Card>
  );
}

// ── La file ──────────────────────────────────────────────────────────────────

type QueueFilter = "todo" | "auto" | "closed" | "all";

function QueuePage({ agent }: { agent: Agent }) {
  const [filter, setFilter] = useState<QueueFilter>("todo");
  const [includeTests, setIncludeTests] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data: tickets, isLoading } = useTickets(agent.id, includeTests);

  const rows = useMemo(() => {
    const list = (tickets ?? []).filter((t) =>
      filter === "all" ? true
      : filter === "todo" ? t.status === "open" || t.status === "in_progress"
      : t.status === filter);
    // À traiter : la priorité d'abord, puis l'échéance la plus proche.
    if (filter === "todo") {
      list.sort((a, b) =>
        (PRIORITY_META[b.priority]?.rank ?? 0) - (PRIORITY_META[a.priority]?.rank ?? 0)
        || (a.sla_due_at ?? "9").localeCompare(b.sla_due_at ?? "9"));
    }
    return list;
  }, [tickets, filter]);

  const counts = useMemo(() => {
    const t = tickets ?? [];
    return {
      todo: t.filter((x) => x.status === "open" || x.status === "in_progress").length,
      auto: t.filter((x) => x.status === "auto").length,
      closed: t.filter((x) => x.status === "closed").length,
      all: t.length,
    };
  }, [tickets]);

  const selected = rows.find((t) => t.id === openId) ?? (tickets ?? []).find((t) => t.id === openId) ?? null;

  if (isLoading) return <Spinner />;
  if ((tickets ?? []).length === 0 && !includeTests) {
    return (
      <>
        <EmptyNote />
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <input type="checkbox" checked={includeTests} onChange={(e) => setIncludeTests(e.target.checked)} />
          Afficher les conversations de test (playground)
        </label>
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
          {([["todo", "À traiter"], ["auto", "Traitées par l'agent"], ["closed", "Closes"], ["all", "Toutes"]] as Array<[QueueFilter, string]>).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setFilter(k)}
              className={cn("rounded-md px-2.5 py-1.5 text-[11.5px] transition-colors",
                filter === k ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {label} <span className="text-muted-foreground">{counts[k]}</span>
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-[11.5px] text-muted-foreground">
          <input type="checkbox" checked={includeTests} onChange={(e) => setIncludeTests(e.target.checked)} />
          Inclure les tests du playground
        </label>
      </div>

      <div className={cn("grid gap-4", selected && "lg:grid-cols-[minmax(0,1fr)_420px]")}>
        <Card>
          <CardContent className="p-0">
            {rows.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
                {filter === "todo" ? "Rien n'attend l'équipe." : "Aucune demande dans cette vue."}
              </div>
            ) : (
              <div className="divide-y divide-border/40">
                {rows.slice(0, 200).map((t) => {
                  const sla = slaText(t.sla_due_at, t.status);
                  return (
                    <button key={t.id} type="button" onClick={() => setOpenId(t.id === openId ? null : t.id)}
                      className={cn("block w-full px-4 py-2.5 text-left text-[12px] transition-colors hover:bg-muted/40",
                        t.id === openId && "bg-muted/50")}>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <PriorityTag priority={t.priority} />
                        <span className="font-medium">{t.intent_label}</span>
                        {t.route && t.needs_human && <span className="text-muted-foreground">→ {t.route}</span>}
                        {t.mode === "shadow" && (
                          <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground"><Eye className="h-3 w-3" /> observation</span>
                        )}
                        {t.source !== "widget" && <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">test</span>}
                        <span className="ml-auto flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
                          {sla && (
                            <span className={cn("flex items-center gap-1", sla.late && "font-medium text-foreground")}>
                              {sla.late ? <Warning className="h-3 w-3 text-amber-600 dark:text-amber-400" weight="fill" /> : <Clock className="h-3 w-3" />}
                              {sla.text}
                            </span>
                          )}
                          <span>{STATUS_META[t.status]?.label ?? t.status}</span>
                          <span>{when(t.updated_at)}</span>
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-muted-foreground">{t.first_message}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {selected && <TicketPanel ticket={selected} onClose={() => setOpenId(null)} agentId={agent.id} />}
      </div>
    </div>
  );
}

/** La priorité : un libellé ET une marque de sévérité — jamais la couleur seule. */
function PriorityTag({ priority }: { priority: string }) {
  const meta = PRIORITY_META[priority] ?? { label: priority, rank: 1 };
  return (
    <span className="flex shrink-0 items-center gap-1 rounded border border-border/70 px-1.5 py-0.5 text-[10.5px] font-medium">
      <span className="flex gap-px" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className={cn("h-2.5 w-[3px] rounded-sm", i < meta.rank ? "bg-foreground/70" : "bg-foreground/15")} />
        ))}
      </span>
      {meta.label}
    </span>
  );
}

function TicketPanel({ ticket, onClose, agentId }: { ticket: Ticket; onClose: () => void; agentId: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const { data: transcript } = useQuery({
    queryKey: ["resolve_transcript", ticket.conversation_id],
    queryFn: async () => {
      const { data } = await supabase.from("rag_messages").select("role, content, created_at")
        .eq("conversation_id", ticket.conversation_id).order("created_at", { ascending: true }).limit(100);
      return (data ?? []) as Array<{ role: string; content: string; created_at: string }>;
    },
  });

  async function patch(p: Record<string, unknown>) {
    setSaving(true);
    try {
      const { error } = await supabase.from("resolve_tickets")
        .update({ ...p, updated_at: new Date().toISOString() }).eq("id", ticket.id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ["resolve_tickets", agentId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Mise à jour impossible");
    } finally {
      setSaving(false);
    }
  }

  const me = user?.email ?? "membre";
  const addNote = async () => {
    if (!note.trim()) return;
    await patch({ notes: [...(ticket.notes ?? []), { at: new Date().toISOString(), by: me, text: note.trim() }].slice(-50) });
    setNote("");
  };

  return (
    <Card className="self-start lg:sticky lg:top-4">
      <CardContent className="space-y-4 p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <PriorityTag priority={ticket.priority} />
              <span className="text-[14px] font-semibold">{ticket.intent_label}</span>
            </div>
            <div className="mt-1 text-[11.5px] text-muted-foreground">
              {STATUS_META[ticket.status]?.label ?? ticket.status}
              {ticket.route && ticket.needs_human && ` · service ${ticket.route}`}
              {ticket.assignee && ` · suivi par ${ticket.assignee}`}
              {` · ${ticket.turn_count} message${ticket.turn_count > 1 ? "s" : ""}`}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Fermer">
            <X className="h-4 w-4" />
          </button>
        </div>

        {ticket.handoff_reason && (
          <div className="rounded-md bg-muted/50 px-3 py-2 text-[11.5px]">
            <span className="font-medium">Confiée à l'équipe :</span> {ticket.handoff_reason}.
            {ticket.intent_confidence != null && (
              <span className="text-muted-foreground"> Intention reconnue à {Math.round(ticket.intent_confidence * 100)} %.</span>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {ticket.status !== "in_progress" && ticket.status !== "closed" && (
            <Button size="sm" className="h-8 gap-1.5" disabled={saving}
              onClick={() => patch({ status: "in_progress", assignee: me })}>
              <UserIco className="h-3.5 w-3.5" /> Prendre en charge
            </Button>
          )}
          {ticket.status !== "closed" ? (
            <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={saving}
              onClick={() => patch({ status: "closed", closed_at: new Date().toISOString() })}>
              <Check className="h-3.5 w-3.5" /> Clore
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={saving}
              onClick={() => patch({ status: "open", closed_at: null })}>
              <Reopen className="h-3.5 w-3.5" /> Rouvrir
            </Button>
          )}
          {saving && <Loader2 className="h-4 w-4 animate-spin self-center text-muted-foreground" />}
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">Conversation</div>
          <div className="max-h-[340px] space-y-2 overflow-y-auto pr-1">
            {(transcript ?? []).map((m, i) => (
              <div key={i} className={cn("rounded-lg px-3 py-2 text-[12px] leading-relaxed",
                m.role === "user" ? "bg-muted/60" : "border border-border/60")}>
                <div className="mb-0.5 text-[10.5px] text-muted-foreground">
                  {m.role === "user" ? "Client" : "Agent"} · {when(m.created_at)}
                </div>
                <div className="whitespace-pre-wrap break-words">{m.content}</div>
              </div>
            ))}
            {transcript && transcript.length === 0 && <div className="text-[12px] text-muted-foreground">Aucun message.</div>}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">Notes internes</div>
          <div className="space-y-1.5">
            {(ticket.notes ?? []).map((n, i) => (
              <div key={i} className="rounded-md bg-muted/40 px-2.5 py-1.5 text-[11.5px]">
                <div className="text-[10.5px] text-muted-foreground">{n.by} · {when(n.at)}</div>
                <div className="whitespace-pre-wrap">{n.text}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ce qui a été fait, ce qui reste…"
              className="h-8 text-[12px]" onKeyDown={(e) => { if (e.key === "Enter") void addNote(); }} />
            <Button size="sm" variant="outline" className="h-8" disabled={!note.trim() || saving} onClick={addNote}>Ajouter</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Tendances ────────────────────────────────────────────────────────────────

function InsightsPage({ agent }: { agent: Agent }) {
  const { data: tickets, isLoading } = useTickets(agent.id, false);
  const [agentColor, teamColor] = useCategorical();
  const [hover, setHover] = useState<string | null>(null);

  const stats = useMemo(() => {
    const t = tickets ?? [];
    const handed = t.filter((x) => x.needs_human);
    const now = Date.now();
    const breached = handed.filter((x) => x.sla_due_at && (
      x.closed_at ? x.closed_at > x.sla_due_at : x.status !== "closed" && Date.parse(x.sla_due_at) < now));
    const closeTimes = handed.filter((x) => x.closed_at).map((x) => Date.parse(x.closed_at!) - Date.parse(x.created_at)).sort((a, b) => a - b);
    const median = closeTimes.length ? closeTimes[Math.floor(closeTimes.length / 2)] : null;
    const byIntent = new Map<string, { label: string; agent: number; team: number }>();
    for (const x of t) {
      const r = byIntent.get(x.intent) ?? { label: x.intent_label, agent: 0, team: 0 };
      if (x.needs_human) r.team++; else r.agent++;
      byIntent.set(x.intent, r);
    }
    return {
      total: t.length,
      automation: t.length ? (t.length - handed.length) / t.length : null,
      handed: handed.length,
      open: t.filter((x) => x.status === "open").length,
      breached: breached.length,
      median,
      intents: [...byIntent.entries()].map(([key, v]) => ({ key, ...v, total: v.agent + v.team }))
        .sort((a, b) => b.total - a.total),
    };
  }, [tickets]);

  if (isLoading) return <Spinner />;
  if (stats.total === 0) return <EmptyNote />;

  const max = Math.max(...stats.intents.map((i) => i.total), 1);
  const fmtDuration = (ms: number) => ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : ms < 48 * 3600_000 ? `${Math.round(ms / 3600_000)} h` : `${Math.round(ms / 86400_000)} j`;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Demandes" value={compact(stats.total)} hint="30 derniers jours, hors tests" />
        <StatTile label="Traitées par l'agent" value={stats.automation == null ? "—" : `${Math.round(stats.automation * 100)} %`} hint="sans intervention de l'équipe" />
        <StatTile label="Confiées à l'équipe" value={compact(stats.handed)} hint="besoin d'une personne" />
        <StatTile label="En attente" value={compact(stats.open)} alert={stats.open > 0 ? "à prendre en charge" : null} hint="rien en attente" />
        <StatTile label="Échéances dépassées" value={compact(stats.breached)} alert={stats.breached > 0 ? "SLA non tenu" : null} hint="SLA tenus" />
        <StatTile label="Délai médian de clôture" value={stats.median == null ? "—" : fmtDuration(stats.median)} hint="demandes confiées à l'équipe" />
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="mb-1 text-[13px] font-medium">Ce que demandent vos clients</div>
          <div className="mb-4 flex flex-wrap items-center gap-4 text-[11.5px] text-muted-foreground">
            <span>Par intention, sur 30 jours</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: agentColor }} /> traitées par l'agent</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: teamColor }} /> confiées à l'équipe</span>
          </div>
          <div className="space-y-2.5">
            {stats.intents.map((i) => (
              <div key={i.key} className="relative grid grid-cols-[150px_minmax(0,1fr)_110px] items-center gap-3 text-[12px]"
                onMouseEnter={() => setHover(i.key)} onMouseLeave={() => setHover(null)}>
                <span className="truncate" title={i.label}>{i.label}</span>
                <div className="flex h-3.5 items-center">
                  {/* Deux segments séparés d'un espace de 2 px ; l'extrémité de
                      données est arrondie, la base reste droite sur l'axe. */}
                  {i.agent > 0 && (
                    <span className={cn("h-full", i.team === 0 ? "rounded-r" : "")}
                      style={{ width: `${(i.agent / max) * 100}%`, background: agentColor }} />
                  )}
                  {i.agent > 0 && i.team > 0 && <span className="h-full w-[2px] shrink-0" />}
                  {i.team > 0 && (
                    <span className="h-full rounded-r" style={{ width: `${(i.team / max) * 100}%`, background: teamColor }} />
                  )}
                </div>
                <span className="text-right text-muted-foreground tabular-nums">
                  {i.total} · {Math.round((i.agent / i.total) * 100)} % auto
                </span>
                {hover === i.key && (
                  <div className="pointer-events-none absolute left-[160px] top-5 z-10 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-md">
                    <div className="font-medium">{i.label}</div>
                    <div className="text-muted-foreground">{i.agent} traitée{i.agent > 1 ? "s" : ""} par l'agent · {i.team} confiée{i.team > 1 ? "s" : ""} à l'équipe</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* La même donnée en tableau : le graphique ne doit jamais être le seul accès au chiffre. */}
      <details className="rounded-lg border border-border/60 px-4 py-2 text-[12px]">
        <summary className="cursor-pointer text-muted-foreground">Voir en tableau</summary>
        <table className="mt-2 w-full">
          <thead>
            <tr className="text-left text-[11px] text-muted-foreground">
              <th className="py-1 font-normal">Intention</th>
              <th className="py-1 text-right font-normal">Total</th>
              <th className="py-1 text-right font-normal">Par l'agent</th>
              <th className="py-1 text-right font-normal">Par l'équipe</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {stats.intents.map((i) => (
              <tr key={i.key} className="border-t border-border/30">
                <td className="py-1">{i.label}</td>
                <td className="py-1 text-right">{i.total}</td>
                <td className="py-1 text-right">{i.agent}</td>
                <td className="py-1 text-right">{i.team}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

// ── Réglages ─────────────────────────────────────────────────────────────────

function SetupPage({ agent }: { agent: Agent }) {
  const qc = useQueryClient();
  const raw = (agent as Agent & { support_config?: unknown }).support_config;
  const [cfg, setCfg] = useState<SupportConfig>(() => normalizeSupportConfig(raw));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setCfg(normalizeSupportConfig(raw)); setDirty(false); }, [raw]);

  const update = (next: SupportConfig) => { setCfg(next); setDirty(true); };
  const setIntent = (idx: number, p: Partial<IntentDef>) =>
    update({ ...cfg, intents: cfg.intents.map((it, i) => (i === idx ? { ...it, ...p } : it)) });

  async function save() {
    // Deux intentions au minimum : le tri choisit ENTRE des options.
    if (cfg.intents.length < 2) { toast.error("Gardez au moins deux intentions."); return; }
    const keys = new Set<string>();
    const intents = cfg.intents.map((it) => {
      let key = it.key || intentKey(it.label);
      while (keys.has(key)) key = `${key}_2`;
      keys.add(key);
      return { ...it, key, examples: (it.examples ?? []).map((e) => e.trim()).filter(Boolean) };
    });
    setSaving(true);
    try {
      const { error } = await supabase.from("rag_agents").update({ support_config: { ...cfg, intents } }).eq("id", agent.id);
      if (error) throw error;
      toast.success("Réglages du tri enregistrés");
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["rag_agent", agent.id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Enregistrement impossible");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">
          Chaque message reçu est classé dans l'une de ces intentions. La <strong className="text-foreground">définition</strong> et
          le <strong className="text-foreground">« ce n'est pas »</strong> font la qualité du tri : c'est ce qui départage deux intentions voisines.
        </p>
        <Button variant="outline" size="sm" onClick={() => update(DEFAULT_SUPPORT_CONFIG)}>Valeurs par défaut</Button>
        <Button size="sm" disabled={!dirty || saving} onClick={save}>
          {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Enregistrer
        </Button>
      </div>

      <div className="space-y-3">
        {cfg.intents.map((it, idx) => (
          <Card key={idx}>
            <CardContent className="space-y-2.5 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Input value={it.label} onChange={(e) => setIntent(idx, { label: e.target.value })}
                  className="h-8 w-56 text-[13px] font-medium" placeholder="Nom de l'intention" />
                <label className="flex items-center gap-1.5 text-[12px]">
                  <input type="checkbox" checked={it.auto_reply} onChange={(e) => setIntent(idx, { auto_reply: e.target.checked })} />
                  L'agent peut traiter seul
                </label>
                <div className="ml-auto flex items-center gap-2 text-[12px] text-muted-foreground">
                  Service
                  <Input value={it.route ?? ""} onChange={(e) => setIntent(idx, { route: e.target.value })}
                    className="h-8 w-36 text-[12px]" placeholder="ex. Facturation" />
                  <button type="button" aria-label="Supprimer l'intention"
                    onClick={() => update({ ...cfg, intents: cfg.intents.filter((_, i) => i !== idx) })}
                    className="rounded p-1.5 hover:bg-muted"><Trash className="h-3.5 w-3.5" /></button>
                </div>
              </div>
              <div className="grid gap-2.5 md:grid-cols-2">
                <Field label="Définition, ce que couvre cette intention">
                  <Textarea rows={2} value={it.what} onChange={(e) => setIntent(idx, { what: e.target.value })} className="text-[12px]" />
                </Field>
                <Field label="Ce n'est pas, ce qui relève d'une intention voisine">
                  <Textarea rows={2} value={it.not_for ?? ""} onChange={(e) => setIntent(idx, { not_for: e.target.value })} className="text-[12px]" />
                </Field>
                <Field label="Exemples réels (un par ligne)">
                  <Textarea rows={3} value={(it.examples ?? []).join("\n")}
                    onChange={(e) => setIntent(idx, { examples: e.target.value.split("\n") })} className="text-[12px]" />
                </Field>
                <Field label="Consigne pour l'agent sur ce type de demande (facultatif)">
                  <Textarea rows={3} value={it.playbook ?? ""} onChange={(e) => setIntent(idx, { playbook: e.target.value })}
                    className="text-[12px]" placeholder="ex. Demander le numéro de commande avant toute autre chose." />
                </Field>
              </div>
            </CardContent>
          </Card>
        ))}
        <Button variant="outline" size="sm" className="gap-1.5"
          onClick={() => update({ ...cfg, intents: [...cfg.intents, { key: "", label: "Nouvelle intention", what: "", auto_reply: true }] })}>
          <Plus className="h-3.5 w-3.5" /> Ajouter une intention
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="text-[13px] font-medium">Délais de prise en charge (SLA)</div>
          <p className="text-[12px] text-muted-foreground">
            Le délai court à partir du moment où la demande est confiée à l'équipe. La priorité suit l'urgence jugée : information → basse,
            gêne → normale, bloquant → haute, critique → urgente.
          </p>
          <div className="flex flex-wrap gap-4">
            {(["urgent", "high", "normal", "low"] as const).map((p) => (
              <label key={p} className="flex items-center gap-2 text-[12px]">
                {PRIORITY_META[p].label}
                <Input type="number" min={1} value={cfg.sla_hours[p]}
                  onChange={(e) => update({ ...cfg, sla_hours: { ...cfg.sla_hours, [p]: Number(e.target.value) } })}
                  className="h-8 w-20 text-[12px]" /> h
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="text-[13px] font-medium">Message de relais</div>
          <p className="text-[12px] text-muted-foreground">Ce que l'agent dit au client quand une demande est confiée à l'équipe (il le traduit dans la langue du client).</p>
          <Textarea rows={2} value={cfg.handoff_message} onChange={(e) => update({ ...cfg, handoff_message: e.target.value })} className="text-[12px]" />
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Spinner() {
  return (
    <div className="flex h-40 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}
