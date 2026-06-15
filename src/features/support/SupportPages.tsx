import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LifeBuoy, Loader2, Plus, Search, BookOpen, MessageSquare, ArrowLeft, Send,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

interface Ticket {
  id: string; subject: string; body: string | null; requester_email: string | null;
  priority: "low" | "normal" | "high" | "urgent"; status: "open" | "pending" | "on_hold" | "solved" | "closed";
  tags: string[]; created_at: string;
}
interface TMessage { id: string; ticket_id: string; author: "agent" | "customer"; body: string; created_at: string }
interface Article { id: string; title: string; body: string | null; category: string | null; status: "draft" | "published" | "archived"; created_at: string }

const STATUS_META: Record<Ticket["status"], string> = {
  open: "bg-sky-500/15 text-sky-600", pending: "bg-amber-500/15 text-amber-600",
  on_hold: "bg-muted text-muted-foreground", solved: "bg-emerald-500/15 text-emerald-600", closed: "bg-muted text-muted-foreground",
};
const PRIORITY_DOT: Record<Ticket["priority"], string> = {
  low: "bg-muted-foreground/50", normal: "bg-sky-500", high: "bg-amber-500", urgent: "bg-destructive",
};

function useTickets() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["support_tickets", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("support_tickets").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Ticket[];
    },
  });
}

// =================================================================== OVERVIEW
export function SupportOverviewPage() {
  const { data: tickets } = useTickets();
  const stats = useMemo(() => {
    const t = tickets ?? [];
    return {
      open: t.filter((x) => x.status === "open").length,
      pending: t.filter((x) => x.status === "pending").length,
      solved: t.filter((x) => ["solved", "closed"].includes(x.status)).length,
      urgent: t.filter((x) => x.priority === "urgent" && !["solved", "closed"].includes(x.status)).length,
    };
  }, [tickets]);
  return (
    <div className="space-y-6">
      <PageHeader title="Support — Overview" description="Ticket queue health." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Open" value={String(stats.open)} icon={LifeBuoy} />
        <MetricCard label="Pending" value={String(stats.pending)} icon={MessageSquare} />
        <MetricCard label="Urgent open" value={String(stats.urgent)} icon={LifeBuoy} />
        <MetricCard label="Solved" value={String(stats.solved)} icon={BookOpen} />
      </div>
    </div>
  );
}

