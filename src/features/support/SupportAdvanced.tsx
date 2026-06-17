import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Plus, Trash2, Phone, PhoneCall, Mail, MessageSquare, Globe, Smartphone,
  Hash, Power, Clock, GitBranch, Copy, Check, ExternalLink, Sparkles, ChevronUp, ChevronDown,
  PhoneIncoming, AlertTriangle, Settings2,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import {
  type SupportChannel, type SlaPolicy, type RoutingRule, type VoiceCall, type SupportPortal,
  CHANNEL_META, relativeDate,
} from "./shared";

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const CHANNEL_ICON: Record<SupportChannel["kind"], typeof Mail> = {
  email: Mail, chat: MessageSquare, web: Globe, voice: Phone, sms: Smartphone, social: Hash, api: Hash,
};

// =====================================================================  CHANNELS
export function SupportChannelsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [configuring, setConfiguring] = useState<SupportChannel | null>(null);

  const { data: channels, isLoading } = useQuery({
    queryKey: ["support_channels", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("support_channels").select("*").eq("project_id", projectId!).order("created_at");
      return (data ?? []) as SupportChannel[];
    },
  });

  async function add(d: { kind: SupportChannel["kind"]; name: string; address: string }) {
    if (!workspaceId || !projectId || !d.name.trim()) return;
    const config: Record<string, unknown> = {};
    if (d.kind === "voice") {
      config.token = crypto.randomUUID().replace(/-/g, "");
      config.language = "fr";
      config.greeting = "Bonjour, vous êtes en relation avec l'assistant. Comment puis-je vous aider ?";
      config.record = false;
    }
    const { data: row } = await supabase.from("support_channels").insert({ workspace_id: workspaceId, project_id: projectId, kind: d.kind, name: d.name.trim(), address: d.address || null, config }).select("*").single();
    queryClient.invalidateQueries({ queryKey: ["support_channels", projectId] });
    setOpen(false);
    // Voice channels need configuration — open the editor immediately.
    if (d.kind === "voice" && row) setConfiguring(row as SupportChannel);
  }
  async function toggle(c: SupportChannel) {
    await supabase.from("support_channels").update({ enabled: !c.enabled }).eq("id", c.id);
    queryClient.invalidateQueries({ queryKey: ["support_channels", projectId] });
  }
  async function remove(id: string) {
    await supabase.from("support_channels").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["support_channels", projectId] });
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Channels" description="Connect the sources customers reach you through — email, chat, web, voice, SMS, social." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add channel</Button>} />
      {isLoading ? <Spinner />
        : (channels ?? []).length === 0 ? <EmptyState icon={MessageSquare} title="No channels" description="Add a channel to start receiving tickets from it." />
        : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(channels ?? []).map((c) => {
              const Icon = CHANNEL_ICON[c.kind];
              const voiceReady = c.kind === "voice" && !!(c.config as { runner_ws?: string })?.runner_ws;
              return (
                <Card key={c.id} className="group">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <span className={cn("flex h-8 w-8 items-center justify-center rounded-md", CHANNEL_META[c.kind].cls)}><Icon className="h-4 w-4" /></span>
                        <div><div className="font-medium">{c.name}</div><div className="text-[11px] text-muted-foreground">{CHANNEL_META[c.kind].label}</div></div>
                      </div>
                      <button onClick={() => remove(c.id)} className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                    {c.address && <div className="truncate text-xs text-muted-foreground">{c.address}</div>}
                    {c.kind === "voice" && (
                      <div className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]", voiceReady ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600")}>
                        {voiceReady ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                        {voiceReady ? "Bridge configured" : "Needs configuration"}
                      </div>
                    )}
                    <div className="flex items-center justify-between pt-1">
                      <button onClick={() => toggle(c)} className={cn("flex items-center gap-1 text-[11px]", c.enabled ? "text-emerald-600" : "text-muted-foreground")}><Power className="h-3 w-3" /> {c.enabled ? "Enabled" : "Disabled"}</button>
                      {c.kind === "voice" && <Button size="sm" variant="outline" className="h-7" onClick={() => setConfiguring(c)}><Settings2 className="mr-1 h-3.5 w-3.5" /> Configure</Button>}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      <AddChannelDialog open={open} onOpenChange={setOpen} onAdd={add} />
      {configuring && <VoiceChannelConfigDialog channel={configuring} onClose={() => setConfiguring(null)} onSaved={() => queryClient.invalidateQueries({ queryKey: ["support_channels", projectId] })} />}
    </div>
  );
}

