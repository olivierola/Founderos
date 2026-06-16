import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FlaskConical, Loader2, Plus, Trash2, ArrowLeft, Users, Play, Sparkles, Send,
  TrendingUp, TrendingDown, Minus, MessageSquare, FileText,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

interface Sim {
  id: string; name: string; seed_text: string; question: string;
  persona_count: number; total_rounds: number; current_round: number;
  status: "draft" | "preparing" | "ready" | "queued" | "running" | "completed" | "failed";
  report: any | null; error: string | null; created_at: string;
}
interface Persona { id: string; name: string; role: string | null; bio: string | null; stance: string | null; avatar_emoji: string | null; traits: any }
interface Action { id: string; round: number; persona_id: string | null; kind: string; content: string; sentiment: string | null; created_at: string }

const STATUS_META: Record<Sim["status"], { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-zinc-500/15 text-zinc-500" },
  preparing: { label: "Generating personas", cls: "bg-violet-500/15 text-violet-500" },
  ready: { label: "Ready", cls: "bg-sky-500/15 text-sky-500" },
  queued: { label: "Queued", cls: "bg-amber-500/15 text-amber-500" },
  running: { label: "Running", cls: "bg-amber-500/15 text-amber-500" },
  completed: { label: "Completed", cls: "bg-emerald-500/15 text-emerald-500" },
  failed: { label: "Failed", cls: "bg-destructive/15 text-destructive" },
};

export function PmSimulationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const simId = searchParams.get("sim");
  return simId
    ? <SimDetail simId={simId} onBack={() => setSearchParams({})} />
    : <SimList onOpen={(id) => setSearchParams({ sim: id })} />;
}