// ==================================================================== TICKETS
export function SupportTicketsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const { data: tickets, isLoading } = useTickets();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Ticket | null>(null);

  const filtered = useMemo(() => {
    let list = tickets ?? [];
    if (search.trim()) { const q = search.toLowerCase(); list = list.filter((t) => t.subject.toLowerCase().includes(q) || (t.requester_email ?? "").toLowerCase().includes(q)); }
    return list;
  }, [tickets, search]);

  if (selected) return <TicketDetail ticket={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="space-y-5">
      <PageHeader title="Tickets" description="Customer support queue." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New ticket</Button>} />
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tickets…" className="h-9 pl-8" />
      </div>
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (tickets ?? []).length === 0 ? <EmptyState icon={LifeBuoy} title="No tickets" description="Open a ticket to start." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New ticket</Button>} />
        : (
          <div className="space-y-2">
            {filtered.map((t) => (
              <Card key={t.id} className="cursor-pointer transition-colors hover:border-foreground/30" onClick={() => setSelected(t)}>
                <CardContent className="flex items-center gap-3 p-3">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", PRIORITY_DOT[t.priority])} title={t.priority} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{t.subject}</div>
                    <div className="truncate text-xs text-muted-foreground">{t.requester_email || "—"}</div>
                  </div>
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", STATUS_META[t.status])}>{t.status.replace("_", " ")}</span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

      <TicketDialog open={open} onOpenChange={setOpen} onCreate={async (d) => {
        if (!workspaceId || !projectId) return;
        await supabase.from("support_tickets").insert({ ...d, workspace_id: workspaceId, project_id: projectId });
        queryClient.invalidateQueries({ queryKey: ["support_tickets", projectId] });
        setOpen(false);
      }} />
    </div>
  );
}

function TicketDetail({ ticket, onBack }: { ticket: Ticket; onBack: () => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [reply, setReply] = useState("");
  const [status, setStatus] = useState(ticket.status);

  const { data: messages } = useQuery({
    queryKey: ["support_messages", ticket.id],
    queryFn: async () => {
      const { data } = await supabase.from("support_messages").select("*").eq("ticket_id", ticket.id).order("created_at", { ascending: true });
      return (data ?? []) as TMessage[];
    },
  });

  async function send() {
    if (!reply.trim() || !workspaceId || !projectId) return;
    await supabase.from("support_messages").insert({ ticket_id: ticket.id, workspace_id: workspaceId, project_id: projectId, author: "agent", body: reply, created_by: user?.id ?? null });
    await supabase.from("support_tickets").update({ updated_at: new Date().toISOString(), first_response_at: ticket.created_at }).eq("id", ticket.id);
    setReply("");
    queryClient.invalidateQueries({ queryKey: ["support_messages", ticket.id] });
  }
  async function changeStatus(s: Ticket["status"]) {
    setStatus(s);
    await supabase.from("support_tickets").update({ status: s, solved_at: s === "solved" ? new Date().toISOString() : null }).eq("id", ticket.id);
    queryClient.invalidateQueries({ queryKey: ["support_tickets", projectId] });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft className="mr-1 h-3.5 w-3.5" /> Tickets</Button>
        <h2 className="flex-1 truncate text-base font-semibold">{ticket.subject}</h2>
        <select value={status} onChange={(e) => changeStatus(e.target.value as Ticket["status"])} className="h-8 rounded-md border border-input bg-background px-2 text-xs capitalize">
          {["open", "pending", "on_hold", "solved", "closed"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
      </div>
      <Card><CardContent className="space-y-1 p-4">
        <div className="text-xs text-muted-foreground">{ticket.requester_email}</div>
        <p className="text-sm">{ticket.body || "(no description)"}</p>
      </CardContent></Card>
      <div className="space-y-2">
        {(messages ?? []).map((m) => (
          <div key={m.id} className={cn("max-w-[80%] rounded-lg px-3 py-2 text-sm", m.author === "agent" ? "ml-auto bg-primary/10" : "bg-muted")}>
            <div className="mb-0.5 text-[10px] uppercase text-muted-foreground">{m.author}</div>
            {m.body}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Type a reply…" />
        <Button onClick={send} disabled={!reply.trim()}><Send className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

function TicketDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: Partial<Ticket>) => Promise<void> }) {
  const [d, setD] = useState<Partial<Ticket>>({ priority: "normal", status: "open" });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.subject?.trim()) return; setSaving(true); try { await onCreate(d); setD({ priority: "normal", status: "open" }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New ticket</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <SF label="Subject"><Input value={d.subject ?? ""} onChange={(e) => setD((p) => ({ ...p, subject: e.target.value }))} autoFocus /></SF>
          <SF label="Requester email"><Input type="email" value={d.requester_email ?? ""} onChange={(e) => setD((p) => ({ ...p, requester_email: e.target.value }))} /></SF>
          <SF label="Description"><textarea value={d.body ?? ""} onChange={(e) => setD((p) => ({ ...p, body: e.target.value }))} rows={4} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" /></SF>
          <SF label="Priority">
            <select value={d.priority} onChange={(e) => setD((p) => ({ ...p, priority: e.target.value as Ticket["priority"] }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {["low", "normal", "high", "urgent"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </SF>
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
      <PageHeader title="Knowledge base" description="Help articles for your customers." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New article</Button>} />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (articles ?? []).length === 0 ? <EmptyState icon={BookOpen} title="No articles" description="Write your first help article." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New article</Button>} />
        : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(articles ?? []).map((a) => (
              <Card key={a.id}><CardContent className="p-4">
                <div className="mb-1 flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">{a.title}</span>
                </div>
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
