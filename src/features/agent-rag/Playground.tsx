import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowCounterClockwiseIcon, BookOpenIcon, CheckIcon, CopyIcon, CircleNotchIcon as Loader2,
  LightningIcon, MagnifyingGlassIcon, SlidersHorizontalIcon, SparkleIcon, TimerIcon, WarningCircleIcon,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { AgentMarkdown } from "@/components/AgentMarkdown";
import { AgentChatInput } from "@/components/ui/agent-chat-input";
import { SoftField, SoftInput, SoftRange, SoftSelect, SoftTextarea } from "@/components/ui/soft-form";
import type { Agent, PublicAgentTab } from "./AgentBuilder";
import { publicAgentAvatarUrl } from "./PublicAgentHome";
import { PaCard, PaSaveBar, PaSegmented, PaStatus, fmtBytes, nf } from "./ui";

/**
 * Le playground d'un agent public : on lui parle comme un visiteur, et on
 * voit ce qu'il a lu pour répondre.
 *
 * À gauche, la conversation, dans la langue des conversations internes
 * (identité de l'agent au-dessus de sa réponse, Markdown rendu, actions sous
 * le message, composeur partagé). À droite, deux volets : les réglages qui
 * changent la réponse (modèle, température, instructions, accueil) et
 * l'inspecteur des passages retrouvés pour la réponse choisie.
 */

export const PUBLIC_AGENT_MODELS = [
  { value: "groq", label: "Groq, Llama 3.3 70B", hint: "Rapide, bon par défaut" },
  { value: "deepseek", label: "DeepSeek", hint: "Plus posé sur les questions longues" },
];

interface Chunk { similarity: number; snippet?: string; source_id?: string }
interface Product { title?: string; price?: string; url?: string; image?: string }
interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Chunk[];
  products?: Product[];
  ms?: number;
  error?: boolean;
}

type Side = "settings" | "sources";

const DEFAULT_SUGGESTIONS = [
  "Que pouvez-vous faire pour moi ?",
  "Quels sont vos horaires ?",
  "Comment vous contacter ?",
];