// ───────────────────────────── List + create ────────────────────────────────
function SimList({ onOpen }: { onOpen: (id: string) => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", question: "", seed: "", personas: "12", rounds: "8" });
  const [creating, setCreating] = useState(false);

  const { data: sims, isLoading } = useQuery({
    queryKey: ["sims", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("sim_simulations")
        .select("id, name, seed_text, question, persona_count, total_rounds, current_round, status, report, error, created_at")
        .eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Sim[];
    },
    refetchInterval: (q) => ((q.state.data as Sim[] | undefined)?.some((s) => ["preparing", "queued", "running"].includes(s.status)) ? 3000 : false),
  });

  async function create() {
    if (!workspaceId || !projectId || !user || !form.name.trim() || !form.question.trim()) return;
    setCreating(true);
    try {
      const { data, error } = await supabase.from("sim_simulations").insert({
        workspace_id: workspaceId, project_id: projectId, created_by: user.id,
        name: form.name.trim(), question: form.question.trim(), seed_text: form.seed.trim(),
        persona_count: Math.min(Math.max(Number(form.personas) || 12, 3), 30),
        total_rounds: Math.min(Math.max(Number(form.rounds) || 8, 2), 40),
        status: "draft",
      }).select("id").single();
      if (error) { alert(error.message); return; }
      setForm({ name: "", question: "", seed: "", personas: "12", rounds: "8" });
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["sims", projectId] });
      if (data) onOpen(data.id);
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this simulation?")) return;
    await supabase.from("sim_simulations").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["sims", projectId] });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Simulations"
        description="Test an idea, product or scenario against a population of AI personas — and predict how it plays out."
        actions={<Button onClick={() => setOpen(true)}><Plus className="mr-1.5 h-4 w-4" /> New simulation</Button>}
      />

      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (sims ?? []).length === 0 ? (
        <EmptyState icon={FlaskConical} title="No simulations yet"
          description="Describe an idea or scenario, generate a crowd of AI personas, and rehearse the outcome before you commit."
          action={<Button onClick={() => setOpen(true)}><Plus className="mr-1.5 h-4 w-4" /> New simulation</Button>} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {(sims ?? []).map((s) => {
            const st = STATUS_META[s.status];
            return (
              <div key={s.id} onClick={() => onOpen(s.id)}
                className="group relative cursor-pointer rounded-xl border border-border bg-card p-4 transition-all hover:-translate-y-0.5 hover:shadow-lg">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary"><FlaskConical className="h-4 w-4" /></div>
                  <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", st.cls)}>{st.label}</span>
                </div>
                <h3 className="mt-3 truncate font-semibold">{s.name}</h3>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{s.question}</p>
                <div className="mt-3 flex items-center gap-3 border-t border-border pt-3 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" /> {s.persona_count}</span>
                  <span className="inline-flex items-center gap-1"><Play className="h-3 w-3" /> {s.current_round}/{s.total_rounds}</span>
                  <button onClick={(e) => { e.stopPropagation(); remove(s.id); }}
                    className="ml-auto opacity-0 transition-opacity group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5 text-destructive" /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">New simulation</h2>
            <div className="mt-4 space-y-3">
              <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Pricing change reaction" autoFocus /></Field>
              <Field label="What do you want to test / predict?">
                <textarea value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} rows={3}
                  placeholder="e.g. How will our users react if we move the Pro plan from €49 to €79/mo?"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              </Field>
              <Field label="Seed material (optional — report, notes, context)">
                <textarea value={form.seed} onChange={(e) => setForm({ ...form, seed: e.target.value })} rows={4}
                  placeholder="Paste any context that should shape the personas and their reactions…"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Personas (3–30)"><Input type="number" value={form.personas} onChange={(e) => setForm({ ...form, personas: e.target.value })} /></Field>
                <Field label="Rounds (2–40)"><Input type="number" value={form.rounds} onChange={(e) => setForm({ ...form, rounds: e.target.value })} /></Field>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={create} disabled={creating || !form.name.trim() || !form.question.trim()}>
                {creating && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Create
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Detail (wizard) ──────────────────────────────
function SimDetail({ simId, onBack }: { simId: string; onBack: () => void }) {
  const { projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [activePersona, setActivePersona] = useState<Persona | null>(null);

  const { data: sim } = useQuery({
    queryKey: ["sim", simId],
    queryFn: async () => {
      const { data } = await supabase.from("sim_simulations").select("*").eq("id", simId).maybeSingle();
      return data as Sim | null;
    },
    refetchInterval: (q) => (["preparing", "queued", "running"].includes((q.state.data as Sim | null)?.status ?? "") ? 2500 : false),
  });
  const { data: personas } = useQuery({
    queryKey: ["sim_personas", simId],
    queryFn: async () => {
      const { data } = await supabase.from("sim_personas").select("*").eq("simulation_id", simId).order("created_at", { ascending: true });
      return (data ?? []) as Persona[];
    },
  });
  const { data: actions } = useQuery({
    queryKey: ["sim_actions", simId],
    queryFn: async () => {
      const { data } = await supabase.from("sim_actions").select("*").eq("simulation_id", simId).order("created_at", { ascending: true }).limit(500);
      return (data ?? []) as Action[];
    },
    refetchInterval: (sim?.status === "running") ? 2500 : false,
  });

  // Realtime action feed while running.
  useEffect(() => {
    const ch = supabase.channel(`sim_actions:${simId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "sim_actions", filter: `simulation_id=eq.${simId}` },
        (payload) => queryClient.setQueryData(["sim_actions", simId], (old: Action[] | undefined) => {
          const n = payload.new as Action;
          if ((old ?? []).some((a) => a.id === n.id)) return old;
          return [...(old ?? []), n];
        }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [simId, queryClient]);

  const personaById = useMemo(() => Object.fromEntries((personas ?? []).map((p) => [p.id, p])), [personas]);

  async function generatePersonas() {
    setBusy("prepare");
    try {
      await callEdge("simulation-prepare", { action: "prepare", simulation_id: simId });
      queryClient.invalidateQueries({ queryKey: ["sim", simId] });
      queryClient.invalidateQueries({ queryKey: ["sim_personas", simId] });
    } catch (e: any) { alert(e?.message ?? "Failed"); } finally { setBusy(null); }
  }
  async function runSimulation() {
    setBusy("run");
    try {
      await supabase.from("sim_simulations").update({ status: "queued", current_round: 0, error: null }).eq("id", simId);
      await supabase.from("sim_actions").delete().eq("simulation_id", simId);
      queryClient.invalidateQueries({ queryKey: ["sim", simId] });
      queryClient.invalidateQueries({ queryKey: ["sim_actions", simId] });
    } finally { setBusy(null); }
  }

  if (!sim) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  const st = STATUS_META[sim.status];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Simulations</button>
        <span className="mx-1 h-4 w-px bg-border" />
        <h1 className="text-lg font-semibold">{sim.name}</h1>
        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", st.cls)}>{st.label}</span>
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">{sim.question}</p>
      {sim.error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{sim.error}</div>}

      {/* Step bar / actions */}
      <div className="flex flex-wrap items-center gap-2">
        {(sim.status === "draft" || sim.status === "failed") && (
          <Button onClick={generatePersonas} disabled={busy === "prepare"}>
            {busy === "prepare" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />} Generate personas
          </Button>
        )}
        {sim.status === "preparing" && <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Generating personas…</span>}
        {(sim.status === "ready" || sim.status === "completed") && (
          <Button onClick={runSimulation} disabled={busy === "run"}>
            {busy === "run" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
            {sim.status === "completed" ? "Re-run simulation" : "Run simulation"}
          </Button>
        )}
        {(sim.status === "queued" || sim.status === "running") && (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Running — round {sim.current_round}/{sim.total_rounds}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{(personas ?? []).length} personas · {sim.total_rounds} rounds</span>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* Left: report + live feed */}
        <div className="space-y-5">
          {sim.report && <ReportCard report={sim.report} />}
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><MessageSquare className="h-4 w-4 text-muted-foreground" /> Activity feed</div>
            {(actions ?? []).length === 0 ? (
              <p className="rounded-lg border border-dashed border-border py-8 text-center text-xs text-muted-foreground">
                No activity yet. Run the simulation to watch personas react in real time.
              </p>
            ) : (
              <div className="space-y-2">
                {(actions ?? []).map((a) => {
                  const p = a.persona_id ? personaById[a.persona_id] : undefined;
                  return (
                    <div key={a.id} className="flex items-start gap-2.5 rounded-lg border border-border bg-card p-2.5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-secondary text-sm">{p?.avatar_emoji ?? "🧑"}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-medium">{p?.name ?? "Persona"}</span>
                          <span className="text-muted-foreground">round {a.round}</span>
                          <SentimentDot s={a.sentiment} />
                        </div>
                        <p className="mt-0.5 text-sm text-foreground/90">{a.content}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: personas */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Users className="h-4 w-4 text-muted-foreground" /> Personas</div>
          {(personas ?? []).length === 0 ? (
            <p className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">No personas yet.</p>
          ) : (
            <div className="space-y-2">
              {(personas ?? []).map((p) => (
                <button key={p.id} onClick={() => setActivePersona(p)}
                  className="flex w-full items-start gap-2.5 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:border-foreground/30">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary text-base">{p.avatar_emoji ?? "🧑"}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{p.role}</div>
                  </div>
                  {sim.status === "completed" && <MessageSquare className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {activePersona && <PersonaChat persona={activePersona} onClose={() => setActivePersona(null)} />}
    </div>
  );
}

function SentimentDot({ s }: { s: string | null }) {
  if (s === "positive") return <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-500"><TrendingUp className="h-3 w-3" /></span>;
  if (s === "negative") return <span className="inline-flex items-center gap-0.5 text-[10px] text-destructive"><TrendingDown className="h-3 w-3" /></span>;
  return <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"><Minus className="h-3 w-3" /></span>;
}

function ReportCard({ report }: { report: any }) {
  const s = report.sentiment ?? {};
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><FileText className="h-4 w-4 text-primary" /> Prediction report</div>
      {report.summary && <p className="text-sm leading-relaxed text-foreground/90">{report.summary}</p>}
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {report.outlook && <Badge variant="outline" className="capitalize">Outlook: {report.outlook}</Badge>}
        {report.confidence && <Badge variant="outline" className="capitalize">Confidence: {report.confidence}</Badge>}
        {typeof s.total === "number" && (
          <span className="inline-flex items-center gap-2 rounded-full bg-secondary px-2 py-0.5">
            <span className="text-emerald-500">▲ {s.positive ?? 0}</span>
            <span className="text-muted-foreground">● {s.neutral ?? 0}</span>
            <span className="text-destructive">▼ {s.negative ?? 0}</span>
          </span>
        )}
      </div>
      {Array.isArray(report.key_drivers) && report.key_drivers.length > 0 && (
        <Section title="Key drivers" items={report.key_drivers} />
      )}
      {Array.isArray(report.risks) && report.risks.length > 0 && <Section title="Risks" items={report.risks} />}
      {report.recommendation && (
        <div className="mt-3 rounded-md bg-primary/5 p-3 text-sm">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-primary">Recommendation</div>
          {report.recommendation}
        </div>
      )}
    </div>
  );
}
function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <ul className="space-y-1 text-sm">
        {items.map((it, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" /><span>{it}</span></li>)}
      </ul>
    </div>
  );
}

// ───────────────────────────── Persona chat ─────────────────────────────────
function PersonaChat({ persona, onClose }: { persona: Persona; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const { data: messages } = useQuery({
    queryKey: ["sim_messages", persona.id],
    queryFn: async () => {
      const { data } = await supabase.from("sim_messages").select("id, role, content, created_at").eq("persona_id", persona.id).order("created_at", { ascending: true });
      return (data ?? []) as Array<{ id: string; role: string; content: string }>;
    },
  });
  useEffect(() => { if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight; }, [messages?.length]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    try {
      await callEdge("simulation-prepare", { action: "chat", persona_id: persona.id, message: text });
      queryClient.invalidateQueries({ queryKey: ["sim_messages", persona.id] });
    } catch (e: any) { alert(e?.message ?? "Failed"); } finally { setSending(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <aside className="flex h-full w-full max-w-md flex-col border-l border-border bg-background" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-border p-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary text-base">{persona.avatar_emoji ?? "🧑"}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{persona.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">{persona.role}</div>
          </div>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">✕</button>
        </div>
        {persona.bio && <p className="border-b border-border p-3 text-xs text-muted-foreground">{persona.bio}</p>}
        <div ref={scrollerRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {(messages ?? []).length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">Ask {persona.name} anything — they answer in character.</p>
          ) : (messages ?? []).map((m) => (
            <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm", m.role === "user" ? "rounded-tr-sm bg-primary/85 text-primary-foreground" : "rounded-tl-sm bg-secondary/60 text-foreground/90")}>
                {m.content}
              </div>
            </div>
          ))}
          {sending && <div className="flex justify-start"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}
        </div>
        <div className="border-t border-border p-3">
          <div className="flex items-end gap-2">
            <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={1}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={`Message ${persona.name}…`}
              className="max-h-32 min-h-[38px] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            <Button onClick={send} disabled={sending || !input.trim()} className="mb-0.5">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-xs font-medium text-muted-foreground">{label}</label>{children}</div>;
}
