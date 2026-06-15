import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Handshake, Loader2, Plus, Trash2, Search, Mail, Phone, Building2, CheckCircle2,
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

interface Contact {
  id: string; full_name: string; email: string | null; phone: string | null;
  company: string | null; title: string | null; status: "lead" | "prospect" | "customer" | "churned";
  tags: string[]; notes: string | null; created_at: string;
}
interface Deal {
  id: string; contact_id: string | null; title: string; amount_cents: number; currency: string;
  stage: "new" | "qualified" | "proposal" | "negotiation" | "won" | "lost"; probability: number;
  expected_close: string | null; created_at: string;
}
interface Activity {
  id: string; contact_id: string; deal_id: string | null;
  kind: "note" | "call" | "email" | "meeting" | "task"; subject: string | null; body: string | null;
  due_at: string | null; done: boolean; created_at: string;
}

const DEAL_STAGES = ["new", "qualified", "proposal", "negotiation", "won", "lost"] as const;
const STAGE_ACCENT: Record<Deal["stage"], string> = {
  new: "bg-zinc-400", qualified: "bg-sky-500", proposal: "bg-violet-500",
  negotiation: "bg-amber-500", won: "bg-emerald-500", lost: "bg-destructive",
};
const CONTACT_STATUS: Record<Contact["status"], string> = {
  lead: "bg-zinc-500/15 text-zinc-600", prospect: "bg-sky-500/15 text-sky-600",
  customer: "bg-emerald-500/15 text-emerald-600", churned: "bg-destructive/15 text-destructive",
};
function money(cents: number, cur = "eur") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: cur.toUpperCase(), maximumFractionDigits: 0 }).format(cents / 100);
}

function useContacts() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["crm_contacts", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("crm_contacts").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Contact[];
    },
  });
}
function useDeals() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["crm_deals", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("crm_deals").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Deal[];
    },
  });
}

// ================================================================== OVERVIEW
export function CrmOverviewPage() {
  const { data: contacts } = useContacts();
  const { data: deals } = useDeals();
  const stats = useMemo(() => {
    const d = deals ?? [];
    const open = d.filter((x) => !["won", "lost"].includes(x.stage));
    return {
      contacts: (contacts ?? []).length,
      customers: (contacts ?? []).filter((c) => c.status === "customer").length,
      pipeline: open.reduce((s, x) => s + x.amount_cents, 0),
      won: d.filter((x) => x.stage === "won").reduce((s, x) => s + x.amount_cents, 0),
      openDeals: open.length,
    };
  }, [contacts, deals]);
  return (
    <div className="space-y-6">
      <PageHeader title="CRM — Overview" description="Your sales pipeline at a glance." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Contacts" value={String(stats.contacts)} icon={Handshake} hint={`${stats.customers} customers`} />
        <MetricCard label="Open pipeline" value={money(stats.pipeline)} icon={Building2} hint={`${stats.openDeals} deals`} />
        <MetricCard label="Won" value={money(stats.won)} icon={CheckCircle2} />
        <MetricCard label="Avg deal" value={money(stats.openDeals ? Math.round(stats.pipeline / stats.openDeals) : 0)} icon={Building2} />
      </div>
    </div>
  );
}

