import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChatsTeardropIcon, LightbulbIcon, SwordIcon, ScalesIcon, MagnifyingGlassIcon, CircleNotchIcon as Loader2, XIcon } from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";

// Les ÉCHANGES entre agents, tels qu'ils ont lieu : les messages A2A réels
// (internal_agent_a2a_messages), lus toutes les dix secondes. Dans la scène,
// chaque message fait se lever son auteur, qui va voir son destinataire et
// lui parle — sa vraie phrase s'affiche en bulle. Ici, le fil, et de quoi en
// lancer un : une idée soumise, un challenge, un débat. Ce sont les agents qui
// écrivent, chacun avec sa persona, ses instructions et sa mémoire d'équipe ;
// rien n'est mis en scène.

export type ExchangeKind = "message" | "idea" | "challenge" | "debate" | "review";

export interface A2AMessage {
  id: string;
  thread_id: string | null;
  from_agent: string;
  to_agent: string;
  content: string;
  created_at: string;
  status: string;
  /** 0294 : absents tant que la migration n'est pas appliquée. */
  kind?: ExchangeKind | null;
  turns_left?: number | null;
}

export function useA2AFeed(ids: string[]) {
  return useQuery({
    queryKey: ["live_a2a", ids.join(",")],
    enabled: ids.length > 0,
    refetchInterval: 10_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      const list = ids.join(",");
      const { data, error } = await supabase
        .from("internal_agent_a2a_messages")
        .select("*")
        .or(`from_agent.in.(${list}),to_agent.in.(${list})`)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(40);
      if (error) throw new Error(error.message);
      return (data ?? []) as A2AMessage[];
    },
  });
}

/** Les débats et challenges en cours : deux agents qui échangent encore,
 *  le dernier mot datant de moins de quatre minutes. */
export function activeDebates(feed: A2AMessage[] | undefined): Array<[string, string]> {
  const byThread = new Map<string, A2AMessage>();
  for (const m of feed ?? []) {
    if (!m.thread_id || (m.kind !== "debate" && m.kind !== "challenge")) continue;
    if (!byThread.has(m.thread_id)) byThread.set(m.thread_id, m);
  }
  const out: Array<[string, string]> = [];
  for (const m of byThread.values()) {
    const fresh = Date.now() - new Date(m.created_at).getTime() < 4 * 60 * 1000;
    if (fresh && (m.turns_left ?? 0) > 0) out.push([m.from_agent, m.to_agent]);
  }
  return out;
}

export const KIND_META: Record<ExchangeKind, { label: string; icon: typeof LightbulbIcon; tone: string }> = {
  message: { label: "Message", icon: ChatsTeardropIcon, tone: "text-muted-foreground" },
  idea: { label: "Idée", icon: LightbulbIcon, tone: "text-amber-500" },
  challenge: { label: "Challenge", icon: SwordIcon, tone: "text-rose-500" },
  debate: { label: "Débat", icon: ScalesIcon, tone: "text-violet-500" },
  review: { label: "Relecture", icon: MagnifyingGlassIcon, tone: "text-teal-500" },
};

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? "à l'instant" : s < 3600 ? `il y a ${Math.round(s / 60)} min` : `il y a ${Math.round(s / 3600)} h`;
};

interface LiteAgent { id: string; name: string }

