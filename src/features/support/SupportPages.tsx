import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LifeBuoy, Loader2, Plus, Search, BookOpen, MessageSquare, ArrowLeft, Send,
  Sparkles, Clock, AlertTriangle, Star, StickyNote, Zap, Smile, BarChart3,
  ChevronDown, UserCircle2, Trash2,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from "recharts";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import {
  type Ticket, type TicketMessage, type Macro, type Article, type MemberRow,
  STATUS_META, PRIORITY_META, computeSla, slaState, relativeDate,
  loadWorkspaceMembers, memberLabel, callSupportAi, callSupportResolve, applyRouting,
} from "./shared";

function useTickets() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["support_tickets", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("support_tickets").select("*").eq("project_id", projectId!)
        .order("last_activity_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
      return (data ?? []) as Ticket[];
    },
  });
}
function useMembers() {
  const { workspaceId } = useCurrentContext();
  return useQuery({
    queryKey: ["support_members", workspaceId],
    enabled: !!workspaceId,
    queryFn: () => loadWorkspaceMembers(workspaceId!),
  });
}

// =================================================================== OVERVIEW
export function SupportOverviewPage() {
  const { data: tickets } = useTickets();
  const stats = useMemo(() => {
    const t = tickets ?? [];
    const open = t.filter((x) => !["solved", "closed"].includes(x.status));
    const breached = open.filter((x) => slaState(x)?.breached).length;
    const csats = t.map((x) => x.csat).filter((v): v is number => v != null);
    const avgCsat = csats.length ? csats.reduce((s, v) => s + v, 0) / csats.length : null;
    return {
      open: open.length,
      pending: t.filter((x) => x.status === "pending").length,
      breached,
      avgCsat,
      unassigned: open.filter((x) => !x.assignee_id).length,
    };
  }, [tickets]);
  return (
    <div className="space-y-6">
      <PageHeader title="Support — Overview" description="Queue health, SLA and satisfaction." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Open tickets" value={String(stats.open)} icon={LifeBuoy} hint={`${stats.unassigned} unassigned`} />
        <MetricCard label="SLA breached" value={String(stats.breached)} icon={AlertTriangle} hint="Open & overdue" />
        <MetricCard label="Pending" value={String(stats.pending)} icon={MessageSquare} />
        <MetricCard label="Avg CSAT" value={stats.avgCsat != null ? `${stats.avgCsat.toFixed(1)} / 5` : "—"} icon={Smile} />
      </div>
    </div>
  );
}

// ==================================================================== TICKETS
const STATUS_FILTERS = ["all", "open", "pending", "on_hold", "solved", "closed"] as const;