// =================================================================== CONTACTS
export function CrmContactsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: contacts, isLoading } = useContacts();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    let list = contacts ?? [];
    if (search.trim()) { const q = search.toLowerCase(); list = list.filter((c) => c.full_name.toLowerCase().includes(q) || (c.company ?? "").toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q)); }
    return list;
  }, [contacts, search]);

  async function remove(id: string) {
    if (!confirm("Delete this contact?")) return;
    await supabase.from("crm_contacts").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["crm_contacts", projectId] });
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Contacts" description="Leads, prospects and customers." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add contact</Button>} />
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search contacts…" className="h-9 pl-8" />
      </div>
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (contacts ?? []).length === 0 ? <EmptyState icon={Handshake} title="No contacts yet" description="Add your first contact." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add contact</Button>} />
        : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                  <tr><th className="px-4 py-2">Name</th><th className="px-4 py-2">Company</th><th className="px-4 py-2">Contact</th><th className="px-4 py-2">Status</th><th className="px-4 py-2" /></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((c) => (
                    <tr key={c.id} className="group">
                      <td className="px-4 py-2"><div className="font-medium">{c.full_name}</div>{c.title && <div className="text-[11px] text-muted-foreground">{c.title}</div>}</td>
                      <td className="px-4 py-2 text-muted-foreground">{c.company || "—"}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {c.email && <div className="flex items-center gap-1"><Mail className="h-3 w-3" />{c.email}</div>}
                        {c.phone && <div className="flex items-center gap-1"><Phone className="h-3 w-3" />{c.phone}</div>}
                      </td>
                      <td className="px-4 py-2"><span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", CONTACT_STATUS[c.status])}>{c.status}</span></td>
                      <td className="px-4 py-2 text-right"><button onClick={() => remove(c.id)} className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"><Trash2 className="h-4 w-4" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

      <ContactDialog open={open} onOpenChange={setOpen} onCreate={async (d) => {
        if (!workspaceId || !projectId || !user) return;
        await supabase.from("crm_contacts").insert({ ...d, workspace_id: workspaceId, project_id: projectId, owner_id: user.id });
        queryClient.invalidateQueries({ queryKey: ["crm_contacts", projectId] });
        setOpen(false);
      }} />
    </div>
  );
}

function ContactDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: Partial<Contact>) => Promise<void> }) {
  const [d, setD] = useState<Partial<Contact>>({ status: "lead" });
  const [saving, setSaving] = useState(false);
  function set<K extends keyof Contact>(k: K, v: Contact[K]) { setD((p) => ({ ...p, [k]: v })); }
  async function submit() { if (!d.full_name?.trim()) return; setSaving(true); try { await onCreate(d); setD({ status: "lead" }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add contact</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <F label="Full name" full><Input value={d.full_name ?? ""} onChange={(e) => set("full_name", e.target.value)} autoFocus /></F>
          <F label="Company"><Input value={d.company ?? ""} onChange={(e) => set("company", e.target.value)} /></F>
          <F label="Title"><Input value={d.title ?? ""} onChange={(e) => set("title", e.target.value)} /></F>
          <F label="Email"><Input type="email" value={d.email ?? ""} onChange={(e) => set("email", e.target.value)} /></F>
          <F label="Phone"><Input value={d.phone ?? ""} onChange={(e) => set("phone", e.target.value)} /></F>
          <F label="Status" full>
            <select value={d.status} onChange={(e) => set("status", e.target.value as Contact["status"])} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {["lead", "prospect", "customer", "churned"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </F>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Add</Button></div>
      </DialogContent>
    </Dialog>
  );
}

// =================================================================== PIPELINE
export function CrmPipelinePage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: deals, isLoading } = useDeals();
  const { data: contacts } = useContacts();
  const [open, setOpen] = useState(false);

  const byStage = useMemo(() => {
    const m: Record<string, Deal[]> = {};
    DEAL_STAGES.forEach((s) => (m[s] = []));
    (deals ?? []).forEach((d) => { (m[d.stage] ??= []).push(d); });
    return m;
  }, [deals]);

  async function move(id: string, stage: Deal["stage"]) {
    await supabase.from("crm_deals").update({ stage }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["crm_deals", projectId] });
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Pipeline" description="Track deals across stages." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New deal</Button>} />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {DEAL_STAGES.map((stage) => {
              const list = byStage[stage] ?? [];
              const total = list.reduce((s, d) => s + d.amount_cents, 0);
              return (
                <div key={stage} className="rounded-lg border border-border bg-muted/20 p-2">
                  <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium">
                    <span className={cn("h-2 w-2 rounded-full", STAGE_ACCENT[stage])} />
                    <span className="capitalize">{stage}</span>
                    <span className="ml-auto text-muted-foreground">{money(total)}</span>
                  </div>
                  <div className="space-y-2">
                    {list.map((d) => (
                      <div key={d.id} className="rounded-md border border-border bg-card p-2.5">
                        <div className="text-sm font-medium">{d.title}</div>
                        <div className="text-xs text-muted-foreground">{money(d.amount_cents, d.currency)} · {d.probability}%</div>
                        <select value={d.stage} onChange={(e) => move(d.id, e.target.value as Deal["stage"])} className="mt-1.5 w-full rounded border border-input bg-background px-1 py-0.5 text-[11px] capitalize">
                          {DEAL_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

      <DealDialog open={open} onOpenChange={setOpen} contacts={contacts ?? []} onCreate={async (d) => {
        if (!workspaceId || !projectId || !user) return;
        await supabase.from("crm_deals").insert({ ...d, workspace_id: workspaceId, project_id: projectId, owner_id: user.id });
        queryClient.invalidateQueries({ queryKey: ["crm_deals", projectId] });
        setOpen(false);
      }} />
    </div>
  );
}

function DealDialog({ open, onOpenChange, contacts, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; contacts: Contact[]; onCreate: (d: Partial<Deal>) => Promise<void> }) {
  const [d, setD] = useState<Partial<Deal>>({ stage: "new", probability: 10, currency: "eur", amount_cents: 0 });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.title?.trim()) return; setSaving(true); try { await onCreate(d); setD({ stage: "new", probability: 10, currency: "eur", amount_cents: 0 }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New deal</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <F label="Title"><Input value={d.title ?? ""} onChange={(e) => setD((p) => ({ ...p, title: e.target.value }))} autoFocus /></F>
          <div className="grid grid-cols-2 gap-2">
            <F label="Amount (€)"><Input type="number" value={d.amount_cents ? d.amount_cents / 100 : ""} onChange={(e) => setD((p) => ({ ...p, amount_cents: Math.round(Number(e.target.value) * 100) }))} /></F>
            <F label="Probability %"><Input type="number" value={d.probability ?? 10} onChange={(e) => setD((p) => ({ ...p, probability: Number(e.target.value) }))} /></F>
          </div>
          <F label="Contact">
            <select value={d.contact_id ?? ""} onChange={(e) => setD((p) => ({ ...p, contact_id: e.target.value || null }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="">—</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.full_name}{c.company ? ` (${c.company})` : ""}</option>)}
            </select>
          </F>
          <F label="Expected close"><Input type="date" value={d.expected_close ?? ""} onChange={(e) => setD((p) => ({ ...p, expected_close: e.target.value }))} /></F>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Create</Button></div>
      </DialogContent>
    </Dialog>
  );
}

// ================================================================= ACTIVITIES
export function CrmActivitiesPage() {
  const { projectId } = useCurrentContext();
  const { data: contacts } = useContacts();
  const contactName = (id: string) => (contacts ?? []).find((c) => c.id === id)?.full_name ?? "—";
  const queryClient = useQueryClient();
  const { data: activities, isLoading } = useQuery({
    queryKey: ["crm_activities", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("crm_activities").select("*").eq("project_id", projectId!).order("created_at", { ascending: false }).limit(100);
      return (data ?? []) as Activity[];
    },
  });
  async function toggle(a: Activity) {
    await supabase.from("crm_activities").update({ done: !a.done }).eq("id", a.id);
    queryClient.invalidateQueries({ queryKey: ["crm_activities", projectId] });
  }
  return (
    <div className="space-y-5">
      <PageHeader title="Activities" description="Calls, emails, meetings and tasks across contacts." />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (activities ?? []).length === 0 ? <EmptyState icon={Handshake} title="No activities" description="Activities logged against contacts/deals will appear here." />
        : (
          <div className="space-y-2">
            {(activities ?? []).map((a) => (
              <Card key={a.id}>
                <CardContent className="flex items-start gap-3 p-3">
                  <button onClick={() => toggle(a)} className={cn("mt-0.5 flex h-5 w-5 items-center justify-center rounded border", a.done ? "border-emerald-500 bg-emerald-500 text-white" : "border-border")}>
                    {a.done && <CheckCircle2 className="h-3.5 w-3.5" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px] capitalize">{a.kind}</Badge>
                      <span className={cn("text-sm font-medium", a.done && "line-through text-muted-foreground")}>{a.subject || "(no subject)"}</span>
                    </div>
                    {a.body && <p className="mt-0.5 text-xs text-muted-foreground">{a.body}</p>}
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{contactName(a.contact_id)}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
    </div>
  );
}

function F({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={full ? "col-span-2" : ""}>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