/** Le tiroir des échanges : lancer, puis suivre. */
export function ExchangesPanel({ agents, feed, loading, presetFrom, onClose, onLaunched }: {
  agents: LiteAgent[];
  feed: A2AMessage[] | undefined;
  loading: boolean;
  presetFrom: string | null;
  onClose: () => void;
  onLaunched: (from: string, to: string, kind: ExchangeKind) => void;
}) {
  const qc = useQueryClient();
  const nameOf = new Map(agents.map((a) => [a.id, a.name]));
  const [from, setFrom] = useState(presetFrom ?? agents[0]?.id ?? "");
  const [to, setTo] = useState(agents.find((a) => a.id !== (presetFrom ?? agents[0]?.id))?.id ?? "");
  const [kind, setKind] = useState<Exclude<ExchangeKind, "message">>("debate");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = async () => {
    if (!from || !to || from === to || !topic.trim()) return;
    setBusy(true); setError(null);
    try {
      await callEdge("internal-agent-a2a", { action: "start_exchange", from_agent: from, to_agent: to, topic: topic.trim(), kind, turns: kind === "idea" ? 4 : 6 });
      onLaunched(from, to, kind);
      setTopic("");
      void qc.invalidateQueries({ queryKey: ["live_a2a"] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/failed to fetch|404|not found|message_id required|unauthorized/i.test(msg)
        ? "Le service d'échanges n'est pas encore déployé (fonction internal-agent-a2a et migration 0294)."
        : msg);
    } finally {
      setBusy(false);
    }
  };

  const select = "h-8 min-w-0 flex-1 rounded-lg border border-border/60 bg-background px-2 text-[12px] outline-none focus:ring-1 focus:ring-primary/50";
  return (
    <aside className="absolute bottom-3 right-3 top-16 z-10 flex w-[360px] flex-col overflow-hidden rounded-xl border border-border/60 bg-background/95 shadow-xl backdrop-blur-md">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <ChatsTeardropIcon className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 text-[13px] font-semibold">Échanges entre agents</span>
        <button type="button" onClick={onClose} aria-label="Fermer" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="shrink-0 space-y-2 border-b border-border/60 p-3">
        <div className="flex gap-1 rounded-lg bg-muted/60 p-0.5">
          {(["idea", "challenge", "debate"] as const).map((k) => {
            const M = KIND_META[k];
            return (
              <button
                key={k} type="button" onClick={() => setKind(k)}
                className={cn("flex h-7 flex-1 items-center justify-center gap-1 rounded-md text-[12px] font-medium transition-colors",
                  kind === k ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                <M.icon className={cn("h-3.5 w-3.5", M.tone)} weight="fill" /> {M.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5">
          <select className={select} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Agent qui ouvre">
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <span className="text-[11px] text-muted-foreground">{kind === "idea" ? "propose à" : "face à"}</span>
          <select className={select} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Agent qui répond">
            {agents.filter((a) => a.id !== from).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <textarea
          value={topic} onChange={(e) => setTopic(e.target.value)} rows={2} maxLength={400}
          placeholder={kind === "idea" ? "L'idée à soumettre…" : "Le sujet : « Faut-il automatiser les relances ? »"}
          className="w-full resize-none rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-muted-foreground/70 focus:ring-1 focus:ring-primary/50"
        />
        <button
          type="button" onClick={launch} disabled={busy || !topic.trim() || !to || from === to}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-primary text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {busy ? `${nameOf.get(from) ?? "L'agent"} prépare son ouverture…` : "Lancer l'échange"}
        </button>
        {error && <p className="text-[11.5px] leading-snug text-destructive">{error}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : !feed?.length ? (
          <p className="py-6 text-center text-[12px] text-muted-foreground">Aucun échange depuis trois quarts d'heure.</p>
        ) : (
          <ol className="space-y-2.5">
            {feed.map((m) => {
              const M = KIND_META[(m.kind ?? "message") as ExchangeKind] ?? KIND_META.message;
              return (
                <li key={m.id} className="rounded-lg border border-border/50 bg-muted/30 px-2.5 py-2">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <M.icon className={cn("h-3 w-3 shrink-0", M.tone)} weight="fill" />
                    <span className="truncate font-medium text-foreground">{nameOf.get(m.from_agent) ?? "Un agent"}</span>
                    <span>→</span>
                    <span className="truncate">{nameOf.get(m.to_agent) ?? "un agent"}</span>
                    <span className="ml-auto shrink-0">{ago(m.created_at)}</span>
                  </div>
                  <p className="mt-1 line-clamp-4 whitespace-pre-line text-[12px] leading-relaxed">{m.content}</p>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </aside>
  );
}