export function SupportTicketsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: tickets, isLoading } = useTickets();
  const { data: members } = useMembers();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("open");
  const [mineOnly, setMineOnly] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Ticket | null>(null);

  const memberById = useMemo(() => {
    const m: Record<string, MemberRow> = {}; (members ?? []).forEach((x) => (m[x.user_id] = x)); return m;
  }, [members]);

  const filtered = useMemo(() => {
    let list = tickets ?? [];
    if (statusFilter !== "all") list = list.filter((t) => t.status === statusFilter);
    if (mineOnly && user) list = list.filter((t) => t.assignee_id === user.id);
    if (search.trim()) { const q = search.toLowerCase(); list = list.filter((t) => t.subject.toLowerCase().includes(q) || (t.requester_email ?? "").toLowerCase().includes(q)); }
    return list;
  }, [tickets, statusFilter, mineOnly, search, user]);

  if (selected) {
    const fresh = (tickets ?? []).find((t) => t.id === selected.id) ?? selected;
    return <TicketDetail ticket={fresh} members={members ?? []} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Tickets" description="Your support queue with SLA tracking." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New ticket</Button>} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tickets…" className="h-9 pl-8" />
        </div>
        <div className="flex gap-1">
          {STATUS_FILTERS.map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={cn("rounded-md px-2.5 py-1.5 text-xs capitalize transition-colors",
                statusFilter === s ? "bg-foreground/10 font-medium text-foreground" : "text-muted-foreground hover:bg-foreground/5")}>
              {s.replace("_", " ")}
            </button>
          ))}
        </div>
        <Button size="sm" variant={mineOnly ? "default" : "outline"} onClick={() => setMineOnly((v) => !v)}>
          <UserCircle2 className="h-3.5 w-3.5" /> Mine
        </Button>
      </div>

      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (tickets ?? []).length === 0 ? <EmptyState icon={LifeBuoy} title="No tickets" description="Open a ticket to start." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New ticket</Button>} />
        : filtered.length === 0 ? <EmptyState icon={Search} title="No matches" description="No tickets match these filters." />
        : (
          <Card><CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Subject</th><th className="px-3 py-2">Requester</th>
                  <th className="px-3 py-2">SLA</th><th className="px-3 py-2">Assignee</th>
                  <th className="px-3 py-2">Status</th><th className="px-3 py-2">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((t) => {
                  const sla = slaState(t);
                  return (
                    <tr key={t.id} className="cursor-pointer hover:bg-muted/30" onClick={() => setSelected(t)}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className={cn("h-2 w-2 shrink-0 rounded-full", PRIORITY_META[t.priority].dot)} title={t.priority} />
                          <span className="truncate font-medium">{t.subject}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{t.requester_email || "—"}</td>
                      <td className="px-3 py-2">
                        {sla ? (
                          <span className={cn("inline-flex items-center gap-1 text-xs", sla.breached ? "text-destructive" : sla.soon ? "text-amber-600" : "text-muted-foreground")}>
                            <Clock className="h-3 w-3" /> {sla.label}
                          </span>
                        ) : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{t.assignee_id ? memberLabel(memberById[t.assignee_id], t.assignee_id) : "Unassigned"}</td>
                      <td className="px-3 py-2"><span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", STATUS_META[t.status].cls)}>{STATUS_META[t.status].label}</span></td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{relativeDate(t.last_activity_at ?? t.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent></Card>
        )}

      <TicketDialog open={open} onOpenChange={setOpen} onCreate={async (d) => {
        if (!workspaceId || !projectId) return;
        const sla = computeSla(d.priority ?? "normal");
        const { data: row } = await supabase.from("support_tickets")
          .insert({ ...d, ...sla, workspace_id: workspaceId, project_id: projectId, last_activity_at: new Date().toISOString() })
          .select("id").single();
        // Apply routing rules (assign team / priority) to the new ticket.
        if (row?.id) { try { await applyRouting(workspaceId, projectId, row.id); } catch { /* routing optional */ } }
        queryClient.invalidateQueries({ queryKey: ["support_tickets", projectId] });
        setOpen(false);
      }} />
    </div>
  );
}

// --------------------------------------------------------- ticket detail
function TicketDetail({ ticket, members, onBack }: { ticket: Ticket; members: MemberRow[]; onBack: () => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiPanel, setAiPanel] = useState<{ kind: string; text: string } | null>(null);
  const [resolveResult, setResolveResult] = useState<{ decision: "resolve" | "escalate"; confidence: number; reply: string; reason?: string } | null>(null);
  const [draftViaAi, setDraftViaAi] = useState(false);

  const { data: messages } = useQuery({
    queryKey: ["support_messages", ticket.id],
    queryFn: async () => {
      const { data } = await supabase.from("support_messages").select("*").eq("ticket_id", ticket.id).order("created_at", { ascending: true });
      return (data ?? []) as TicketMessage[];
    },
  });
  const { data: macros } = useQuery({
    queryKey: ["support_macros", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("support_macros").select("*").eq("project_id", projectId!).order("title");
      return (data ?? []) as Macro[];
    },
  });

  function refreshTicket() { queryClient.invalidateQueries({ queryKey: ["support_tickets", projectId] }); }

  async function send() {
    if (!reply.trim() || !workspaceId || !projectId) return;
    await supabase.from("support_messages").insert({
      ticket_id: ticket.id, workspace_id: workspaceId, project_id: projectId,
      author: "agent", body: reply, is_internal: internal, via_ai: draftViaAi, created_by: user?.id ?? null,
    });
    const patch: Record<string, unknown> = { last_activity_at: new Date().toISOString() };
    if (!internal && !ticket.first_response_at) patch.first_response_at = new Date().toISOString();
    if (!internal && ticket.status === "open") patch.status = "pending";
    await supabase.from("support_tickets").update(patch).eq("id", ticket.id);
    setReply(""); setInternal(false); setDraftViaAi(false);
    queryClient.invalidateQueries({ queryKey: ["support_messages", ticket.id] });
    refreshTicket();
  }

  async function changeStatus(s: Ticket["status"]) {
    await supabase.from("support_tickets").update({ status: s, solved_at: s === "solved" ? new Date().toISOString() : null, last_activity_at: new Date().toISOString() }).eq("id", ticket.id);
    refreshTicket();
  }
  async function assign(uid: string | null) {
    await supabase.from("support_tickets").update({ assignee_id: uid, last_activity_at: new Date().toISOString() }).eq("id", ticket.id);
    refreshTicket();
  }
  async function setCsat(score: number) {
    await supabase.from("support_tickets").update({ csat: score }).eq("id", ticket.id);
    refreshTicket();
  }

  async function runAi(kind: "suggest_reply" | "summarize" | "sentiment") {
    if (!workspaceId || !projectId) return;
    setAiBusy(kind);
    try {
      const text = await callSupportAi(workspaceId, projectId, ticket.id, kind);
      if (kind === "suggest_reply") { setReply(text); setDraftViaAi(true); }
      else setAiPanel({ kind, text });
    } catch (e) {
      setAiPanel({ kind, text: e instanceof Error ? e.message : "AI error" });
    } finally { setAiBusy(null); }
  }

  // Autonomous resolution: the AI decides resolve vs escalate (HITL — the draft
  // is staged in the editor; nothing is sent automatically).
  async function runResolve() {
    if (!workspaceId || !projectId) return;
    setAiBusy("resolve"); setResolveResult(null);
    try {
      const r = await callSupportResolve(workspaceId, projectId, ticket.id);
      setResolveResult(r);
      if (r.reply) { setReply(r.reply); setDraftViaAi(true); }
    } catch (e) {
      setResolveResult({ decision: "escalate", confidence: 0, reply: "", reason: e instanceof Error ? e.message : "AI error" });
    } finally { setAiBusy(null); }
  }

  const sla = slaState(ticket);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft className="mr-1 h-3.5 w-3.5" /> Tickets</Button>
          <span className={cn("h-2 w-2 rounded-full", PRIORITY_META[ticket.priority].dot)} />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{ticket.subject}</h2>
          {sla && <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]", sla.breached ? "bg-destructive/15 text-destructive" : sla.soon ? "bg-amber-500/15 text-amber-600" : "bg-muted text-muted-foreground")}><Clock className="h-3 w-3" /> {sla.label}</span>}
        </div>

        {/* AI toolbar */}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={runResolve} disabled={!!aiBusy}>
            {aiBusy === "resolve" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} AI Resolve
          </Button>
          <Button size="sm" variant="outline" onClick={() => runAi("suggest_reply")} disabled={!!aiBusy}>
            {aiBusy === "suggest_reply" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Suggest reply
          </Button>
          <Button size="sm" variant="outline" onClick={() => runAi("summarize")} disabled={!!aiBusy}>
            {aiBusy === "summarize" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <StickyNote className="h-3.5 w-3.5" />} Summarize
          </Button>
          <Button size="sm" variant="outline" onClick={() => runAi("sentiment")} disabled={!!aiBusy}>
            {aiBusy === "sentiment" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Smile className="h-3.5 w-3.5" />} Sentiment
          </Button>
        </div>
        {aiPanel && (
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="p-3 text-sm">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-primary"><Sparkles className="h-3.5 w-3.5" /> AI {aiPanel.kind}</div>
              <p className="whitespace-pre-wrap text-foreground/90">{aiPanel.text}</p>
              <button onClick={() => setAiPanel(null)} className="mt-1 text-[11px] text-muted-foreground hover:text-foreground">Dismiss</button>
            </CardContent>
          </Card>
        )}
        {resolveResult && (
          <Card className={cn("border", resolveResult.decision === "resolve" ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5")}>
            <CardContent className="p-3 text-sm">
              <div className="mb-1 flex items-center gap-2 text-xs font-medium">
                {resolveResult.decision === "resolve"
                  ? <span className="flex items-center gap-1 text-emerald-600"><Sparkles className="h-3.5 w-3.5" /> AI can resolve</span>
                  : <span className="flex items-center gap-1 text-amber-600"><AlertTriangle className="h-3.5 w-3.5" /> Escalate to a human</span>}
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{resolveResult.confidence}% confidence</span>
              </div>
              {resolveResult.decision === "resolve"
                ? <p className="text-foreground/80">A suggested reply has been staged below — review and send it (nothing was sent automatically).</p>
                : <p className="text-foreground/80">{resolveResult.reason || "The AI isn't confident enough to answer this on its own."}</p>}
              <button onClick={() => setResolveResult(null)} className="mt-1 text-[11px] text-muted-foreground hover:text-foreground">Dismiss</button>
            </CardContent>
          </Card>
        )}

        {/* Customer's original message */}
        <Card><CardContent className="space-y-1 p-4">
          <div className="text-xs text-muted-foreground">{ticket.requester_email} · {relativeDate(ticket.created_at)}</div>
          <p className="whitespace-pre-wrap text-sm">{ticket.body || "(no description)"}</p>
        </CardContent></Card>

        {/* Thread */}
        <div className="space-y-2">
          {(messages ?? []).map((m) => (
            <div key={m.id} className={cn("rounded-lg px-3 py-2 text-sm",
              m.is_internal ? "border border-amber-500/40 bg-amber-500/5"
                : m.author === "agent" ? "ml-8 bg-primary/10" : "mr-8 bg-muted")}>
              <div className="mb-0.5 flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
                {m.is_internal ? <><StickyNote className="h-3 w-3" /> internal note</> : m.author}
                {m.via_ai && <Sparkles className="h-3 w-3 text-primary" />}
                <span className="ml-auto normal-case">{relativeDate(m.created_at)}</span>
              </div>
              <p className="whitespace-pre-wrap">{m.body}</p>
            </div>
          ))}
        </div>

        {/* Composer */}
        <Card><CardContent className="space-y-2 p-3">
          <textarea value={reply} onChange={(e) => { setReply(e.target.value); setDraftViaAi(false); }} rows={3}
            placeholder={internal ? "Internal note (not sent to the customer)…" : "Reply to the customer…"}
            className={cn("w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring", internal ? "border-amber-500/40" : "border-input")} />
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note
            </label>
            {(macros ?? []).length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7"><Zap className="h-3.5 w-3.5" /> Macro <ChevronDown className="h-3 w-3" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                  {(macros ?? []).map((mac) => (
                    <DropdownMenuItem key={mac.id} onClick={() => setReply((r) => (r ? r + "\n\n" : "") + mac.body)}>
                      <div className="min-w-0"><div className="truncate text-sm font-medium">{mac.title}</div><div className="truncate text-[11px] text-muted-foreground">{mac.body}</div></div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button size="sm" className="ml-auto" onClick={send} disabled={!reply.trim()}>
              <Send className="h-3.5 w-3.5" /> {internal ? "Add note" : "Send reply"}
            </Button>
          </div>
        </CardContent></Card>
      </div>

      {/* Sidebar: properties + CSAT */}
      <div className="space-y-3">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Properties</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Prop label="Status">
              <select value={ticket.status} onChange={(e) => changeStatus(e.target.value as Ticket["status"])} className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs capitalize">
                {Object.keys(STATUS_META).map((s) => <option key={s} value={s}>{STATUS_META[s as Ticket["status"]].label}</option>)}
              </select>
            </Prop>
            <Prop label="Assignee">
              <select value={ticket.assignee_id ?? ""} onChange={(e) => assign(e.target.value || null)} className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs">
                <option value="">Unassigned</option>
                {members.map((m) => <option key={m.user_id} value={m.user_id}>{memberLabel(m)}</option>)}
              </select>
            </Prop>
            <Prop label="Priority"><Badge variant="outline" className="capitalize">{ticket.priority}</Badge></Prop>
            {ticket.assigned_team && <Prop label="Team"><Badge variant="outline">{ticket.assigned_team}</Badge></Prop>}
            {ticket.sla_breached && <Prop label="SLA"><span className="inline-flex items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 text-[11px] text-destructive"><AlertTriangle className="h-3 w-3" /> Breached</span></Prop>}
            {ticket.category && <Prop label="Category"><Badge variant="outline">{ticket.category}</Badge></Prop>}
            <Prop label="Channel"><span className="text-xs capitalize text-muted-foreground">{ticket.channel ?? "—"}</span></Prop>
            <Prop label="First reply"><span className="text-xs text-muted-foreground">{ticket.first_response_at ? relativeDate(ticket.first_response_at) : "pending"}</span></Prop>
          </CardContent>
        </Card>

        {(ticket.status === "solved" || ticket.status === "closed") && (
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Satisfaction</CardTitle></CardHeader>
            <CardContent>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} onClick={() => setCsat(n)}>
                    <Star className={cn("h-5 w-5", (ticket.csat ?? 0) >= n ? "fill-amber-400 text-amber-400" : "text-muted-foreground")} />
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{ticket.csat ? `${ticket.csat}/5 rated` : "No rating yet"}</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function TicketDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: Partial<Ticket>) => Promise<void> }) {
  const [d, setD] = useState<Partial<Ticket>>({ priority: "normal", status: "open", channel: "email" });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.subject?.trim()) return; setSaving(true); try { await onCreate(d); setD({ priority: "normal", status: "open", channel: "email" }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New ticket</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <SF label="Subject"><Input value={d.subject ?? ""} onChange={(e) => setD((p) => ({ ...p, subject: e.target.value }))} autoFocus /></SF>
          <SF label="Requester email"><Input type="email" value={d.requester_email ?? ""} onChange={(e) => setD((p) => ({ ...p, requester_email: e.target.value }))} /></SF>
          <SF label="Description"><textarea value={d.body ?? ""} onChange={(e) => setD((p) => ({ ...p, body: e.target.value }))} rows={4} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" /></SF>
          <div className="grid grid-cols-2 gap-2">
            <SF label="Priority">
              <select value={d.priority} onChange={(e) => setD((p) => ({ ...p, priority: e.target.value as Ticket["priority"] }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                {Object.keys(PRIORITY_META).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </SF>
            <SF label="Category"><Input value={d.category ?? ""} onChange={(e) => setD((p) => ({ ...p, category: e.target.value }))} placeholder="Billing…" /></SF>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Create</Button></div>
      </DialogContent>
    </Dialog>
  );
}

// =================================================================== ANALYTICS
export function SupportAnalyticsPage() {
  const { data: tickets } = useTickets();
  const data = useMemo(() => {
    const t = tickets ?? [];
    // First response time (hours) and resolution time, averaged.
    const frTimes: number[] = [], resTimes: number[] = [];
    t.forEach((x) => {
      if (x.first_response_at) frTimes.push((new Date(x.first_response_at).getTime() - new Date(x.created_at).getTime()) / 3600_000);
      if (x.solved_at) resTimes.push((new Date(x.solved_at).getTime() - new Date(x.created_at).getTime()) / 3600_000);
    });
    const avg = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
    const breached = t.filter((x) => !["solved", "closed"].includes(x.status) && slaState(x)?.breached).length;
    // Volume by day (created), last 14 days.
    const byDay: Record<string, { day: string; created: number; solved: number }> = {};
    const k = (iso: string) => iso.slice(5, 10);
    t.forEach((x) => { const d = k(x.created_at); byDay[d] ??= { day: d, created: 0, solved: 0 }; byDay[d].created++; if (x.solved_at) { const sd = k(x.solved_at); byDay[sd] ??= { day: sd, created: 0, solved: 0 }; byDay[sd].solved++; } });
    const volume = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)).slice(-14);
    // CSAT distribution.
    const csats = t.map((x) => x.csat).filter((v): v is number => v != null);
    const avgCsat = csats.length ? csats.reduce((s, v) => s + v, 0) / csats.length : null;
    // Autonomous resolution: AI-resolved vs human vs escalated.
    const aiResolved = t.filter((x) => x.resolution === "ai_resolved").length;
    const humanResolved = t.filter((x) => x.resolution === "human_resolved").length;
    const escalated = t.filter((x) => x.resolution === "escalated").length;
    const resolvedTotal = aiResolved + humanResolved + escalated;
    const deflection = resolvedTotal ? Math.round((aiResolved / resolvedTotal) * 100) : null;
    const escalationRate = resolvedTotal ? Math.round((escalated / resolvedTotal) * 100) : null;
    const confs = t.map((x) => x.ai_confidence).filter((v): v is number => v != null);
    const avgConf = confs.length ? Math.round(confs.reduce((s, v) => s + v, 0) / confs.length) : null;
    const resolutionMix = [
      { name: "AI resolved", value: aiResolved, fill: "#15aabf" },
      { name: "Human resolved", value: humanResolved, fill: "#4dabf7" },
      { name: "Escalated", value: escalated, fill: "#f59f00" },
    ];
    return { avgFr: avg(frTimes), avgRes: avg(resTimes), breached, volume, avgCsat, csatCount: csats.length, total: t.length,
      deflection, escalationRate, avgConf, resolutionMix, resolvedTotal };
  }, [tickets]);

  const fmtH = (h: number | null) => h == null ? "—" : h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`;

  return (
    <div className="space-y-6">
      <PageHeader title="Support analytics" description="Response times, volume, AI deflection and satisfaction." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Avg first response" value={fmtH(data.avgFr)} icon={Clock} />
        <MetricCard label="Avg resolution" value={fmtH(data.avgRes)} icon={Clock} />
        <MetricCard label="SLA breached (open)" value={String(data.breached)} icon={AlertTriangle} />
        <MetricCard label="Avg CSAT" value={data.avgCsat != null ? `${data.avgCsat.toFixed(1)} / 5` : "—"} icon={Smile} hint={`${data.csatCount} ratings`} />
      </div>

      {/* Autonomous resolution — measures how much the AI deflects vs escalates. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="AI deflection" value={data.deflection != null ? `${data.deflection}%` : "—"} icon={Sparkles} hint={`${data.resolvedTotal} resolved`} />
        <MetricCard label="Escalation rate" value={data.escalationRate != null ? `${data.escalationRate}%` : "—"} icon={Zap} hint="to a human agent" />
        <MetricCard label="Avg AI confidence" value={data.avgConf != null ? `${data.avgConf}%` : "—"} icon={BarChart3} />
      </div>
      {data.volume.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><BarChart3 className="h-4 w-4" /> Ticket volume (created vs solved)</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={data.volume} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={36} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="created" fill="#4dabf7" radius={[3, 3, 0, 0]} />
                <Bar dataKey="solved" fill="#15aabf" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {data.resolvedTotal > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Sparkles className="h-4 w-4" /> Resolution mix</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart layout="vertical" data={data.resolutionMix} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={110} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                  {data.resolutionMix.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ====================================================================== MACROS
export function SupportMacrosPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: macros, isLoading } = useQuery({
    queryKey: ["support_macros", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("support_macros").select("*").eq("project_id", projectId!).order("title");
      return (data ?? []) as Macro[];
    },
  });
  async function remove(id: string) { await supabase.from("support_macros").delete().eq("id", id); queryClient.invalidateQueries({ queryKey: ["support_macros", projectId] }); }

  return (
    <div className="space-y-5">
      <PageHeader title="Macros" description="Saved replies your team can insert in one click." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New macro</Button>} />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (macros ?? []).length === 0 ? <EmptyState icon={Zap} title="No macros" description="Create reusable canned responses." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New macro</Button>} />
        : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(macros ?? []).map((m) => (
              <Card key={m.id} className="group"><CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{m.title}</span>
                  <button onClick={() => remove(m.id)} className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"><Trash2 className="h-4 w-4" /></button>
                </div>
                {m.category && <Badge variant="outline" className="mt-1 text-[10px]">{m.category}</Badge>}
                <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">{m.body}</p>
              </CardContent></Card>
            ))}
          </div>
        )}

      <MacroDialog open={open} onOpenChange={setOpen} onCreate={async (d) => {
        if (!workspaceId || !projectId || !user) return;
        await supabase.from("support_macros").insert({ ...d, workspace_id: workspaceId, project_id: projectId, created_by: user.id });
        queryClient.invalidateQueries({ queryKey: ["support_macros", projectId] });
        setOpen(false);
      }} />
    </div>
  );
}

function MacroDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: Partial<Macro>) => Promise<void> }) {
  const [d, setD] = useState<Partial<Macro>>({});
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.title?.trim() || !d.body?.trim()) return; setSaving(true); try { await onCreate(d); setD({}); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>New macro</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <SF label="Title"><Input value={d.title ?? ""} onChange={(e) => setD((p) => ({ ...p, title: e.target.value }))} autoFocus placeholder="e.g. Refund confirmation" /></SF>
          <SF label="Category"><Input value={d.category ?? ""} onChange={(e) => setD((p) => ({ ...p, category: e.target.value }))} /></SF>
          <SF label="Body"><textarea value={d.body ?? ""} onChange={(e) => setD((p) => ({ ...p, body: e.target.value }))} rows={6} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" placeholder="The canned response text…" /></SF>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Create</Button></div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================= KNOWLEDGE BASE
export function SupportKbPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: articles, isLoading } = useQuery({
    queryKey: ["support_articles", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("support_articles").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Article[];
    },
  });
  return (
    <div className="space-y-5">
      <PageHeader title="Knowledge base" description="Help articles — also used by the AI to draft replies." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New article</Button>} />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (articles ?? []).length === 0 ? <EmptyState icon={BookOpen} title="No articles" description="Write your first help article." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New article</Button>} />
        : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(articles ?? []).map((a) => (
              <Card key={a.id}><CardContent className="p-4">
                <div className="mb-1 flex items-center gap-2"><BookOpen className="h-4 w-4 text-muted-foreground" /><span className="truncate text-sm font-medium">{a.title}</span></div>
                {a.category && <Badge variant="outline" className="mb-1 text-[10px]">{a.category}</Badge>}
                <p className="line-clamp-3 text-xs text-muted-foreground">{a.body}</p>
                <Badge variant={a.status === "published" ? "success" : "secondary"} className="mt-2 text-[10px] capitalize">{a.status}</Badge>
              </CardContent></Card>
            ))}
          </div>
        )}

      <ArticleDialog open={open} onOpenChange={setOpen} onCreate={async (d) => {
        if (!workspaceId || !projectId || !user) return;
        await supabase.from("support_articles").insert({ ...d, workspace_id: workspaceId, project_id: projectId, created_by: user.id });
        queryClient.invalidateQueries({ queryKey: ["support_articles", projectId] });
        setOpen(false);
      }} />
    </div>
  );
}

function ArticleDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: Partial<Article>) => Promise<void> }) {
  const [d, setD] = useState<Partial<Article>>({ status: "draft" });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.title?.trim()) return; setSaving(true); try { await onCreate(d); setD({ status: "draft" }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>New article</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <SF label="Title"><Input value={d.title ?? ""} onChange={(e) => setD((p) => ({ ...p, title: e.target.value }))} autoFocus /></SF>
          <SF label="Category"><Input value={d.category ?? ""} onChange={(e) => setD((p) => ({ ...p, category: e.target.value }))} /></SF>
          <SF label="Body"><textarea value={d.body ?? ""} onChange={(e) => setD((p) => ({ ...p, body: e.target.value }))} rows={6} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" /></SF>
          <SF label="Status">
            <select value={d.status} onChange={(e) => setD((p) => ({ ...p, status: e.target.value as Article["status"] }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {["draft", "published", "archived"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </SF>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Create</Button></div>
      </DialogContent>
    </Dialog>
  );
}

function SF({ label, children }: { label: string; children: React.ReactNode }) {
  return (<div><label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>{children}</div>);
}