export function PlaygroundTab({ agent, workspaceId, projectId, onOpen }: {
  agent: Agent; workspaceId: string | null; projectId: string | null;
  onOpen?: (tab: PublicAgentTab, sub?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [convId, setConvId] = useState<string | undefined>();
  const [side, setSide] = useState<Side>("settings");
  const [inspected, setInspected] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Les réglages qui changent la réponse, modifiables sans quitter la conversation.
  const initial = useMemo(() => ({
    model: agent.model,
    temperature: agent.temperature ?? 0.3,
    instructions: agent.instructions ?? "",
    welcome_message: agent.welcome_message ?? "",
  }), [agent.model, agent.temperature, agent.instructions, agent.welcome_message]);
  const [cfg, setCfg] = useState(initial);
  useEffect(() => setCfg(initial), [initial]);
  const dirty = JSON.stringify(cfg) !== JSON.stringify(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const { data: sources } = useQuery({
    queryKey: ["rag_sources", agent.id],
    enabled: !!agent.id,
    queryFn: async () => {
      const { data } = await supabase.from("rag_sources").select("*").eq("agent_id", agent.id).order("created_at", { ascending: false });
      return (data ?? []) as Array<{ id: string; title: string; status: string; chunk_count: number; byte_size?: number; type: string }>;
    },
  });
  const titleOf = useMemo(() => new Map((sources ?? []).map((s) => [s.id, s.title])), [sources]);
  const ready = (sources ?? []).filter((s) => s.status === "ready");
  const trained = ready.length > 0;
  const chunks = ready.reduce((n, s) => n + (s.chunk_count ?? 0), 0);
  const bytes = (sources ?? []).reduce((n, s) => n + (s.byte_size ?? 0), 0);

  const suggestions = useMemo(() => {
    const raw = String((agent.widget_config as Record<string, unknown> | null)?.suggested_questions ?? "");
    const list = raw.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 4);
    return list.length ? list : DEFAULT_SUGGESTIONS;
  }, [agent.widget_config]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy || !workspaceId || !projectId) return;
    setInput("");
    setTurns((t) => [...t, { id: crypto.randomUUID(), role: "user", content: q }]);
    setBusy(true);
    const started = performance.now();
    try {
      const res = await callEdge<{ answer: string; conversation_id: string; sources: Chunk[]; products?: Product[] }>("rag-chat", {
        workspace_id: workspaceId, project_id: projectId, agent_id: agent.id, message: q, conversation_id: convId,
      });
      setConvId(res.conversation_id);
      const id = crypto.randomUUID();
      setTurns((t) => [...t, {
        id, role: "assistant", content: res.answer, sources: res.sources ?? [], products: res.products ?? [],
        ms: Math.round(performance.now() - started),
      }]);
      setInspected(id);
    } catch (e) {
      setTurns((t) => [...t, {
        id: crypto.randomUUID(), role: "assistant", error: true,
        content: e instanceof Error ? e.message : String(e),
      }]);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setTurns([]); setConvId(undefined); setInspected(null);
  }

  async function save() {
    setSaving(true); setSaved(false);
    try {
      await supabase.from("rag_agents").update({ ...cfg, updated_at: new Date().toISOString() }).eq("id", agent.id);
      await queryClient.invalidateQueries({ queryKey: ["rag_agent", agent.id] });
      setSaved(true); setTimeout(() => setSaved(false), 1600);
    } finally { setSaving(false); }
  }

  const inspectedTurn = turns.find((t) => t.id === inspected) ?? [...turns].reverse().find((t) => t.role === "assistant" && !t.error);
  const welcome = cfg.welcome_message.trim() || "Bonjour ! Que puis-je faire pour vous ?";
  const avatarUrl = publicAgentAvatarUrl(agent);

  return (
    <div className="mx-auto grid w-full max-w-[1480px] gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      {/* ── La conversation ── */}
      <section className="flex h-[calc(100vh-190px)] min-h-[560px] min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card">
        <header className="flex items-center gap-3 border-b border-border/70 px-5 py-3.5">
          <AgentIdentity url={avatarUrl} seed={agent.name} size={36} rounded="rounded-xl" state={busy ? "working" : "default"} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold tracking-tight">{agent.name}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <span className={cn("h-1.5 w-1.5 rounded-full", trained ? "bg-emerald-500" : "bg-amber-500")} />
              {trained ? `${ready.length} source${ready.length > 1 ? "s" : ""} · ${nf(chunks)} passages` : "Aucune connaissance, il répondra à l'aveugle"}
            </div>
          </div>
          <PaStatus tone="idle">Test</PaStatus>
          <button
            onClick={reset}
            disabled={!turns.length}
            title="Nouvelle conversation"
            className="flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <ArrowCounterClockwiseIcon className="h-3.5 w-3.5" /> Recommencer
          </button>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] space-y-6 px-5 py-6">
            <AssistantTurn name={agent.name} avatarUrl={avatarUrl}>
              <div className="chat-prose break-words"><AgentMarkdown content={welcome} /></div>
            </AssistantTurn>

            {turns.length === 0 && (
              <div className="flex flex-wrap gap-2 pl-8">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    disabled={busy}
                    className="rounded-full border border-border bg-background px-3.5 py-1.5 text-[13px] text-foreground/85 transition-colors hover:border-primary/40 hover:bg-primary/5"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {turns.map((t) => t.role === "user" ? (
              <div key={t.id} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[14px]">{t.content}</div>
              </div>
            ) : (
              <AssistantTurn key={t.id} name={agent.name} avatarUrl={avatarUrl}>
                {t.error ? (
                  <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/[0.06] px-3.5 py-2.5 text-[13px] text-red-700 dark:text-red-400">
                    <WarningCircleIcon className="mt-0.5 h-4 w-4 shrink-0" /> {t.content}
                  </div>
                ) : (
                  <>
                    <div className="chat-prose break-words"><AgentMarkdown content={t.content} /></div>
                    {!!t.products?.length && (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {t.products.slice(0, 4).map((p, i) => (
                          <a
                            key={i} href={p.url} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-3 rounded-xl border border-border p-2.5 transition-colors hover:bg-muted/50"
                          >
                            {p.image
                              ? <img src={p.image} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                              : <span className="h-12 w-12 shrink-0 rounded-lg bg-muted" />}
                            <span className="min-w-0">
                              <span className="line-clamp-2 text-[13px] font-medium">{p.title}</span>
                              {p.price && <span className="text-[12px] text-muted-foreground">{p.price}</span>}
                            </span>
                          </a>
                        ))}
                      </div>
                    )}
                    <TurnFooter
                      turn={t}
                      active={inspectedTurn?.id === t.id && side === "sources"}
                      onInspect={() => { setInspected(t.id); setSide("sources"); }}
                    />
                  </>
                )}
              </AssistantTurn>
            ))}

            {busy && (
              <AssistantTurn name={agent.name} avatarUrl={avatarUrl}>
                <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Il cherche dans ses connaissances…
                </div>
              </AssistantTurn>
            )}
          </div>
        </div>

        <div className="border-t border-border/70 bg-card px-4 pb-4 pt-3">
          <div className="mx-auto w-full max-w-[760px]">
            <AgentChatInput
              value={input}
              onChange={setInput}
              onSubmit={(m) => void send(m)}
              busy={busy}
              disabled={!workspaceId || !projectId}
              placeholder={`Écrivez à ${agent.name} comme le ferait un visiteur…`}
            />
          </div>
        </div>
      </section>

      {/* ── Le volet de droite ── */}
      <aside className="min-w-0 space-y-4 lg:sticky lg:self-start" style={{ top: "var(--float-offset, 16px)" }}>
        <PaSegmented
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          value={side}
          onChange={setSide}
          options={[
            { value: "settings", label: "Réglages", icon: SlidersHorizontalIcon },
            { value: "sources", label: "Sources de la réponse", icon: MagnifyingGlassIcon },
          ]}
        />

        {side === "settings" ? (
          <>
            <PaCard
              title="Entraînement"
              sub={trained ? `${ready.length}/${sources?.length ?? 0} sources · ${fmtBytes(bytes)}` : "Pas encore entraîné"}
              icon={BookOpenIcon}
              bodyClassName="pt-3"
            >
              <div className="h-2 overflow-hidden rounded-full bg-primary/15">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${sources?.length ? Math.max(4, Math.round((ready.length / sources.length) * 100)) : 0}%` }}
                />
              </div>
              {onOpen && (
                <button onClick={() => onOpen("knowledge")} className="mt-3 text-[12px] font-medium text-primary hover:underline">
                  {trained ? "Gérer les sources" : "Ajouter une première source"}
                </button>
              )}
            </PaCard>

            <PaCard title="Comportement" icon={SparkleIcon} bodyClassName="space-y-4 pt-4">
              <SoftField label="Modèle">
                <SoftSelect value={cfg.model} onChange={(v) => setCfg((c) => ({ ...c, model: v }))} options={PUBLIC_AGENT_MODELS} />
              </SoftField>
              <SoftField label={`Créativité · ${Number(cfg.temperature).toFixed(1).replace(".", ",")}`}>
                <SoftRange
                  min={0} max={1} step={0.1} value={cfg.temperature}
                  onChange={(e) => setCfg((c) => ({ ...c, temperature: Number(e.target.value) }))}
                  className="mt-2"
                />
                <div className="mt-1 flex justify-between text-[11px] text-muted-foreground"><span>Factuel</span><span>Créatif</span></div>
              </SoftField>
              <SoftField label="Message d'accueil">
                <SoftInput
                  value={cfg.welcome_message}
                  placeholder="Bonjour ! Que puis-je faire pour vous ?"
                  onChange={(e) => setCfg((c) => ({ ...c, welcome_message: e.target.value }))}
                />
              </SoftField>
              <SoftField label="Instructions">
                <SoftTextarea
                  rows={12}
                  value={cfg.instructions}
                  placeholder={"## Rôle\n- Tu réponds aux questions des visiteurs…\n## Ton\n- Court, précis, aimable"}
                  onChange={(e) => setCfg((c) => ({ ...c, instructions: e.target.value }))}
                  className="font-mono text-[12.5px] leading-relaxed"
                />
              </SoftField>
            </PaCard>
            <PaSaveBar dirty={dirty} saving={saving} saved={saved} onSave={() => void save()} onReset={() => setCfg(initial)} />
          </>
        ) : (
          <SourcesInspector turn={inspectedTurn} titleOf={titleOf} />
        )}
      </aside>
    </div>
  );
}

function AssistantTurn({ name, avatarUrl, children }: { name: string; avatarUrl: string | null; children: React.ReactNode }) {
  return (
    <div className="group">
      <div className="mb-1.5 flex items-center gap-2">
        <AgentIdentity url={avatarUrl} seed={name} size={22} rounded="rounded-md" interactive={false} />
        <span className="text-[13px] font-semibold">{name}</span>
      </div>
      <div className="pl-8">{children}</div>
    </div>
  );
}

function TurnFooter({ turn, active, onInspect }: { turn: Turn; active: boolean; onInspect: () => void }) {
  const [copied, setCopied] = useState(false);
  const n = turn.sources?.length ?? 0;
  const top = n ? Math.round(Math.max(...turn.sources!.map((s) => s.similarity ?? 0)) * 100) : 0;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
      <button
        onClick={onInspect}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors",
          active ? "border-primary/40 bg-primary/10 text-primary" : "border-border hover:bg-muted hover:text-foreground",
          n === 0 && "border-amber-500/30 text-amber-700 dark:text-amber-400",
        )}
      >
        <BookOpenIcon className="h-3.5 w-3.5" />
        {n ? `${n} passage${n > 1 ? "s" : ""} · ${top} %` : "Sans source"}
      </button>
      {turn.ms != null && (
        <span className="inline-flex items-center gap-1 px-1.5"><TimerIcon className="h-3.5 w-3.5" /> {(turn.ms / 1000).toFixed(1).replace(".", ",")} s</span>
      )}
      <button
        onClick={() => { void navigator.clipboard.writeText(turn.content); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        className="inline-flex h-7 w-7 items-center justify-center rounded-lg opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
        title="Copier"
      >
        {copied ? <CheckIcon className="h-3.5 w-3.5 text-emerald-500" /> : <CopyIcon className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function SourcesInspector({ turn, titleOf }: { turn: Turn | undefined; titleOf: Map<string, string> }) {
  if (!turn) {
    return (
      <PaCard title="Sources de la réponse" icon={MagnifyingGlassIcon}>
        <p className="text-[13px] text-muted-foreground">Posez une question : les passages que l'agent a lus pour répondre s'affichent ici, du plus proche au plus lointain.</p>
      </PaCard>
    );
  }
  const list = [...(turn.sources ?? [])].sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  return (
    <PaCard
      title="Sources de la réponse"
      sub={list.length ? `${list.length} passage${list.length > 1 ? "s" : ""} retrouvé${list.length > 1 ? "s" : ""}` : "aucun passage pertinent"}
      icon={MagnifyingGlassIcon}
      bodyClassName="pt-3"
    >
      {list.length === 0 ? (
        <div className="flex items-start gap-2 rounded-xl bg-amber-500/[0.07] p-3 text-[13px] text-muted-foreground">
          <LightningIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          Rien dans la base ne ressemblait assez à la question. Ajoutez une source qui y répond.
        </div>
      ) : (
        <ul className="space-y-2.5">
          {list.map((c, i) => {
            const pct = Math.round((c.similarity ?? 0) * 100);
            return (
              <li key={i} className="rounded-xl border border-border/70 p-3">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                    {(c.source_id && titleOf.get(c.source_id)) || `Passage ${i + 1}`}
                  </span>
                  <span className="status-mono shrink-0 text-[11px] tabular-nums text-muted-foreground">{pct} %</span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-primary/10">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(3, pct)}%` }} />
                </div>
                {c.snippet && <p className="mt-2 line-clamp-4 text-[12px] leading-relaxed text-muted-foreground">{c.snippet}…</p>}
              </li>
            );
          })}
        </ul>
      )}
    </PaCard>
  );
}