interface VoiceConfig {
  token?: string; runner_ws?: string; greeting?: string; language?: string;
  record?: boolean; account_sid?: string;
}

// Full voice call-center configuration: the WS bridge endpoint, greeting,
// language, recording, plus the Twilio webhook URL + a readiness checklist.
function VoiceChannelConfigDialog({ channel, onClose, onSaved }: { channel: SupportChannel; onClose: () => void; onSaved: () => void }) {
  const [cfg, setCfg] = useState<VoiceConfig>({ ...(channel.config as VoiceConfig) });
  const [address, setAddress] = useState(channel.address ?? "");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const token = cfg.token ?? "";
  const webhookUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/support-voice?action=incoming&t=${token}`;
  const statusUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/support-voice?action=status&t=${token}`;

  function set<K extends keyof VoiceConfig>(k: K, v: VoiceConfig[K]) { setCfg((p) => ({ ...p, [k]: v })); }
  function copy(text: string, key: string) { navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1500); }

  async function save() {
    setSaving(true);
    try {
      await supabase.from("support_channels").update({ config: cfg, address: address || null }).eq("id", channel.id);
      onSaved(); onClose();
    } finally { setSaving(false); }
  }

  const wsOk = !!cfg.runner_ws && /^wss?:\/\//.test(cfg.runner_ws);
  const checklist = [
    { ok: !!address, label: "A Twilio phone number is set (below)" },
    { ok: wsOk, label: "The runner WebSocket URL is set (wss://…)" },
    { ok: !!cfg.greeting, label: "A greeting message is set" },
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><PhoneCall className="h-4 w-4" /> Configure voice call center — {channel.name}</DialogTitle></DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          {/* Readiness checklist */}
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Setup checklist</div>
            <ul className="space-y-1 text-sm">
              {checklist.map((c, i) => (
                <li key={i} className="flex items-center gap-2">
                  {c.ok ? <Check className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
                  <span className={c.ok ? "text-foreground" : "text-muted-foreground"}>{c.label}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Bridge + behaviour config */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone number (E.164)"><Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="+33 1 23 45 67 89" /></Field>
            <Field label="Language"><select value={cfg.language ?? "fr"} onChange={(e) => set("language", e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">{["fr", "en", "es", "de", "it", "pt", "nl"].map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}</select></Field>
          </div>
          <Field label="Runner WebSocket URL (wss://…)">
            <Input value={cfg.runner_ws ?? ""} onChange={(e) => set("runner_ws", e.target.value)} placeholder="wss://voice.yourdomain.com" />
            <p className="mt-1 text-[11px] text-muted-foreground">Public address of the self-hosted runner's voice bridge (VOICE_WS_PORT). Twilio Media Streams connects here for live audio.</p>
          </Field>
          <Field label="Greeting (spoken when the call connects)">
            <textarea value={cfg.greeting ?? ""} onChange={(e) => set("greeting", e.target.value)} rows={2} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          </Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!cfg.record} onChange={(e) => set("record", e.target.checked)} className="accent-primary" /> Record calls (store recording URL on the call)</label>

          {/* Twilio wiring */}
          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Twilio number webhooks</div>
            <CopyRow label="Voice — “A call comes in” (HTTP POST)" value={webhookUrl} copied={copied === "wh"} onCopy={() => copy(webhookUrl, "wh")} />
            <CopyRow label="Call status callback (optional)" value={statusUrl} copied={copied === "st"} onCopy={() => copy(statusUrl, "st")} />
            <p className="mt-2 text-[11px] text-muted-foreground">In Twilio Console → your number → Voice Configuration, set these URLs. Twilio/Deepgram secrets live in the runner's <code>.env</code> (DEEPGRAM_API_KEY, VOICE_WS_PORT) — never stored here.</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Save configuration</Button></div>
      </DialogContent>
    </Dialog>
  );
}

function CopyRow({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="mb-2">
      <div className="mb-0.5 text-[11px] text-muted-foreground">{label}</div>
      <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1.5">
        <code className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{value}</code>
        <button onClick={onCopy} className="shrink-0 rounded p-1 hover:bg-muted">{copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}</button>
      </div>
    </div>
  );
}

function AddChannelDialog({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange: (o: boolean) => void; onAdd: (d: { kind: SupportChannel["kind"]; name: string; address: string }) => Promise<void> }) {
  const [d, setD] = useState<{ kind: SupportChannel["kind"]; name: string; address: string }>({ kind: "email", name: "", address: "" });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.name.trim()) return; setSaving(true); try { await onAdd(d); setD({ kind: "email", name: "", address: "" }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add channel</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label="Type"><select value={d.kind} onChange={(e) => setD((p) => ({ ...p, kind: e.target.value as SupportChannel["kind"] }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">{(Object.keys(CHANNEL_META) as SupportChannel["kind"][]).map((k) => <option key={k} value={k}>{CHANNEL_META[k].label}</option>)}</select></Field>
          <Field label="Name"><Input value={d.name} onChange={(e) => setD((p) => ({ ...p, name: e.target.value }))} autoFocus placeholder="Support inbox, Sales line…" /></Field>
          <Field label={d.kind === "voice" ? "Phone number" : d.kind === "email" ? "Inbox address" : "Address / key"}><Input value={d.address} onChange={(e) => setD((p) => ({ ...p, address: e.target.value }))} placeholder={d.kind === "voice" ? "+33 1 23 45 67 89" : "help@company.com"} /></Field>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Add</Button></div>
      </DialogContent>
    </Dialog>
  );
}

// =================================================================  SLA & ROUTING
export function SupportSlaRoutingPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="SLA & routing" description="Define response/resolution targets per priority, and rules that auto-assign and prioritise incoming tickets." />
      <SlaPolicies />
      <RoutingRules />
    </div>
  );
}

function SlaPolicies() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const { data: policies, isLoading } = useQuery({
    queryKey: ["support_sla", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("support_sla_policies").select("*").eq("project_id", projectId!).order("created_at");
      return (data ?? []) as SlaPolicy[];
    },
  });

  async function add() {
    if (!workspaceId || !projectId) return;
    const isFirst = (policies ?? []).length === 0;
    await supabase.from("support_sla_policies").insert({ workspace_id: workspaceId, project_id: projectId, name: "New SLA policy", is_default: isFirst });
    queryClient.invalidateQueries({ queryKey: ["support_sla", projectId] });
  }
  async function patch(id: string, p: Partial<SlaPolicy>) {
    await supabase.from("support_sla_policies").update(p).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["support_sla", projectId] });
  }
  async function setTarget(pol: SlaPolicy, prio: typeof PRIORITIES[number], field: "frt" | "res", minutes: number) {
    const targets = { ...pol.targets, [prio]: { ...pol.targets[prio], [field]: minutes } };
    await patch(pol.id, { targets });
  }
  async function remove(id: string) { await supabase.from("support_sla_policies").delete().eq("id", id); queryClient.invalidateQueries({ queryKey: ["support_sla", projectId] }); }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><Clock className="h-4 w-4" /> SLA policies</CardTitle>
        <Button size="sm" variant="outline" onClick={add}><Plus className="h-3.5 w-3.5" /> Policy</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? <Spinner /> : (policies ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No SLA policy yet. Create one to set response/resolution targets.</p>
          : (policies ?? []).map((pol) => (
            <div key={pol.id} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center gap-2">
                <Input value={pol.name} onChange={(e) => patch(pol.id, { name: e.target.value })} className="h-8 max-w-xs" />
                <button onClick={() => patch(pol.id, { is_default: true })} className={cn("rounded px-1.5 py-0.5 text-[10px]", pol.is_default ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground")}>{pol.is_default ? "Default" : "Set default"}</button>
                <button onClick={() => remove(pol.id)} className="ml-auto rounded p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase text-muted-foreground"><th className="py-1">Priority</th><th>First response (min)</th><th>Resolution (min)</th></tr></thead>
                <tbody>
                  {PRIORITIES.map((prio) => (
                    <tr key={prio} className="border-t border-border/60">
                      <td className="py-1.5 capitalize">{prio}</td>
                      <td><input type="number" value={pol.targets[prio]?.frt ?? 0} onChange={(e) => setTarget(pol, prio, "frt", Number(e.target.value))} className="h-7 w-24 rounded border border-input bg-background px-2 text-sm" /></td>
                      <td><input type="number" value={pol.targets[prio]?.res ?? 0} onChange={(e) => setTarget(pol, prio, "res", Number(e.target.value))} className="h-7 w-24 rounded border border-input bg-background px-2 text-sm" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

function RoutingRules() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const { data: rules } = useQuery({
    queryKey: ["support_routing", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("support_routing_rules").select("*").eq("project_id", projectId!).order("position");
      return (data ?? []) as RoutingRule[];
    },
  });

  async function add() {
    if (!workspaceId || !projectId) return;
    const pos = (rules ?? []).length;
    await supabase.from("support_routing_rules").insert({ workspace_id: workspaceId, project_id: projectId, name: "New rule", position: pos, conditions: {}, actions: {} });
    queryClient.invalidateQueries({ queryKey: ["support_routing", projectId] });
  }
  async function patch(id: string, p: Partial<RoutingRule>) { await supabase.from("support_routing_rules").update(p).eq("id", id); queryClient.invalidateQueries({ queryKey: ["support_routing", projectId] }); }
  async function move(r: RoutingRule, dir: -1 | 1) {
    const list = rules ?? []; const i = list.findIndex((x) => x.id === r.id); const j = i + dir;
    if (j < 0 || j >= list.length) return;
    await patch(r.id, { position: list[j].position }); await patch(list[j].id, { position: r.position });
  }
  async function remove(id: string) { await supabase.from("support_routing_rules").delete().eq("id", id); queryClient.invalidateQueries({ queryKey: ["support_routing", projectId] }); }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><GitBranch className="h-4 w-4" /> Routing rules</CardTitle>
        <Button size="sm" variant="outline" onClick={add}><Plus className="h-3.5 w-3.5" /> Rule</Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {(rules ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No routing rules. Rules run top-to-bottom; the first match applies.</p>
          : (rules ?? []).map((r, i) => (
            <div key={r.id} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex items-center gap-2">
                <Input value={r.name} onChange={(e) => patch(r.id, { name: e.target.value })} className="h-8 max-w-xs" />
                <div className="ml-auto flex items-center gap-1">
                  <button disabled={i === 0} onClick={() => move(r, -1)} className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"><ChevronUp className="h-3.5 w-3.5" /></button>
                  <button disabled={i === (rules ?? []).length - 1} onClick={() => move(r, 1)} className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"><ChevronDown className="h-3.5 w-3.5" /></button>
                  <button onClick={() => remove(r.id)} className="rounded p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium uppercase text-muted-foreground">When (conditions)</div>
                  <Labelled label="Channel"><select value={r.conditions.channel ?? ""} onChange={(e) => patch(r.id, { conditions: { ...r.conditions, channel: e.target.value || undefined } })} className="h-8 w-full rounded border border-input bg-background px-2 text-sm"><option value="">any</option>{(Object.keys(CHANNEL_META) as SupportChannel["kind"][]).map((k) => <option key={k} value={k}>{CHANNEL_META[k].label}</option>)}</select></Labelled>
                  <Labelled label="Priority"><select value={r.conditions.priority ?? ""} onChange={(e) => patch(r.id, { conditions: { ...r.conditions, priority: e.target.value || undefined } })} className="h-8 w-full rounded border border-input bg-background px-2 text-sm"><option value="">any</option>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></Labelled>
                  <Labelled label="Keywords (comma-sep)"><Input className="h-8" value={(r.conditions.keywords ?? []).join(", ")} onChange={(e) => patch(r.id, { conditions: { ...r.conditions, keywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } })} placeholder="refund, urgent…" /></Labelled>
                </div>
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium uppercase text-muted-foreground">Then (actions)</div>
                  <Labelled label="Assign team"><Input className="h-8" value={r.actions.team ?? ""} onChange={(e) => patch(r.id, { actions: { ...r.actions, team: e.target.value || undefined } })} placeholder="Tier 2, Billing…" /></Labelled>
                  <Labelled label="Set priority"><select value={r.actions.priority ?? ""} onChange={(e) => patch(r.id, { actions: { ...r.actions, priority: e.target.value || undefined } })} className="h-8 w-full rounded border border-input bg-background px-2 text-sm"><option value="">keep</option>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></Labelled>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!r.actions.ai_resolve} onChange={(e) => patch(r.id, { actions: { ...r.actions, ai_resolve: e.target.checked } })} className="accent-primary" /> Let AI attempt resolution first</label>
                </div>
              </div>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

// =================================================================  CALL CENTER
export function SupportCallCenterPage() {
  const { projectId } = useCurrentContext();
  const [selected, setSelected] = useState<VoiceCall | null>(null);
  const { data: calls, isLoading } = useQuery({
    queryKey: ["support_voice_calls", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("support_voice_calls").select("*").eq("project_id", projectId!).order("started_at", { ascending: false }).limit(100);
      return (data ?? []) as VoiceCall[];
    },
    refetchInterval: 5000,
  });

  const stats = useMemo(() => {
    const list = calls ?? [];
    const live = list.filter((c) => ["ringing", "in_progress", "ai_handling"].includes(c.status)).length;
    const aiResolved = list.filter((c) => c.resolution === "ai_resolved").length;
    const escalated = list.filter((c) => c.resolution === "escalated").length;
    const handled = aiResolved + escalated;
    return { live, total: list.length, deflection: handled ? Math.round((aiResolved / handled) * 100) : null };
  }, [calls]);

  const STATUS_CLS: Record<VoiceCall["status"], string> = {
    ringing: "bg-amber-500/15 text-amber-600", in_progress: "bg-sky-500/15 text-sky-600",
    ai_handling: "bg-violet-500/15 text-violet-600", escalated: "bg-amber-500/15 text-amber-600",
    completed: "bg-emerald-500/15 text-emerald-600", failed: "bg-destructive/15 text-destructive",
    no_answer: "bg-muted text-muted-foreground",
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Call center" description="AI voice agent (Twilio + Deepgram). Live calls, transcripts and resolution outcomes." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Live calls" value={String(stats.live)} icon={PhoneCall} />
        <MetricCard label="Calls (recent)" value={String(stats.total)} icon={Phone} />
        <MetricCard label="Voice AI deflection" value={stats.deflection != null ? `${stats.deflection}%` : "—"} icon={Sparkles} />
      </div>

      {isLoading ? <Spinner />
        : (calls ?? []).length === 0 ? <EmptyState icon={PhoneIncoming} title="No calls yet" description="Point a Twilio number's voice webhook at a voice channel to start receiving calls." />
        : (
          <Card><CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                <tr><th className="px-3 py-2">From</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Resolution</th><th className="px-3 py-2">Duration</th><th className="px-3 py-2">When</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(calls ?? []).map((c) => (
                  <tr key={c.id} className="cursor-pointer hover:bg-muted/30" onClick={() => setSelected(c)}>
                    <td className="px-3 py-2 font-medium">{c.from_number || "Unknown"}</td>
                    <td className="px-3 py-2"><span className={cn("rounded px-1.5 py-0.5 text-[11px] capitalize", STATUS_CLS[c.status])}>{c.status.replace("_", " ")}</span></td>
                    <td className="px-3 py-2 text-muted-foreground">{c.resolution ? c.resolution.replace("_", " ") : "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{c.duration_sec != null ? `${c.duration_sec}s` : "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{relativeDate(c.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent></Card>
        )}

      {selected && <CallDrawer call={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CallDrawer({ call, onClose }: { call: VoiceCall; onClose: () => void }) {
  // Live transcript: re-read the call row while it's in progress.
  const { data: live } = useQuery({
    queryKey: ["support_voice_call", call.id],
    queryFn: async () => { const { data } = await supabase.from("support_voice_calls").select("*").eq("id", call.id).maybeSingle(); return data as VoiceCall | null; },
    initialData: call,
    refetchInterval: ["ringing", "in_progress", "ai_handling"].includes(call.status) ? 2500 : false,
  });
  const c = live ?? call;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside className="flex h-full w-full max-w-md flex-col border-l border-border bg-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div><div className="font-semibold">{c.from_number || "Unknown caller"}</div><div className="text-xs text-muted-foreground capitalize">{c.status.replace("_", " ")}{c.duration_sec != null && ` · ${c.duration_sec}s`}</div></div>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}><span className="text-lg leading-none">×</span></Button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {c.summary && <Card className="border-primary/30 bg-primary/5"><CardContent className="p-3 text-sm"><div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-primary"><Sparkles className="h-3.5 w-3.5" /> AI summary</div>{c.summary}</CardContent></Card>}
          <div className="text-[11px] font-medium uppercase text-muted-foreground">Transcript</div>
          {(c.transcript ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No transcript {["ringing", "in_progress", "ai_handling"].includes(c.status) ? "yet — the call is live." : "available."}</p>
            : (c.transcript ?? []).map((t, i) => (
              <div key={i} className={cn("max-w-[85%] rounded-lg px-3 py-1.5 text-sm", t.role === "agent" ? "ml-auto bg-primary/10" : "bg-muted")}>
                <div className="text-[10px] uppercase text-muted-foreground">{t.role === "agent" ? "AI agent" : "Caller"}</div>{t.text}
              </div>
            ))}
          {c.recording_url && <a href={c.recording_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><ExternalLink className="h-3 w-3" /> Recording</a>}
        </div>
      </aside>
    </div>
  );
}

// =====================================================================  PORTAL
export function SupportPortalPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const { data: portal, isLoading } = useQuery({
    queryKey: ["support_portal", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("support_portals").select("*").eq("project_id", projectId!).maybeSingle();
      return data as SupportPortal | null;
    },
  });
  const { data: collections } = useQuery({
    queryKey: ["rag_collections_for_portal", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("rag_collections").select("id, name").eq("project_id", projectId!).order("name");
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  const { data: articles } = useQuery({
    queryKey: ["support_articles_pub", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("support_articles").select("id, title, status, helpful_yes, helpful_no").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as { id: string; title: string; status: string; helpful_yes: number; helpful_no: number }[];
    },
  });

  async function create() {
    if (!workspaceId || !projectId) return;
    await supabase.from("support_portals").insert({ workspace_id: workspaceId, project_id: projectId });
    queryClient.invalidateQueries({ queryKey: ["support_portal", projectId] });
  }
  async function patch(p: Partial<SupportPortal>) { if (!portal) return; await supabase.from("support_portals").update(p).eq("id", portal.id); queryClient.invalidateQueries({ queryKey: ["support_portal", projectId] }); }

  if (isLoading) return <Spinner />;

  return (
    <div className="space-y-4">
      <PageHeader title="Help center portal" description="A public self-service portal: customers search published articles and get AI answers from your knowledge before opening a ticket." actions={!portal && <Button size="sm" onClick={create}><Plus className="h-4 w-4" /> Create portal</Button>} />

      {!portal ? <EmptyState icon={Globe} title="No portal yet" description="Create a public help center to deflect tickets with self-service." />
        : (
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Configuration</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Field label="Title"><Input value={portal.title} onChange={(e) => patch({ title: e.target.value })} /></Field>
                <Field label="Welcome message"><Input value={portal.welcome ?? ""} onChange={(e) => patch({ welcome: e.target.value })} placeholder="How can we help?" /></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Brand color"><Input type="color" value={portal.brand_color ?? "#e0457b"} onChange={(e) => patch({ brand_color: e.target.value })} className="h-9 w-full" /></Field>
                  <Field label="AI knowledge collection"><select value={portal.rag_collection_id ?? ""} onChange={(e) => patch({ rag_collection_id: e.target.value || null })} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"><option value="">Project-wide knowledge</option>{(collections ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
                </div>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={portal.ai_enabled} onChange={(e) => patch({ ai_enabled: e.target.checked })} className="accent-primary" /> Answer with AI from the knowledge base before opening a ticket</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={portal.enabled} onChange={(e) => patch({ enabled: e.target.checked })} className="accent-primary" /> Portal enabled (publicly accessible)</label>
              </CardContent>
            </Card>
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Globe className="h-4 w-4" /> Public link</CardTitle></CardHeader>
                <CardContent>
                  <PortalLink publicKey={portal.public_key} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Published articles</CardTitle></CardHeader>
                <CardContent className="space-y-1.5">
                  {(articles ?? []).filter((a) => a.status === "published").length === 0 ? <p className="text-xs text-muted-foreground">No published articles. Publish articles in the Knowledge base.</p>
                    : (articles ?? []).filter((a) => a.status === "published").map((a) => (
                      <div key={a.id} className="flex items-center justify-between text-sm"><span className="truncate">{a.title}</span><span className="shrink-0 text-[11px] text-muted-foreground">👍 {a.helpful_yes} · 👎 {a.helpful_no}</span></div>
                    ))}
                </CardContent>
              </Card>
            </div>
          </div>
        )}
    </div>
  );
}

function PortalLink({ publicKey }: { publicKey: string }) {
  const url = `${window.location.origin}/help/${publicKey}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 p-2 text-xs">
      <code className="min-w-0 flex-1 truncate text-muted-foreground">{url}</code>
      <button onClick={() => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="shrink-0 rounded p-1 hover:bg-muted">{copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}</button>
      <a href={url} target="_blank" rel="noreferrer" className="shrink-0 rounded p-1 hover:bg-muted"><ExternalLink className="h-3 w-3" /></a>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── helpers
function Spinner() { return <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>{children}</div>; }
function Labelled({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="mb-0.5 block text-[11px] text-muted-foreground">{label}</label>{children}</div>; }
